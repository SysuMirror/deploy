import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { isOAuthConfigured } from '../config/oauth.js';
import { isPlatformAdmin } from '../services/platform-admin.js';
import {
  SsoError,
  revokeSsoSession,
  verifyPassword,
  verifySsoSession,
  type OAuthUserInfo,
  type SsoTicket,
} from '../services/oauth-client.js';
import { upsertOAuthUser, getUserById } from '../services/user.js';
import { createSession, revokeSession } from '../services/session.js';
import { checkDeveloper, devPlatformConfigured, DEV_PLATFORM_BASE_URL } from '../services/devplatform.js';
import type { User } from '../types.js';

const router = Router();

/** 静默登录限流：10 次/分钟/IP（nginx 传入的 X-Forwarded-For 首跳） */
const SSO_RATE_LIMIT = 10;
const SSO_RATE_WINDOW_MS = 60_000;
const ssoHits = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: { headers: Record<string, unknown>; ip?: string }) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  return xff.split(',')[0]?.trim() || req.ip || 'unknown';
}

function hitSsoRateLimit(ip: string): boolean {
  const now = Date.now();
  const rec = ssoHits.get(ip);
  if (!rec || rec.resetAt <= now) {
    if (ssoHits.size > 5000) ssoHits.clear();
    ssoHits.set(ip, { count: 1, resetAt: now + SSO_RATE_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > SSO_RATE_LIMIT;
}

function readSsoCookie(req: { headers: Record<string, unknown> }): string {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === 'sse_sso') {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return '';
}

function setSsoCookie(res: { append: (k: string, v: string) => void }, ticket: SsoTicket) {
  res.append(
    'Set-Cookie',
    `${ticket.cookieName}=${encodeURIComponent(ticket.session)}; Domain=${ticket.cookieDomain}; Path=/; Max-Age=${ticket.maxAge}; HttpOnly; Secure; SameSite=Lax`
  );
}

function clearSsoCookie(res: { append: (k: string, v: string) => void }) {
  res.append(
    'Set-Cookie',
    'sse_sso=; Domain=.ssemarket.cn; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'
  );
}

function mapUser(user: NonNullable<ReturnType<typeof getUserById>>) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
    oauthId: user.oauthId,
    isPlatformAdmin: isPlatformAdmin(user.id),
    isDeveloper: Boolean((user as User).isDeveloper),
  };
}

type NotDeveloper = {
  error: string;
  code: 'NOT_DEVELOPER';
  joinUrl: string;
  platformUrl: string;
};

/**
 * 登录收尾（密码登录与静默 SSO 共用）：开发者门禁 + 服务端会话签发。
 * 返回 NotDeveloper 时调用方原样回 403，不签发 token。
 */
async function issueLogin(
  profile: OAuthUserInfo
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: NotDeveloper }
> {
  const user = upsertOAuthUser(profile);
  // 登录前强制校验开发者身份：非开发者（且非平台管理员）不签发 token。
  let isDeveloper = false;
  if (devPlatformConfigured()) {
    if (isPlatformAdmin(user.id)) {
      isDeveloper = true;
    } else {
      const c = await checkDeveloper(user.oauthId || '');
      isDeveloper = Boolean(c.isDeveloper || c.isAdmin);
    }
    if (!isDeveloper && !isPlatformAdmin(user.id)) {
      return {
        ok: false,
        reason: {
          error: '仅开发者可使用部署台，请前往开发者平台申请成为开发者',
          code: 'NOT_DEVELOPER',
          joinUrl: `${DEV_PLATFORM_BASE_URL}/join`,
          platformUrl: DEV_PLATFORM_BASE_URL,
        },
      };
    }
  }
  const session = createSession(user.id, isDeveloper);
  return {
    ok: true,
    body: {
      token: session.token,
      expiresAt: session.expiresAt,
      user: { ...mapUser(user), isDeveloper },
      isDeveloper,
      profile: {
        userId: profile.sseSub || profile.sub,
        sub: profile.sub,
        name: profile.name,
        email: profile.email,
        avatarUrl: profile.avatar_url,
      },
    },
  };
}

// 邮箱+密码登录：后端持 client 凭据调 UniSSO password/verify 代验（无 OAuth 跳转），
// internal !== true 直接拒绝。成功后把 unisso 下发的共享会话 Cookie 种给浏览器。
router.post('/login', async (req, res) => {
  if (!isOAuthConfigured()) {
    res.status(503).json({ error: '登录服务未配置，请设置 UNISSO_CLIENT_ID / SECRET' });
    return;
  }
  const { email, password } = (req.body || {}) as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: '请填写邮箱和密码' });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    res.status(400).json({ error: '邮箱格式不正确' });
    return;
  }

  try {
    const { profile, sso } = await verifyPassword(email, password);
    const result = await issueLogin(profile);
    if (!result.ok) {
      res.status(403).json(result.reason);
      return;
    }
    if (sso) setSsoCookie(res, sso);
    res.json(result.body);
  } catch (e) {
    res.status(401).json({ error: e instanceof Error ? e.message : '登录失败' });
  }
});

// 静默 SSO：读共享父域 Cookie → unisso 校验 → 本地 upsert → 开发者门禁 → 签本地会话。
// 401/503 都让前端静默回落到登录表单；本端点不重新下发 SSO Cookie。
router.post('/sso/try', async (req, res) => {
  if (!isOAuthConfigured()) {
    res.status(503).json({ error: 'sso_unavailable' });
    return;
  }
  if (hitSsoRateLimit(clientIp(req))) {
    res.status(429).json({ error: 'too_many_requests' });
    return;
  }
  const session = readSsoCookie(req);
  if (!session) {
    res.status(401).json({ error: 'no_sso' });
    return;
  }

  try {
    const profile = await verifySsoSession(session);
    const result = await issueLogin(profile);
    if (!result.ok) {
      res.status(403).json(result.reason);
      return;
    }
    res.json(result.body);
  } catch (e) {
    if (e instanceof SsoError) {
      if (e.kind === 'forbidden') {
        res.status(401).json({ error: 'not_internal' });
      } else if (e.kind === 'unavailable') {
        res.status(503).json({ error: 'sso_unavailable' });
      } else {
        res.status(401).json({ error: 'invalid_sso' });
      }
      return;
    }
    res.status(503).json({ error: 'sso_unavailable' });
  }
});

router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: mapUser(req.user!) });
});

// 单点登出：撤销 unisso 会话 + 清父域 Cookie + 撤销本地会话
router.post('/logout', async (req, res) => {
  const ssoSession = readSsoCookie(req);
  if (ssoSession) await revokeSsoSession(ssoSession);
  clearSsoCookie(res);
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) revokeSession(header.slice(7).trim());
  res.json({ ok: true });
});

export default router;

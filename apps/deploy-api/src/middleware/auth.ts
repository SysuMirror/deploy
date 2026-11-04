import type { Request, Response, NextFunction } from 'express';
import { resolveSessionUser, markSessionDeveloper } from '../services/session.js';
import { isPlatformAdmin } from '../services/platform-admin.js';
import { checkDeveloper, devPlatformConfigured } from '../services/devplatform.js';
import type { User } from '../types.js';

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

function bearer(req: Request): string {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/**
 * 鉴权：token → 会话用户；再按开发者身份校验。
 * 开发者身份在「登录签发 token 时」向开发者平台确认并写入会话（is_developer）。
 * 此处以会话固化为准：is_developer=1（已确认开发者）直接放行，不打平台。
 * 对 is_developer=0 的「旧会话」（登录时可能未确认/后又恢复身份），做一次平台复核：
 *   确认是开发者 → 放行并把会话升级为 1（存量用户平滑过渡）；
 *   确认为非开发者 → 403 拦截。
 *  平台不可达时降级放行并升级（避免平台抖动误伤真实开发者）。
 * 平台管理员始终放行。
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  const user = resolveSessionUser(token);
  if (!user) {
    res.status(401).json({ error: '登录已失效，请重新登录', code: 'SESSION_INVALID' });
    return;
  }
  // 平台管理员始终放行
  if (isPlatformAdmin(user.id)) {
    req.user = user;
    next();
    return;
  }
  // 会话已确认为开发者 → 无需再打平台，直接放行（减少平台压力，也避免抖动误伤）
  if (user.isDeveloper) {
    req.user = user;
    next();
    return;
  }
  // 旧会话 / 未确认：向开发者平台复核一次，并写回会话，避免反复打平台
  try {
    if (devPlatformConfigured()) {
      const c = await checkDeveloper(user.oauthId || '');
      if (!c.isDeveloper && !c.isAdmin) {
        res.status(403).json({
          error: '仅开发者可使用部署台，请前往开发者平台申请成为开发者',
          code: 'NOT_DEVELOPER',
          joinUrl: `${process.env.DEVPLATFORM_BASE_URL || 'https://developer.ssemarket.cn'}/join`,
          platformUrl: process.env.DEVPLATFORM_BASE_URL || 'https://developer.ssemarket.cn',
        });
        return;
      }
      // 确认是开发者 → 升级会话（写回 is_developer=1），后续请求不再复核
      markSessionDeveloper(token, true);
      req.user = { ...user, isDeveloper: true };
      next();
      return;
    }
  } catch (e) {
    // 平台不可达：降级放行并升级会话，避免平台抖动误伤真实开发者
    console.warn('[auth] 开发者平台复核失败，降级放行:', e instanceof Error ? e.message : e);
    markSessionDeveloper(token, true);
    req.user = { ...user, isDeveloper: true };
    next();
    return;
  }
  // 未配置开发者平台：无法确认，按会话值（默认非开发者）拦截，但管理员已在上方放行
  res.status(403).json({
    error: '仅开发者可使用部署台，请前往开发者平台申请成为开发者',
    code: 'NOT_DEVELOPER',
    joinUrl: `${process.env.DEVPLATFORM_BASE_URL || 'https://developer.ssemarket.cn'}/join`,
    platformUrl: process.env.DEVPLATFORM_BASE_URL || 'https://developer.ssemarket.cn',
  });
}

/** 兼容内部脚本：仅读取当前用户，不校验（勿用于鉴权决策） */
export function peekUser(token: string): User | null {
  return resolveSessionUser(token) ?? null;
}

export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !isPlatformAdmin(req.user.id)) {
    res.status(403).json({ error: '需要平台管理员权限' });
    return;
  }
  next();
}

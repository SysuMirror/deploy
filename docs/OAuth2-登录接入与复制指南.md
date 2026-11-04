# OAuth2 登录接入与复制指南

> **参考实现**：sse-sdpy（SSE 部署台）
> **身份提供方**：SSE Market（`ssemarket.cn`）
> **代码位置**：`sse-sdpy/code/sse-deploy/apps/{deploy-api,deploy-web}`
> **编写日期**：2026-09-14
> **本文定位**：把 sdpy 这套「集市账号登录」讲清楚 —— 怎么做的、其他系统怎么照着抄、前置/后置条件是什么。

---

## 0. 文档定位

| 文档 | 视角 | 何时看 |
|------|------|--------|
| **本文** | **RP 落地实现**（以 sse-sdpy 为样板） | 要给某个系统接入集市登录，或排查 sdpy 登录问题 |
| `SSE_market_server/docs/OAuth2-实现与复制指南.md` | IdP 内部实现（SSE Market 服务端） | 要改 IdP 本身、查数据表、做安全评估 |
| `GIT/agent-worklog/DOC-OAuth-Auth.md` | 早期 RP 接入指南（iWiki 视角） | 历史参考 |

> 本文第 10 章保留了 IdP 侧的接口契约（接入必须知道的部分），
> 但主线是 **sdpy 怎么做**、**照着 sdpy 怎么抄**。

---

## 1. 一句话理解

sdpy **不自己维护账号密码**：用户点登录 → 跳到集市授权页 → 集市签一个一次性 `code` 回来 →
sdpy 后端拿 `code` 换用户信息 → 确认是开发者 → sdpy 签发**自己的**会话 token（`sess-…`）。
之后所有业务请求都用 sdpy 自己的 token，**集市 token 只在登录那一刻用一次**。

```
浏览器 ──授权──► 集市(IdP) ──code──► sdpy 后端 ──换userinfo──► 集市
                                        │
                                        └──签发 sess-xxx（sdpy 自己的会话）──► 浏览器
```

**核心原则**：`app_secret` 和集市的 `access_token` **永远不出现在浏览器里**，只走服务端。

---

## 2. 端到端流程（sdpy 实际实现）

### 2.1 时序

```
用户/浏览器            deploy-web              deploy-api                集市 IdP
    │                     │                       │                        │
    │ 访问受保护页面       │                       │                        │
    ├────────────────────►│ 守卫：无 token → /login                        │
    │                     │                       │                        │
    │                     ├── GET /api/auth/oauth/login-url ──────────────►│
    │                     │◄── { authorizeUrl, state } ───────────────────┤
    │  window.location = authorizeUrl                                        │
    ├──────────────────────────────────────────────────────────────────────►│
    │                     集市授权页（未登录先要求登录集市）                  │
    │  点「允许」          │                       │                        │
    │◄──────────────────────────────────────────────────────────────────────┤
    │  /oauth/callback?code=..&state=..            │                        │
    ├────────────────────►│                       │                        │
    │                     ├── POST /api/auth/oauth/token {code,state} ─────►│
    │                     │   ① 校验 state（HMAC + 一次性）                  │
    │                     │   ② 服务端换 access_token ─────────────────────►│
    │                     │◄── access_token（不下发浏览器）────────────────┤
    │                     │◄── { sessionId } ─────┤                        │
    │                     ├── POST /api/auth/oauth/userinfo {sessionId} ──►│
    │                     │   ③ 用 access_token 拉用户信息 ────────────────►│
    │                     │◄── { user_id, name, email, avatar_url, … } ───┤
    │                     │   ④ 开发者门禁 checkDeveloper(oauthId)         │
    │                     │   ⑤ 签发 sess-… 会话（落库）                    │
    │                     │◄── { token, user, isDeveloper } ──────────────┤
    │  localstorage: token + sessionStorage: user                            │
    │◄─────────────────────────────────────────────┤                        │
    │  之后：Authorization: Bearer sess-…  （不再经过集市）                    │
```

### 2.2 ① 发起登录：拿授权 URL

前端只做一件事：问后端要 URL，然后跳过去。

```startLine:53:62:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-api/src/routes/auth.ts
router.get('/oauth/login-url', (req, res) => {
  const profile = resolveOAuthProfile(req);
  if (!isOAuthConfigured(profile)) {
    res.status(503).json({ error: 'OAuth 未配置' });
    return;
  }
  const state = createOAuthState();
  const authorizeUrl = buildOAuthAuthorizeUrl(state, profile);
  res.json({ authorizeUrl, state, redirectUri: profile.redirectUri });
});
```

授权 URL 由后端拼（`appid` 和 `app_id` 同时带上，兼容 IdP 两种取参写法）：

```startLine:3:13:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-api/src/services/oauth-params.ts
export function buildOAuthAuthorizeUrl(state: string, profile: OAuthProfile): string {
  const params = new URLSearchParams({
    appid: profile.appId,
    app_id: profile.appId,
    redirect_uri: profile.redirectUri,
    response_type: 'code',
    scope: profile.scope,
    state,
  });
  return `${profile.webBaseUrl}${profile.authorizePath}?${params}`;
}
```

> ⚠️ **`redirect_uri` 必须是库里登记的精确值**，而且**必须指向前端回调路由**，不是后端 API。

### 2.3 ② 回调换取会话：token → sessionId

集市跳回 `/oauth/callback?code=..&state=..` 后，前端把 `code`/`state` 交给后端：

```startLine:64:92:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-api/src/routes/auth.ts
router.post('/oauth/token', async (req, res) => {
  const profile = resolveOAuthProfile(req);
  const { code, state } = req.body as { code?: string; state?: string };
  if (!code || !state) {
    res.status(400).json({ error: '缺少 code 或 state' });
    return;
  }
  if (!consumeOAuthState(state)) {
    res.status(400).json({ error: 'state 无效或已过期，请重新登录' });
    return;
  }
  if (!isOAuthConfigured(profile)) {
    res.status(503).json({ error: 'OAuth 未配置' });
    return;
  }

  try {
    const token = await exchangeCodeForToken(code, profile);
    const sessionId = createCallbackSession(token.access_token);
    res.json({
      sessionId,
      tokenType: token.token_type,
      expiresIn: token.expires_in,
      scope: token.scope,
    });
  } catch (e) {
    res.status(401).json({ error: e instanceof Error ? e.message : '换取 access_token 失败' });
  }
});
```

换 token 这一步是**服务端对服务端**的表单请求（IdP 用 `c.PostForm` 取参，**不能发 JSON**）：

```startLine:33:64:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-api/src/services/oauth-client.ts
export async function exchangeCodeForToken(
  code: string,
  profile: OAuthProfile
): Promise<OAuthTokenResult> {
  const body = new URLSearchParams({
    code,
    appid: profile.appId,
    app_secret: profile.appSecret,
  });
  body.set('app_id', profile.appId);

  const res = await fetch(`${profile.apiBaseUrl}/api/auth/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const json = (await res.json().catch(() => ({}))) as ApiEnvelope<OAuthTokenResult> & {
    error?: string;
    msg?: string;
  };

  if (!res.ok) {
    throw new Error(json.msg ?? json.message ?? json.error ?? `Token 交换失败 (${res.status})`);
  }

  const data = unwrap(json);
  if (!data?.access_token) {
    throw new Error('未获取到 access_token');
  }
  return data;
}
```

**注意返回给浏览器的是 `sessionId`，不是 `access_token`** —— 集市 token 被暂存后端 5 分钟（`oauth-callback-session.ts`），一次性消费。

### 2.4 ③ 拉用户信息 + 开发者门禁 + 签发本地会话

这是整个流程里最关键的一步，sdpy 在此处做了三件事：

```startLine:94:153:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-api/src/routes/auth.ts
router.post('/oauth/userinfo', async (req, res) => {
  const profile = resolveOAuthProfile(req);
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId) {
    res.status(400).json({ error: '缺少 sessionId' });
    return;
  }
  if (!isOAuthConfigured(profile)) {
    res.status(503).json({ error: 'OAuth 未配置' });
    return;
  }

  const accessToken = consumeCallbackSession(sessionId);
  if (!accessToken) {
    res.status(400).json({ error: '授权会话已过期，请重新登录' });
    return;
  }

  try {
    const oauthProfile = await fetchOAuthUserInfo(accessToken, profile);
    const user = upsertOAuthUser(oauthProfile);
    // 登录前强制校验开发者身份：非开发者（且非平台管理员）不签发 token。
    // 只有开发者平台确认通过，才标记为开发者并签发合法登录 token。
    let isDeveloper = false;
    if (devPlatformConfigured()) {
      // 平台管理员视为开发者（不会被门禁拦截，展示也保持一致）
      if (isPlatformAdmin(user.id)) {
        isDeveloper = true;
      } else {
        const c = await checkDeveloper(user.oauthId || '');
        isDeveloper = Boolean(c.isDeveloper || c.isAdmin);
      }
      if (!isDeveloper && !isPlatformAdmin(user.id)) {
        res.status(403).json({
          error: '仅开发者可使用部署台，请前往开发者平台申请成为开发者',
          code: 'NOT_DEVELOPER',
          joinUrl: `${DEV_PLATFORM_BASE_URL}/join`,
          platformUrl: DEV_PLATFORM_BASE_URL,
        });
        return;
      }
    }
    // 签发服务端会话：不再把用户 id 当 token（可被冒用，导致部署记录记错人）
    const session = createSession(user.id, isDeveloper);
    res.json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: { ...mapUser(user), isDeveloper },
      isDeveloper,
      profile: {
        userId: oauthProfile.user_id,
        name: oauthProfile.name,
        email: oauthProfile.email,
        avatarUrl: oauthProfile.avatar_url,
      },
    });
  } catch (e) {
    res.status(401).json({ error: e instanceof Error ? e.message : '获取用户信息失败' });
  }
});
```

**非开发者的处理链**：后端 403 `NOT_DEVELOPER` → 前端识别为 `NotDeveloperError` → 跳门禁页：

```startLine:24:38:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-web/src/composables/auth/useOAuthCallback.ts
    try {
      await auth.handleOAuthCallback(code, state);
      const redirect = consumeLoginRedirect() ?? '/projects';
      await router.replace(redirect);
    } catch (e) {
      if (e instanceof NotDeveloperError) {
        // 非开发者：签发 token 前已被后端拦截，引导到开发者门禁页
        await router.replace({ name: 'developer-gate' });
      } else {
        error.value = e instanceof Error ? e.message : '登录失败';
      }
    } finally {
      loading.value = false;
      clearOAuthPending();
    }
```

### 2.5 ④ 后续请求：sdpy 自己的会话

登录成功后浏览器只持有 `sess-<64位hex>`，服务端**落库、可吊销、滑动续期**：

```startLine:17:25:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-api/src/services/session.ts
export function createSession(userId: string, isDeveloper = false): { token: string; expiresAt: string } {
  if (!getUserById(userId)) throw new Error('用户不存在');
  const token = `sess-${randomBytes(32).toString('hex')}`;
  const expiresAt = expiry();
  db.prepare(
    'INSERT INTO sessions (token, user_id, is_developer, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(token, userId, isDeveloper ? 1 : 0, new Date().toISOString(), new Date().toISOString(), expiresAt);
  return { token, expiresAt };
}
```

```startLine:27:53:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-api/src/services/session.ts
/** 校验 token；命中则滑动续期。旧式 user-id token 一律不再接受。 */
export function resolveSessionUser(rawToken: string): User | null {
  const token = rawToken.trim();
  if (!token || token.startsWith('user-oauth-')) return null;
  const row = db
    .prepare(
      `SELECT s.user_id as userId, s.expires_at as expiresAt, s.is_developer as isDeveloper
       FROM sessions s WHERE s.token = ?`
    )
    .get(token) as { userId: string; expiresAt: string; isDeveloper: number } | undefined;
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const user = getUserById(row.userId);
  if (!user) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  // 滑动续期：每天最多写一次，避免每次请求都落盘
  const next = new Date(Date.now() + DEFAULT_TTL_DAYS * 86_400_000).toISOString();
  db.prepare(
    `UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token = ? AND last_seen_at < ?`
  ).run(new Date().toISOString(), next, token, new Date(Date.now() - 86_400_000).toISOString());
  return { ...user, isDeveloper: Boolean(row.isDeveloper) };
}
```

---

## 3. sdpy 的 6 个关键设计（抄的时候别丢）

### 3.1 双入口：同一套代码，按域名切回调与密钥

sdpy 有两个入口，两个都要能登录：

| 入口 | 地址 | 回调地址 |
|------|------|----------|
| 子域入口 | `https://deploy.ssemarket.cn/` | `https://deploy.ssemarket.cn/oauth/callback` |
| 路径入口 | `https://ssemarket.cn/sdpy/` | `https://ssemarket.cn/sdpy/oauth/callback` |

做法是**按请求域名解析 profile**（而不是用两套部署）：

```startLine:37:65:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-api/src/config/oauth.ts
function deployProfile(): OAuthProfile {
  return {
    ...defaultProfile,
    appSecret: process.env.OAUTH_APP_SECRET_DEPLOY?.trim() || defaultProfile.appSecret,
    redirectUri:
      process.env.OAUTH_REDIRECT_URI_DEPLOY?.trim() ||
      `https://${deployHost}/oauth/callback`,
  };
}

/** @deprecated 使用 resolveOAuthProfile(req)；保留默认（路径入口）配置 */
export const oauthConfig = defaultProfile;

export function getRequestHost(req?: Pick<Request, 'headers'>): string {
  const raw =
    req?.headers['x-forwarded-host'] ??
    req?.headers['x-original-host'] ??
    req?.headers.host ??
    '';
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first.split(',')[0]?.trim().toLowerCase().replace(/:\d+$/, '') ?? '';
}

/** 按访问域名选择 OAuth 回调与 app_secret（同 app_id，双入口） */
export function resolveOAuthProfile(req?: Pick<Request, 'headers'>): OAuthProfile {
  const host = getRequestHost(req);
  if (host === deployHost) return deployProfile();
  return defaultProfile;
}
```

> **为什么密钥也要切？** 因为在 IdP 里，**每个回调地址是一条独立登记，各有一条独立的 `app_secret`**。
> 实测生产库：

| app_id | redirect_uri | app_secret（MD5 比对） |
|--------|--------------|------------------------|
| `ssemarket-sdpy` | `https://ssemarket.cn/sdpy/oauth/callback` | `b92083…88ea` |
| `ssemarket-sdpy` | `https://deploy.ssemarket.cn/oauth/callback` | `0e07a5…d671` |
| `ssemarket-sdpy_local` | `http://localhost:5174/oauth/callback` | `acd9b9…41fb` |

**两行的 secret 不一样**。`redirect_uri` 与 `app_secret` 必须**成对匹配同一条记录**，
否则要么 `400 redirect_uri不匹配`，要么 `401 应用密钥错误`。

> `getRequestHost` 优先读 `x-forwarded-host`：经过 Nginx 反代后 `host` 可能已被改写，
> 这是双入口方案能工作的前提。

### 3.2 state：HMAC 签名 + 服务端保存 + 一次性消费

```startLine:14:44:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-api/src/services/oauth-session.ts
export function createOAuthState(): string {
  cleanup();
  const nonce = randomBytes(24).toString('hex');
  const sig = createHmac('sha256', oauthConfig.appSecret)
    .update(nonce)
    .digest('hex')
    .slice(0, 16);
  const state = nonce + sig;
  pendingStates.set(state, Date.now() + TTL_MS);
  return state;
}

export function consumeOAuthState(state: string): boolean {
  cleanup();
  if (!state || state.length < 48) return false;
  const nonce = state.slice(0, 48);
  const sig = state.slice(48);
  const expected = createHmac('sha256', oauthConfig.appSecret)
    .update(nonce)
    .digest('hex')
    .slice(0, 16);
  if (sig.length !== expected.length) return false;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  } catch {
    return false;
  }
  if (!pendingStates.has(state)) return false;
  pendingStates.delete(state);
  return true;
}
```

三道防护：**长度校验 → HMAC 常量时间比对 → 服务端存在性 + 一次性删除**（TTL 10 分钟）。
这防的是 CSRF 与授权码注入 —— IdP 侧对 `state` 只做原样回传，**校验责任完全在 RP**。

### 3.3 两步回调：集市 token 不进浏览器

`access_token` 只在后端内存里存活 5 分钟、且只能被消费一次：

```startLine:1:18:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-api/src/services/oauth-callback-session.ts
import { randomBytes } from 'crypto';

const sessions = new Map<string, { token: string; expires: number }>();
const TTL_MS = 5 * 60 * 1000;

export function createCallbackSession(accessToken: string): string {
  const sessionId = randomBytes(24).toString('hex');
  sessions.set(sessionId, { token: accessToken, expires: Date.now() + TTL_MS });
  return sessionId;
}

export function consumeCallbackSession(sessionId: string): string | null {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  sessions.delete(sessionId);
  if (entry.expires < Date.now()) return null;
  return entry.token;
}
```

代价是多一次请求（`token` → `userinfo`），换来的是**浏览器全程拿不到集市 token**。

### 3.4 本地会话取代「用 userId 当 token」

`session.ts` 的注释写明了原因：

> 此前登录直接把用户 id 当 token 用（Bearer user-oauth-xxx），任何人猜到/拿到 id 即可冒充该用户（含平台管理员），且「谁部署」会记错人。

所以 `resolveSessionUser` 里有一条硬性拒绝：

```startLine:29:30:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-api/src/services/session.ts
  const token = rawToken.trim();
  if (!token || token.startsWith('user-oauth-')) return null;
```

**抄的时候务必保留这条**：它保证历史遗留的弱 token 立即失效，不会成为后门。

### 3.5 开发者门禁：登录时拦截 + 每次请求兜底 + 抖动降级

门禁做在两层，避免单点失效：

- **登录时**（`routes/auth.ts`）：不是开发者 → 403，**不签发 token**；
- **每次请求**（`middleware/auth.ts`）：会话里 `is_developer=0` 的旧会话再复核一次。

```startLine:30:87:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-api/src/middleware/auth.ts
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
```

三个工程细节值得照抄：

1. **身份固化在会话里**（`sessions.is_developer`）—— 一个会话只打一次开发者平台，不是每个请求都打；
2. **Fail-closed 兜底** —— 即使登录时因为平台未配置而漏了门禁，中间件仍会拦住（`is_developer=0` 且无法确认 → 403）；
3. **降级放行** —— 平台抖动时放行真实开发者（用可用性换严格性，属有意取舍）。

> `checkDeveloper` 另带 60 秒进程内缓存（`services/devplatform.ts`），进一步降低平台压力。

### 3.6 前端：防「回调时被守卫抢跳登录页」

OAuth 回调是**异步**的：`code` 已经在 URL 里，但 token 还没换回来。
此时如果路由守卫只看「有没有 token」，就会把用户踢回登录页。sdpy 用 sessionStorage 打标记解决：

```startLine:1:32:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-web/src/composables/auth/oauth-guard.ts
const PENDING_KEY = 'deploy-oauth-pending';

export function markOAuthPending() {
  sessionStorage.setItem(PENDING_KEY, '1');
}

export function clearOAuthPending() {
  sessionStorage.removeItem(PENDING_KEY);
}

export function isOAuthPending() {
  return sessionStorage.getItem(PENDING_KEY) === '1';
}

export function isPublicPath(path: string) {
  return path.startsWith('/oauth/callback') || path === '/login';
}

export function hasOAuthCallbackParams(search = location.search) {
  const params = new URLSearchParams(search);
  return Boolean(params.get('code') && params.get('state'));
}

export function isOAuthCallbackLocation(pathname = location.pathname, search = location.search) {
  return pathname.startsWith('/oauth/callback') || (pathname === '/' && hasOAuthCallbackParams(search));
}

export function bootGuardOAuthCallback() {
  if (!isOAuthCallbackLocation()) return false;
  if (!isOAuthPending()) markOAuthPending();
  return true;
}
```

配合 `main.ts` 在挂载前先执行标记，以及守卫里两条规则：

```startLine:123:142:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-web/src/router/index.ts
router.beforeEach(async (to) => {
  if (to.path !== '/oauth/callback' && to.query.code && to.query.state) {
    markOAuthPending();
    return {
      path: '/oauth/callback',
      query: { code: to.query.code as string, state: to.query.state as string },
      replace: true,
    };
  }

  if (to.path === '/oauth/callback') {
    markOAuthPending();
  }

  if (isPublicPath(to.path) || to.meta.public) return true;
  if (isOAuthPending()) return true;
  if (!getToken()) {
    saveLoginRedirect(to.fullPath);
    return { name: 'login', query: { redirect: to.fullPath } };
  }
```

另外**登录前的目标页会被记住**，登录后原路返回：

```startLine:1:11:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-web/src/composables/auth/oauth-redirect.ts
const REDIRECT_KEY = 'deploy-login-redirect';

export function saveLoginRedirect(path: string) {
  sessionStorage.setItem(REDIRECT_KEY, path);
}

export function consumeLoginRedirect(): string | null {
  const path = sessionStorage.getItem(REDIRECT_KEY);
  sessionStorage.removeItem(REDIRECT_KEY);
  return path;
}
```

> **踩坑提醒**：`isOAuthPending` 的清理必须覆盖**成功与失败两条路径**，
> 而且 `logout()` 里也要清（`stores/auth.ts` 已处理），否则登出后会残留标记导致守卫误放行。

---

## 4. 文件与职责清单

照着抄就按这张表来。`deploy-api` → 后端，`deploy-web` → 前端。

### 4.1 后端（deploy-api）

| 文件 | 职责 | 移植要点 |
|------|------|----------|
| `src/config/load-env.ts` | 加载 `.env`（不覆盖已有环境变量） | 宿主已有 env 机制可跳过 |
| `src/config/oauth.ts` | 读取环境变量、**按域名解析 profile**、配置校验 | 改 `deployHost` 与默认值 |
| `src/services/oauth-params.ts` | 拼授权 URL | 原样 |
| `src/services/oauth-client.ts` | 服务端调 IdP 三个接口（token / userinfo / check） | 注意表单编码 |
| `src/services/oauth-session.ts` | `state` 生成与校验 | 单实例可原样；多副本换 Redis |
| `src/services/oauth-callback-session.ts` | 集市 token 的 5 分钟中转 | 同上 |
| `src/services/session.ts` | **本地会话签发/校验/吊销** | 保留 `user-oauth-` 拒绝逻辑 |
| `src/services/devplatform.ts` | 开发者平台客户端（SM2 验签 + 缓存） | 非必需；不用门禁可删 |
| `src/services/user.ts` | `upsertOAuthUser` 落本地用户表 | 改成本系统用户表 |
| `src/middleware/auth.ts` | Bearer → 会话用户 + 开发者门禁 | 原样 |
| `src/routes/auth.ts` | 5 个 oauth 路由（含已失效的 `/oauth/config`，见 §9.1）+ `me` / `logout` | 挂载前缀按宿主调整 |

### 4.2 前端（deploy-web）

| 文件 | 职责 |
|------|------|
| `src/composables/auth/oauth-guard.ts` | 回调识别、pending 标记、公开路径判定 |
| `src/composables/auth/oauth-redirect.ts` | 登录后回跳目标 |
| `src/composables/auth/oauth-session.ts` | 持久化：token → `localStorage`(`deploy-token`)、user → `sessionStorage`(`deploy-session-user`) |
| `src/composables/auth/useLoginFlow.ts` | 进登录页自动发起授权 |
| `src/composables/auth/useOAuthCallback.ts` | 回调处理 + 非开发者跳门禁 |
| `src/views/LoginView.vue` | 登录中转页（无按钮，自动跳） |
| `src/views/OAuthCallbackView.vue` | 回调中转页（loading / 报错重试） |
| `src/views/DeveloperGateView.vue` | 非开发者引导页 |
| `src/router/index.ts` | 守卫：code+state 兜底重定向、pending 放行、回跳记忆 |
| `src/main.ts` | 挂载前 `bootGuardOAuthCallback()` |
| `src/services/api.ts` | `getOAuthLoginUrl` / `oauthExchangeToken` / `oauthFetchUserInfo` / `getMe` / `logout` |

---

## 5. 环境变量（照抄即可）

```env
# —— SSE Market OAuth（oauth2_apps.app_id = ssemarket-sdpy）——
OAUTH_BASE_URL=https://ssemarket.cn/new          # 授权页所在前端根地址
OAUTH_API_BASE_URL=https://ssemarket.cn          # API 根地址（无 /new 后缀）
OAUTH_APP_ID=ssemarket-sdpy
OAUTH_APP_SECRET=<路径入口那条登记的 secret>
OAUTH_REDIRECT_URI=https://ssemarket.cn/sdpy/oauth/callback
OAUTH_AUTHORIZE_PATH=/connect

# —— 子域入口（同一 app_id 的第二条登记，secret 不同！）——
OAUTH_REDIRECT_URI_DEPLOY=https://deploy.ssemarket.cn/oauth/callback
OAUTH_APP_SECRET_DEPLOY=<子域入口那条登记的 secret>
OAUTH_DEPLOY_HOST=deploy.ssemarket.cn

# —— 相关配套 ——
CORS_ORIGIN=https://ssemarket.cn,https://deploy.ssemarket.cn
PLATFORM_ADMIN_OAUTH_IDS=561                     # 平台管理员（豁免开发者门禁）
SESSION_TTL_DAYS=30                              # 本地会话有效期，默认 30

# —— 开发者门禁（可选，不配则跳过门禁逻辑）——
DEVPLATFORM_BASE_URL=https://developer.ssemarket.cn
DEVPLATFORM_SLUG=deploy
MODEL_SM_SECRET=<deploy 模块私钥，64 位 hex>
```

> `OAUTH_BASE_URL` 与 `OAUTH_API_BASE_URL` 的区别很容易搞混：
> 前者带 `/new`（前端 SPA 前缀，授权页在这里），后者不带（API 根）。
> 代码里的兜底逻辑是「把 `/new` 后缀去掉」得到 API 地址。

---

## 6. 复制到另一个系统

### 6.1 前置条件（缺一不可）

| # | 前置条件 | 具体做法 | 缺失后果 |
|---|----------|----------|----------|
| 1 | **在 IdP 注册应用** | 找平台管理员在 `oauth2_apps` 增一行：`app_id` / `app_secret` / **精确** `redirect_uri` / `is_active=1` | 授权步骤直接 400 |
| 2 | **回调地址必须指向前端路由** | 如 `https://your.app/oauth/callback`（不是 `/api/...`） | 回调后白屏 / 404 |
| 3 | **每个入口一条登记** | 路径入口与子域入口各一条，`app_id` 可相同、`redirect_uri` 必不同 | 另一个入口登不上 |
| 4 | **记下每条登记各自的 secret** | 两条登记的 secret 不同，要分别配到 `OAUTH_APP_SECRET` / `OAUTH_APP_SECRET_DEPLOY` | `401 应用密钥错误` |
| 5 | **后端能出站访问 IdP** | IdP 必须 HTTPS | token 交换失败 |
| 6 | **宿主有用户表** | 能把 `user_id / name / email / avatar_url` 落库 | 无法建立本地用户 |
| 7 | **宿主有会话机制** | 建议直接抄 `sessions` 表 + 随机 token | 只能用弱 token |
| 8 | **CORS 放行前端域名** | `CORS_ORIGIN` 覆盖所有入口 | 浏览器请求被拦 |
| 9 | **反向代理传 `x-forwarded-host`** | 双入口方案依赖它 | 入口识别错、回调地址错 |
| 10 | **前端有回调路由** | `/oauth/callback` 且**不被登录守卫拦截** | 回调被踢回登录页（死循环） |

> 第 10 条是最常见的翻车点：回调页在守卫里必须算「公开路径」，或用 pending 标记放行。

### 6.2 实施步骤

```
1. IdP 侧登记应用（拿到 app_id + app_secret + 确认 redirect_uri）
2. 后端：抄 deploy-api 的 config/ + services/oauth-* + services/session + middleware/auth
3. 后端：改 user.ts 的 upsertOAuthUser 对接本系统用户表
4. 后端：挂载路由（见 6.3），配置 CORS
5. 前端：抄 4 个 composable + 2 个中转页 + 守卫改动
6. 前端：Vite base 按入口配置（路径入口用 /xxx/，子域入口用 /）
7. 配 .env，重启后端
8. 走一遍 §7 验收清单
```

### 6.3 后置条件：路由挂载

```js
// 登录相关（无需登录态）
app.use('/api/auth', authRoutes);
```

路由内部：

| 方法 | 路径 | 需要登录态 | 说明 |
|------|------|-----------|------|
| GET | `/api/auth/oauth/login-url` | ❌ | 返回授权 URL |
| POST | `/api/auth/oauth/token` | ❌ | `code` + `state` → `sessionId` |
| POST | `/api/auth/oauth/userinfo` | ❌ | `sessionId` → **签发本地 token** |
| GET | `/api/auth/me` | ✅ | 恢复会话 |
| POST | `/api/auth/logout` | ❌ | 吊销会话 |

> 前四个里前三个必须是「无需登录态」，否则用户还没登录就调不通 —— 这是与 IdP 侧
> `check`/`authorize`（需要登录态）最反直觉的差别，别混淆。

### 6.4 前端构建注意（双入口）

```ts
// vite.config.ts
const outDir = mode === 'production.deploy' ? 'dist-deploy' : 'dist';
return { base: env.VITE_BASE_PATH || '/', build: { outDir } };
```

- 路径入口（`ssemarket.cn/sdpy/`）→ `base=/sdpy/` → 产物放 `web/`
- 子域入口（`deploy.ssemarket.cn/`）→ `base=/` → 产物放 `web-deploy/`

**两个产物不能混**：把 `base=/` 的产物放到 `base=/sdpy/` 的目录，会出现「加载 `/sdpy/assets/...` 但文件在 `/assets/...`」的 404 白屏。

---

## 7. 验收清单

逐条可执行，全过才算交付。

| # | 验收项 | 操作 | 期望 |
|---|--------|------|------|
| 1 | 配置自检 | 打开登录页 | 自动跳到集市授权页，不报 503 |
| 2 | 首次授权 | 用非开发者账号登录 | 跳开发者门禁页，**不签发 token** |
| 3 | 开发者登录 | 用开发者账号登录（或直接点登录） | 进入 `/projects`，浏览器有 `sess-…` |
| 4 | 会话恢复 | 刷新页面 | 不掉登录，用户信息一致 |
| 5 | 回跳记忆 | 直接访问 `/projects/xxx` → 登录 | 登录后回到该页而非首页 |
| 6 | 登出 | 点登出 | 回到登录页，且**不再自动跳转**（`sess-` 已吊销） |
| 7 | 登出后残留 | 登出再登录一次 | 正常（pending 标记已被清理） |
| 8 | 双入口 | 分别从 `deploy.ssemarket.cn` 和 `ssemarket.cn/sdpy/` 登录 | 都能成功，回调地址各自正确 |
| 9 | state 防重放 | 同一 URL 再点一次回调 | `state 无效或已过期` |
| 10 | state 防伪造 | 手工改 `state` 后请求 | `state 无效或已过期` |
| 11 | token 不进浏览器 | 查浏览器 storage / 网络面板 | 只有 `sess-…`，无 IdP token |
| 12 | 越权兜底 | 手工把 `sessions.is_developer` 置 0 后请求业务接口 | 403 `NOT_DEVELOPER`（管理员除外） |
| 13 | 多副本一致性 | 多实例部署后走一遍登录 | 若失败，说明 state 需迁 Redis（见 §9.3） |

---

## 8. 排错对照表

| 现象 | 原因 | 处理 |
|------|------|------|
| 登录页 503 `OAuth 未配置` | `OAUTH_APP_ID` / `OAUTH_APP_SECRET` 为空 | 检查 env 与 `load-env` 是否读到 |
| `400 state 无效或已过期` | 回调超过 10 分钟；或 state 被重放；或**多副本部署**导致内存态不匹配 | 重新登录；扩容前把 state 迁 Redis |
| `400 授权码已过期` | 用户在授权页停留过久（code 只有 5 分钟） | 重新登录 |
| `404 授权码不存在或已使用` | code 被二次消费 | 重新登录 |
| `400 redirect_uri不匹配` | 回调地址与登记值不逐字符相同；或走错入口导致 profile 选错 | 核对库里对应行的 `redirect_uri`；检查 `x-forwarded-host` |
| `401 应用密钥错误` | secret 与当前入口那条登记不匹配 | 核对两条登记的 secret 分别配对 |
| `403 NOT_DEVELOPER` 循环跳门禁 | 开发者平台查不到该 `oauthId` | 去开发者平台申请 / 找管理员加白名单 |
| 回调后一直在登录页打转 | 回调路由被守卫拦截，或 pending 标记未置上 | 检查 `isPublicPath` 与 `bootGuardOAuthCallback` |
| 回调后白屏 404 | 回调地址登记成了后端 API | 改成前端路由地址 |
| 白屏且资源 404（`/sdpy/assets/…`） | 构建 base 与部署目录不匹配 | 见 §6.4 |
| 登出后仍处于登录态 | 前端未清 token，或后端未吊销会话 | 检查 `logout()` 是否调了 `revokeSession` |
| `无法连接 OAuth 服务`（502） | IdP 不可达 / IdP 返回非 2xx | 看后端日志里透出的 IdP 原始 `msg` |

> 排查手段：`deploy-api` 日志会透出 IdP 的 `msg`（`oauth-client.ts` 里做了透传），
> 结合 IdP 侧 `docker logs server 2>&1 | grep connect` 可以快速定位是**没到 IdP** 还是**被 IdP 拒绝**。

---

## 9. 已知问题与改造建议

以下均为 2026-09-14 实测确认，不是推测。

### 9.1 🟠 sdpy 的 `/api/auth/oauth/config` 恒返回 502（死接口）

**现象**（实测）：

```bash
$ curl -s -w '\n%{http_code}\n' https://deploy.ssemarket.cn/api/auth/oauth/config
{"error":"权限不足"}
502
```

**双重原因**：

1. 该路由内部调 IdP 的 `/api/auth/connect/check`，而**这个 IdP 接口需要用户登录态**（挂在 `auth` 分组）；
   sdpy 是服务端直调、不带 `Authorization` → IdP 返回 `401 权限不足`。
2. 顺带一提，`checkOAuthApp` 发送的字段是 `appid`，而 IdP 绑定的是 `app_id`：

```startLine:96:112:SSE_Market/sse-sdpy/code/sse-deploy/apps/deploy-api/src/services/oauth-client.ts
export async function checkOAuthApp(profile: OAuthProfile) {
  const res = await fetch(`${profile.apiBaseUrl}/api/auth/connect/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appid: profile.appId }),
  });
  const json = (await res.json().catch(() => ({}))) as ApiEnvelope<{
    app_id: string;
    app_name: string;
    app_icon?: string;
    description?: string;
  }>;
  if (!res.ok) {
    throw new Error((json as { msg?: string }).msg ?? 'OAuth 应用校验失败');
  }
  return unwrap(json);
}
```

**影响**：**登录主流程不受影响**（`login-url` → `token` → `userinfo` 不经过 check），
前端 `getOAuthConfig()` 也**没有任何调用点**。属于遗留死接口。

**建议**（三选一）：
- 直接删掉该路由与 `checkOAuthApp`（最省事）；
- 改为本地展示（用 env 里的应用名，不打 IdP）；
- 若确实要校验应用，需给 IdP 的 `check` 传递用户 token —— 但那要等用户登录后，意义不大。

### 9.2 🟡 `state` 与回调会话是**进程内内存**

`pendingStates`、`sessions`（callback）都是 `Map`。当前 sdpy 单实例部署，功能正常；
**一旦多副本 + 负载均衡**，会出现「A 实例发的 state，B 实例校验失败」→ 登录随机失败（§7 验收项 13）。

**建议**：扩容前把这两处迁到 Redis（或数据库表），key 带 TTL。这是上线水平扩展的**硬前置**。

### 9.3 🟡 开发者平台不可达时降级放行

`middleware/auth.ts` 的 catch 分支会**放行并升级会话**。这是有意的可用性取舍，
但意味着：**平台长时间不可达期间，非开发者也可能拿到访问权限**（仅限已登录会话）。
当前 sdpy 是内部部署台，可接受；若未来承载更敏感资源，建议改为「超时短暂放行 + 告警」。

### 9.4 🟡 IdP 侧的高危问题：OAuth2 token 可越权

IdP 的 `auth` 组中间件**不校验 token 类型**，一个只有 `read_basic` 权限的集市 `access_token`，
在 5 分钟内可当完整用户会话调用集市所有需登录接口（已实测复现，详见
`SSE_market_server/docs/OAuth2-实现与复制指南.md` §5.1）。

**对 sdpy 的影响**：几乎没有 —— 因为 sdpy 只把集市 token 用于一次 `userinfo` 调用，
业务鉴权完全走自己的 `sess-` 会话。**这恰好是 sdpy 设计正确的证明**：
「IdP 只用于证明用户身份，业务鉴权必须自建」，不要图省事直接拿 IdP token 当业务凭证。

### 9.5 🟡 会话 token 存在 `localStorage`

`deploy-token` 放在 `localStorage`（`services/api.ts`），任何 XSS 都能读到并长期冒用（30 天）。
这是 SPA 的常见取舍（省去 CSRF 防护），但**如果将来要加固**：

- 换成 `httpOnly` + `SameSite` Cookie（需补 CSRF token）；
- 或至少缩短 `SESSION_TTL_DAYS`，并对敏感操作（删项目、改管理员）做二次校验。

### 9.6 🟢 集市 token 5 分钟、无 refresh —— 符合设计

`expires_in=300` 且 IdP 无刷新机制。sdpy 只消费一次即丢弃，**不应**长期持有或缓存集市 token。

---

## 10. 附录：IdP 侧接口契约（接入必须知道的部分）

### 10.1 五个端点与鉴权要求

| 端点 | IdP 侧鉴权 | 谁调用 | 说明 |
|------|-----------|--------|------|
| `POST /api/auth/connect/check` | **需用户登录态** | 授权页 | 校验应用，返回 app_name/icon |
| `POST /api/auth/connect/authorize` | **需用户登录态** | 授权页 | 用户点「允许」→ 签发 code |
| `POST /api/auth/connect/token` | `app_secret`（**表单**） | RP 后端 | code 换 access_token |
| `POST /api/auth/connect/userinfo` | OAuth2 token | RP 后端 | 按 scope 返回用户信息 |
| `GET /api/auth/connect/records` | 需用户登录态 | 用户本人 | 查自己的授权记录 |

### 10.2 授权页 query 契约

```
https://ssemarket.cn/new/connect?appid=<app_id>&redirect_uri=<精确回调>&response_type=code&scope=read_basic&state=<随机串>
```

- 授权页读的是 **`appid`**（`ConnectView.vue`），所以 sdpy 两个都带（`appid` + `app_id`）；
- `response_type` 固定 `code`；`scope` 固定 `read_basic`（当前 IdP 只实现了这一个）；
- `redirect_uri` **精确匹配**，末尾斜杠/协议头都不能差。

### 10.3 错误对照

| IdP 返回 | 含义 |
|----------|------|
| `400 不支持的response_type` | 不是 `code` |
| `400 不支持的scope` | 不是 `read_basic` |
| `400 redirect_uri不匹配` | app_id 与 redirect_uri 组合查不到 |
| `400 授权码已过期` | code 超 5 分钟 |
| `400 缺少必要参数` | token 接口发了 JSON（必须表单）或参数名错 |
| `404 应用不存在或未启用` | `app_id` 不存在或 `is_active=0` |
| `404 授权码不存在或已使用` | code 被重放 |
| `401 应用密钥错误` | `app_secret` 与当前入口登记不匹配 |
| `401 OAuth2 token无效或已过期` | 超 5 分钟 |
| `403 权限不足` | 用了 `userinfo` 以外的 scope |

### 10.4 注册应用的管理接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/auth/admin/oauth/apps` | 列出应用（secret 已遮蔽） |
| POST | `/api/auth/admin/oauth/apps` | 新建（**返回的 secret 只显示一次**） |
| PUT | `/api/auth/admin/oauth/apps/:appId` | 修改（可重置 secret） |
| DELETE | `/api/auth/admin/oauth/apps/:appId` | 删除 |
| GET | `/api/auth/admin/oauth/records` | 授权记录 |

> 管理接口需要**管理员 token**（与用户 token 隔离）。
> 停用应用只需把 `is_active` 置 0，授权与校验会立即失效。

---

## 11. 关键代码索引

### sdpy（参考实现）

| 内容 | 位置 |
|------|------|
| 登录路由 | `sse-sdpy/code/sse-deploy/apps/deploy-api/src/routes/auth.ts:53-163` |
| 双入口 profile | `.../deploy-api/src/config/oauth.ts:36-70` |
| 授权 URL 构造 | `.../deploy-api/src/services/oauth-params.ts` |
| IdP 客户端 | `.../deploy-api/src/services/oauth-client.ts:33-112` |
| state 生成/校验 | `.../deploy-api/src/services/oauth-session.ts:14-44` |
| 回调会话中转 | `.../deploy-api/src/services/oauth-callback-session.ts` |
| 本地会话 | `.../deploy-api/src/services/session.ts:17-66` |
| 鉴权 + 门禁 | `.../deploy-api/src/middleware/auth.ts:30-87` |
| 开发者平台客户端 | `.../deploy-api/src/services/devplatform.ts:151-159` |
| 前端守卫工具 | `.../deploy-web/src/composables/auth/oauth-guard.ts` |
| 前端回调处理 | `.../deploy-web/src/composables/auth/useOAuthCallback.ts` |
| 前端会话持久化 | `.../deploy-web/src/composables/auth/oauth-session.ts` |
| 前端路由守卫 | `.../deploy-web/src/router/index.ts:123-161` |
| 回调中转页 | `.../deploy-web/src/views/OAuthCallbackView.vue` |

### IdP（SSE Market）

| 内容 | 位置 |
|------|------|
| 路由注册 | `SSE_market_server/route/routes.go:32-39`、`:219-223` |
| 5 个 handler | `SSE_market_server/controller/userController.go:326 / 351 / 398 / 430 / 468` |
| OAuth 中间件 | `SSE_market_server/middleware/oauthMiddleware.go` |
| 业务规则 | `SSE_market_server/service/user_service.go:458-560` |
| 表模型 | `SSE_market_server/model/oauth2app.go` |
| 授权页（生产） | `sse_market_new_client/newSSE/src/views/ConnectView.vue` |

---

## 修订记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-09-14 | v1.0 | 首版：以 sse-sdpy 为参考实现的接入与复制指南 |

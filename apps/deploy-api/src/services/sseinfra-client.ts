/**
 * sseinfra (student-platform) JSON API 客户端（2026-09 面板 SPA 重构后）。
 *
 * 认证：POST /api/auth/login（JSON）→ Flask session cookie。/api/* 路径豁免
 * CSRF（app.py csrf_protect 对 /api/ 直接放行），cookie 即可完成全部调用。
 *
 * 组（旧「group」）在 API 层叫 pod：/api/pods/…（注意列表路径必须带尾斜杠，
 * 否则 Flask 308 重定向到 /api/pods/）。
 *
 * Web 地址 / SSH 端口：新面板 API 不暴露 nodeport。经宿主机 frps JSON API
 * （/api/proxy/tcp）解析 grp-<组名>-web 的 remotePort（=13000+idx）推出 idx，
 * Web 地址 = https://ssemarket.cn:{23000+idx}（与旧面板 group.html 显示规则一致），
 * SSH = ssh -p {22000+idx} <user>@ssemarket.cn。
 */
import { getSseinfraRuntimeConfig } from './sseinfra-settings.js';

export type SseinfraGroupInfo = {
  exists: boolean;
  running: boolean;
  webUrl: string;
  sshHint: string;
  deployIds: string[];
};

export type SseinfraDeployStatus = {
  state: string;
  raw: string;
  pill?: string;
};

export type SseinfraStorageKey = {
  label: string;
  bucket: string;
  accessKey: string;
  secret: string;
  perm?: string;
};

type FrpsProxy = { web?: number; ssh?: number };

function cfg() {
  const c = getSseinfraRuntimeConfig();
  return {
    base: c.baseUrl,
    username: c.username,
    password: c.password,
    prefix: c.groupPrefix,
    defaultCpu: c.defaultCpu,
    defaultMem: c.defaultMem,
    defaultStorage: c.defaultStorage,
    platformToken: c.giteeToken,
  };
}

export function isSseinfraRuntime(): boolean {
  const v = (process.env.DEPLOY_RUNTIME || 'sseinfra').toLowerCase();
  return v === 'sseinfra' || v === 'infra' || v === 'k8s';
}

export function sseinfraGroupName(moduleName: string, env: string): string {
  const { prefix } = cfg();
  const safe = moduleName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  // sseinfra 组名限制偏严：字母开头；test/prod 用短后缀
  const suffix = env === 'test' ? 't' : 'p';
  return `${prefix}-${safe}-${suffix}`.slice(0, 40);
}

/** frps dashboard（宿主机）：用于把组名解析成公网 Web/SSH 端口 */
function frpsCfg() {
  return {
    url: (process.env.SSEINFRA_FRPS_URL || 'http://172.17.0.1:7501').replace(/\/$/, ''),
    user: process.env.SSEINFRA_FRPS_USER || 'admin',
    pass: process.env.SSEINFRA_FRPS_PASS || 'SSE_Market',
    webPublicBase: Number(process.env.SSEINFRA_WEB_PUBLIC_BASE || 23000),
    webFrpBase: Number(process.env.SSEINFRA_WEB_FRP_BASE || 13000),
    sshFrpBase: Number(process.env.SSEINFRA_SSH_FRP_BASE || 22000),
    sshHost: process.env.SSEINFRA_SSH_HOST || getSseinfraRuntimeConfig().sshHost || 'ssemarket.cn',
    sshUser: getSseinfraRuntimeConfig().sshUser || 'cloud',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 面板 groups.set_env 每写一个键都会 `kubectl rollout restart`，两次重启落在同一秒
 *  会被 K8s 判冲突（"restart has already been triggered within the past second"）→ HTTP 400；
 *  且面板在该异常分支不会 save_state，变量会丢。故写入必须彼此间隔 >1s。 */
function envWriteGapMs(): number {
  const raw = (process.env.SSEINFRA_ENV_WRITE_GAP_MS || '').trim();
  if (!raw) return 1200;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1200;
}

/** 每个键的最大写入尝试次数（仅对 rollout 冲突重试，其它错误立即失败） */
function envWriteAttempts(): number {
  const raw = (process.env.SSEINFRA_ENV_WRITE_RETRY || '').trim();
  if (!raw) return 4;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
}

/** 是否属于「rollout restart 同秒冲突」，这类错误错开一秒重试即可成功 */
function isRestartConflict(msg: string): boolean {
  return /already been triggered within the past second|failed to create patch|the object has been modified/i.test(
    msg
  );
}

/** 每个组的最后一次 env 写入时刻：保证任意两次实际写入（含跨 setEnv 调用）间隔 >1s */
const lastEnvWriteAt = new Map<string, number>();

/** 等到距上次实际写入已过 gap（不足则 sleep） */
async function waitEnvWriteSlot(group: string): Promise<void> {
  const wait = (lastEnvWriteAt.get(group) ?? 0) + envWriteGapMs() - Date.now();
  if (wait > 0) await sleep(wait);
}

/** 记录本次写入时刻（在请求发出后调用，覆盖请求耗时） */
function markEnvWrite(group: string): void {
  lastEnvWriteAt.set(group, Date.now());
}

/** API 错误：{"error":{"code","message"}} 或 {"error": "..."} */
function apiErrorMessage(data: unknown, status: number): string {
  const e = (data as { error?: unknown })?.error;
  if (typeof e === 'string')
    return e;
  return (e as { message?: string })?.message || `HTTP ${status}`;
}

type ApiResult = {
  status: number;
  headers: Headers;
  text: string;
  data: any;
};

function parseSetCookie(headers: Headers, jar: Map<string, string>): void {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const list = raw.length ? raw : [headers.get('set-cookie')].filter(Boolean) as string[];
  for (const line of list) {
    const part = line.split(';')[0];
    const eq = part.indexOf('=');
    if (eq > 0)
      jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

export class SseinfraClient {
  private jar = new Map<string, string>();
  base: string;
  username: string;
  password: string;
  /** frps 代理名 → {webPort, sshPort}，60s 缓存 */
  private _frpsMap: Map<string, FrpsProxy> | null = null;
  private _frpsMapAt = 0;

  constructor(opts?: { baseUrl?: string; username?: string; password?: string }) {
    const c = cfg();
    this.base = (opts?.baseUrl || c.base).replace(/\/$/, '');
    this.username = opts?.username || c.username;
    this.password = opts?.password || c.password;
  }

  async request(path: string, init: { method?: string; json?: unknown; body?: string; headers?: HeadersInit } = {}): Promise<ApiResult> {
    const headers = new Headers(init.headers as HeadersInit | undefined);
    const cookie = cookieHeader(this.jar);
    if (cookie)
      headers.set('cookie', cookie);
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
    }
    const res = await fetch(`${this.base}${path}`, {
      method: init.method || (init.json !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      redirect: 'manual',
    });
    parseSetCookie(res.headers, this.jar);
    const text = await res.text();
    // 手动跟一次同源重定向（如漏尾斜杠的 308），保持 cookie
    if ([301, 302, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (loc) {
        const u = new URL(loc, this.base);
        return this.request(u.pathname + u.search, {
          method: init.method === 'POST' ? 'POST' : 'GET',
          json: init.json,
        });
      }
    }
    let data: any = null;
    try {
      data = JSON.parse(text);
    }
    catch {
      /* 非 JSON（异常页/空） */
    }
    return { status: res.status, headers: res.headers, text, data };
  }

  async login(): Promise<void> {
    if (!this.username) {
      throw new Error('未配置 sseinfra 面板账号：请在管理台填写，或设置 SSEINFRA_USERNAME / k8s_username');
    }
    if (!this.password) {
      throw new Error('未配置 sseinfra 面板密码：请在管理台填写，或设置 SSEINFRA_PASSWORD / k8s_password');
    }
    // 每次登录清空旧 session，避免沿用过期 cookie
    this.jar.clear();
    const res = await this.request('/api/auth/login', {
      method: 'POST',
      json: { username: this.username, password: this.password },
    });
    if (res.status === 401) {
      throw new Error('sseinfra 登录失败：用户名或密码错误（面板有 5 次失败锁定 5 分钟）');
    }
    if (res.status === 403) {
      throw new Error('sseinfra 登录失败：尝试过多被锁定，请 5 分钟后再试');
    }
    if (res.status !== 200 || !res.data?.is_logged_in) {
      throw new Error(`sseinfra 登录失败（HTTP ${res.status}）: ${apiErrorMessage(res.data, res.status)}`);
    }
  }

  /** 写操作前重登：面板 session 偶发过期，改状态前都强制新会话 */
  async beforeWrite(): Promise<void> {
    await this.login();
  }

  /** 401 时重登一次并重试（session 过期兜底） */
  private async authedRequest(path: string, init: { method?: string; json?: unknown; body?: string; headers?: HeadersInit } = {}): Promise<ApiResult> {
    let res = await this.request(path, init);
    if (res.status === 401) {
      await this.login();
      res = await this.request(path, init);
    }
    return res;
  }

  /** 仪表盘 pod 列表 */
  async listGroups(): Promise<string[]> {
    const res = await this.authedRequest('/api/pods/?per_page=100');
    if (res.status !== 200) {
      throw new Error(`获取组列表失败（HTTP ${res.status}）: ${apiErrorMessage(res.data, res.status)}`);
    }
    return (res.data?.pods || []).map((p: { name: string }) => String(p.name).toLowerCase());
  }

  /**
   * frps 代理表：grp-<组名>-web → remotePort(13000+idx)。
   * 失败时返回空表（webUrl 置空，调用方按原逻辑报「未能解析组 frp Web 地址」）。
   */
  private async frpsProxyMap(): Promise<Map<string, FrpsProxy>> {
    const f = frpsCfg();
    if (this._frpsMap && Date.now() - this._frpsMapAt < 60_000)
      return this._frpsMap;
    const map = new Map<string, FrpsProxy>();
    try {
      const auth = 'Basic ' + Buffer.from(`${f.user}:${f.pass}`).toString('base64');
      const res = await fetch(`${f.url}/api/proxy/tcp`, {
        headers: { authorization: auth },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        for (const p of data?.proxies || []) {
          const m = String(p?.name || '').match(/^grp-(.+)-(web|ssh)$/);
          if (!m)
            continue;
          const port = Number(p?.conf?.remotePort) || 0;
          if (!port)
            continue;
          const rec = map.get(m[1]) || {};
          rec[m[2] as 'web' | 'ssh'] = port;
          map.set(m[1], rec);
        }
      }
    }
    catch {
      /* frps 不可达：留空表 */
    }
    this._frpsMap = map;
    this._frpsMapAt = Date.now();
    return map;
  }

  async getGroup(name: string): Promise<SseinfraGroupInfo> {
    const empty: SseinfraGroupInfo = { exists: false, running: false, webUrl: '', sshHint: '', deployIds: [] };
    const res = await this.authedRequest(`/api/pods/${encodeURIComponent(name)}`);
    if (res.status === 404 || res.data?.error?.code === 'NOT_FOUND')
      return empty;
    if (res.status === 403 || res.data?.error?.code === 'FORBIDDEN')
      return empty;
    if (res.status !== 200 || !res.data?.name) {
      throw new Error(`获取组 ${name} 失败（HTTP ${res.status}）: ${apiErrorMessage(res.data, res.status)}`);
    }
    const pod = res.data;
    const running = pod.status === 'Running' ||
      (pod.lifecycle?.ok && Number(pod.lifecycle?.readyReplicas) > 0);
    // frp 代理按原名匹配；个别历史组名带 grp- 前缀差异时再按原名兜底
    const f = frpsCfg();
    const proxies = await this.frpsProxyMap();
    const frp = proxies.get(name) || proxies.get(name.replace(/^grp-/, ''));
    let webUrl = '';
    let sshHint = '';
    if (frp?.web) {
      const idx = frp.web - f.webFrpBase;
      if (idx > 0)
        webUrl = `https://${f.sshHost}:${f.webPublicBase + idx}`;
    }
    if (frp?.ssh) {
      sshHint = `ssh -p ${frp.ssh} ${f.sshUser}@${f.sshHost}`;
    }
    const deployIds = (pod.deploys || []).map((d: { id: string }) => String(d.id)).filter(Boolean);
    return { exists: true, running, webUrl, sshHint, deployIds };
  }

  async ensureGroup(name: string, opts?: { cpu?: string; mem?: string; storage?: string }): Promise<SseinfraGroupInfo> {
    const c = cfg();
    await this.beforeWrite();
    let info = await this.getGroup(name);
    if (info.exists)
      return info;
    const res = await this.request('/api/pods/', {
      method: 'POST',
      json: {
        name,
        cpu: opts?.cpu || c.defaultCpu,
        mem: opts?.mem || c.defaultMem,
        storage: opts?.storage || c.defaultStorage,
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`创建 sseinfra 组 ${name} 被拒绝（HTTP ${res.status}）: ${apiErrorMessage(res.data, res.status)}；请确认面板账号有建组权限/配额`);
    }
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`创建 sseinfra 组 ${name} 失败（HTTP ${res.status}）: ${apiErrorMessage(res.data, res.status)}`);
    }
    // 等待组在列表可见（最长约 90s）
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      info = await this.getGroup(name);
      const names = await this.listGroups();
      if (info.exists && names.includes(name.toLowerCase()))
        return info;
    }
    throw new Error(`创建 sseinfra 组 ${name} 超时：面板已受理但组未出现在列表，请打开面板确认`);
  }

  /** 删除组（释放 Pod / PVC / frp 端口）。组不存在则跳过。 */
  async deleteGroup(name: string): Promise<{ deleted: boolean }> {
    await this.beforeWrite();
    const info = await this.getGroup(name);
    if (!info.exists)
      return { deleted: false };
    const res = await this.request(`/api/pods/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (res.status !== 200 && res.status !== 404) {
      throw new Error(`删除 sseinfra 组 ${name} 失败（HTTP ${res.status}）: ${apiErrorMessage(res.data, res.status)}`);
    }
    // 短轮询；面板删除为异步，超时也视为已提交
    for (let i = 0; i < 5; i++) {
      await sleep(1500);
      const after = await this.getGroup(name);
      if (!after.exists)
        return { deleted: true };
    }
    return { deleted: true };
  }

  async waitRunning(name: string, timeoutMs = 180_000): Promise<SseinfraGroupInfo> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const info = await this.getGroup(name);
      if (info.exists && info.running)
        return info;
      await sleep(3000);
    }
    throw new Error(`等待组 ${name} Running 超时`);
  }

  async addDeploy(group: string, spec: { repo?: string; name?: string; branch?: string; subdir?: string; token?: string; mode?: string }): Promise<string> {
    await this.beforeWrite();
    const res = await this.request(`/api/pods/${encodeURIComponent(group)}/deploys`, {
      method: 'POST',
      json: {
        repo: spec.repo,
        name: spec.name || '',
        branch: spec.branch || '',
        subdir: spec.subdir || '',
        token: spec.token || '',
        mode: spec.mode || 'service',
      },
    });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`添加部署失败（HTTP ${res.status}）: ${apiErrorMessage(res.data, res.status)}`);
    }
    return String(res.data?.id || '');
  }

  async runDeploy(group: string, did: string): Promise<void> {
    await this.beforeWrite();
    const res = await this.request(`/api/pods/${encodeURIComponent(group)}/deploys/${encodeURIComponent(did)}/run`, { method: 'POST' });
    if (res.status !== 200) {
      throw new Error(`触发部署失败（HTTP ${res.status}）: ${apiErrorMessage(res.data, res.status)}`);
    }
  }

  async stopDeploy(group: string, did: string): Promise<void> {
    await this.beforeWrite();
    const res = await this.request(`/api/pods/${encodeURIComponent(group)}/deploys/${encodeURIComponent(did)}/stop`, { method: 'POST' });
    if (res.status !== 200) {
      throw new Error(`停止部署失败（HTTP ${res.status}）: ${apiErrorMessage(res.data, res.status)}`);
    }
  }

  async setEnv(group: string, key: string, value: string): Promise<void> {
    await this.setEnvMany(group, { [key]: value });
  }

  /**
   * 批量写环境变量：只重新登录一次，再逐个 POST（避免每个 key 都重登）。
   *
   * 面板每次写 env 都会触发 `kubectl rollout restart`，同秒内第二次会被 K8s 拒绝
   * （HTTP 400 "already been triggered within the past second"），且面板该分支不 save_state
   * 会导致变量丢失。因此：写入彼此节流 >1s，并对冲突做退避重试。
   */
  async setEnvMany(group: string, vars: Record<string, string>): Promise<void> {
    const entries = Object.entries(vars).filter(([k]) => Boolean(k));
    if (!entries.length)
      return;
    await this.beforeWrite();
    for (const [key, value] of entries) {
      let lastErr = '';
      const maxAttempts = envWriteAttempts();
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // 每次实际写入前都保证与上次写入间隔 >1s（面板每次写入都会 restart 一次）
        await waitEnvWriteSlot(group);
        let res: ApiResult;
        try {
          res = await this.authedRequest(`/api/pods/${encodeURIComponent(group)}/env`, {
            method: 'POST',
            json: { key, value },
          });
        } finally {
          markEnvWrite(group);
        }
        if (res.status === 200) {
          lastErr = '';
          break;
        }
        const msg = apiErrorMessage(res.data, res.status);
        lastErr = `HTTP ${res.status}: ${msg}`;
        // 仅对 rollout 冲突重试；其余错误（权限/参数）立即失败
        if (!isRestartConflict(msg) || attempt === maxAttempts) break;
        console.warn(
          `[sseinfra] 写环境变量 ${key} 命中 rollout 冲突，间隔后重试（${attempt}/${maxAttempts - 1}）`
        );
      }
      if (lastErr) {
        throw new Error(`写环境变量 ${key} 失败（${lastErr}）`);
      }
    }
  }

  async getStatus(group: string, did: string): Promise<SseinfraDeployStatus> {
    const res = await this.authedRequest(`/api/pods/${encodeURIComponent(group)}/deploys/${encodeURIComponent(did)}/status`);
    if (res.status !== 200 || !res.data) {
      return { state: 'unknown', raw: res.text.slice(0, 500) };
    }
    return {
      state: String(res.data.state || 'unknown'),
      raw: JSON.stringify(res.data).slice(0, 500),
      pill: res.data.pill,
    };
  }

  async getLogs(group: string, did: string): Promise<string> {
    const res = await this.authedRequest(`/api/pods/${encodeURIComponent(group)}/deploys/${encodeURIComponent(did)}/logs`);
    if (res.status !== 200)
      return res.text;
    return typeof res.data?.logs === 'string' ? res.data.logs : JSON.stringify(res.data);
  }

  /** 确保 MinIO 运行（POST /api/infra/storage/ensure） */
  async ensureMinio(): Promise<void> {
    await this.beforeWrite();
    const res = await this.request('/api/infra/storage/ensure', { method: 'POST' });
    if (res.status !== 200) {
      throw new Error(`MinIO ensure 失败（HTTP ${res.status}）: ${apiErrorMessage(res.data, res.status)}`);
    }
  }

  /** 列出存储面板上的全部密钥（含 Access Key 与 Secret） */
  async listStorageKeys(): Promise<SseinfraStorageKey[]> {
    await this.login();
    const res = await this.authedRequest('/api/infra/storage');
    if (res.status !== 200) {
      throw new Error(`获取存储信息失败（HTTP ${res.status}）: ${apiErrorMessage(res.data, res.status)}`);
    }
    return (res.data?.keys || [])
      .filter((k: { access_key?: string; secret?: string }) => k.access_key && k.secret)
      .map((k: { label?: string; bucket?: string; access_key: string; secret: string; perm?: string }) => ({
        label: k.label || k.access_key,
        bucket: k.bucket || k.label || k.access_key,
        accessKey: k.access_key,
        secret: k.secret,
        perm: k.perm || 'readwrite',
      }));
  }

  /** 按标签（=组名）查找密钥；同标签多条时返回全部 */
  async findStorageKeysByLabel(label: string): Promise<SseinfraStorageKey[]> {
    const want = label.trim().toLowerCase();
    const keys = await this.listStorageKeys();
    return keys.filter((k) => k.label.toLowerCase() === want);
  }

  /** 新建桶（已存在时 API 报错原文含 existed；此处幂等不抛） */
  async addBucket(name: string): Promise<{ flash: string }> {
    const bucket = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) && !/^[a-z0-9-]{3,63}$/.test(bucket)) {
      throw new Error(`桶名不合规: ${bucket}（须小写字母数字与 -）`);
    }
    await this.beforeWrite();
    const res = await this.request('/api/infra/storage/buckets', {
      method: 'POST',
      json: { name: bucket },
    });
    if (res.status === 201 || res.status === 200)
      return { flash: '' };
    const msg = apiErrorMessage(res.data, res.status);
    if (/exist|已存在/i.test(msg))
      return { flash: msg };
    throw new Error(`创建桶 ${bucket} 失败（HTTP ${res.status}）: ${msg}`);
  }

  /** 发密钥。label 必须等于组名，deploy.sh 才会自动注入 MINIO_*。 */
  async addKey(opts: { label: string; bucket: string; perm?: string }): Promise<{ flash: string }> {
    const label = opts.label.trim();
    const bucket = opts.bucket.trim().toLowerCase();
    if (!label || !bucket)
      throw new Error('发密钥需要 label 与 bucket');
    await this.beforeWrite();
    const res = await this.request('/api/infra/storage/keys', {
      method: 'POST',
      json: { label, bucket, perm: opts.perm || 'readwrite' },
    });
    if (res.status === 201 || res.status === 200)
      return { flash: '' };
    throw new Error(`发密钥失败（HTTP ${res.status}）: ${apiErrorMessage(res.data, res.status)}`);
  }

  /**
   * 为一模块环境准备桶 + 密钥：桶名与组名一致，密钥标签=组名（自动注入）。
   * 注意：平台不提供删桶 API；删组/删模块默认不删桶，生命周期随模块保留。
   */
  async provisionModuleObjectStorage(moduleName: string, env: string): Promise<{ group: string; bucket: string; flashes: string[] }> {
    const group = sseinfraGroupName(moduleName, env);
    const bucket = group;
    const flashes: string[] = [];
    await this.ensureMinio();
    const b = await this.addBucket(bucket);
    if (b.flash)
      flashes.push(b.flash);
    const k = await this.addKey({ label: group, bucket, perm: 'readwrite' });
    if (k.flash)
      flashes.push(k.flash);
    return { group, bucket, flashes };
  }
}

export function platformDeployToken(moduleToken?: string): string {
  return (moduleToken || cfg().platformToken || '').trim();
}

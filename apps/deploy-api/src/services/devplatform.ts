/**
 * 集市开发者平台（developer.ssemarket.cn）API 客户端。
 *
 * 协议（iWiki《开发者平台系统api文档》《模块身份验证说明》）：
 *   x-model-Authorization: base64url(slug).base64url(ts).base64url(nonce).base64url(sign)
 *   x-model-query-time:    <毫秒时间戳，与签名第 4 段一致>
 *   签名串 "{slug}\n{ts}\n{nonce}\n{queryTime}"，SM2(sm2p256v1)+SM3，hash:true、非 DER（64B r‖s 的 128 位 hex 文本）。
 *
 * 环境变量：
 *   MODEL_SM_SECRET       deploy 模块私钥（64 位 hex；缺失时本模块功能降级关闭）
 *   DEVPLATFORM_BASE_URL  默认 https://developer.ssemarket.cn
 *   DEVPLATFORM_SLUG      默认 deploy
 *
 * 接口（scope）：
 *   GET  /api/open/developers/check?oauthId=   developers.check — 是否开发者
 *   POST /api/open/oa/submit                   oa.submit        — 提交审批单（oaid 幂等）
 *   GET  /api/open/oa/query?oaid=              oa.query         — 查询审批状态
 */

import { createRequire } from 'module';

export type DevStatus = 'pending' | 'approved' | 'rejected';

export interface OaItem {
  oaid: string;
  moduleId: number;
  moduleSlug: string;
  moduleName: string;
  title: string;
  content: string;
  extra: Record<string, unknown>;
  status: DevStatus;
  currentNode: string | null;
  timeline: Array<{ action: string; viaModule?: string; by?: string | null; note?: string; at: string }>;
  submitAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
}

export interface DeveloperCheck {
  found: boolean;
  isDeveloper: boolean;
  isAdmin: boolean;
  userId: number | null;
  oauthId: string | null;
  name?: string;
  displayName?: string;
}

export interface DevIdentity {
  configured: boolean;
  platformUrl: string;
  joinUrl: string;
  checked: boolean;
  isDeveloper: boolean;
  isAdmin: boolean;
  effective?: boolean;
  name?: string;
  reason?: string;
}

const BASE_URL = (process.env.DEVPLATFORM_BASE_URL || 'https://developer.ssemarket.cn').replace(/\/$/, '');
const SLUG = process.env.DEVPLATFORM_SLUG || 'deploy';

interface Sm2Lib {
  doSignature(msg: string, privkey: string, opts?: { hash?: boolean; der?: boolean; userId?: string }): string;
}

let sm2: Sm2Lib | null = null;
let sm2Tried = false;

function loadSm2(): Sm2Lib | null {
  if (sm2Tried) return sm2;
  sm2Tried = true;
  try {
    // dist 运行时依赖宿主机 node_modules/sm-crypto（compose 只读挂载）；sm-crypto 无类型声明
    const require_ = createRequire(import.meta.url);
    sm2 = (require_('sm-crypto') as { sm2: Sm2Lib }).sm2;
  } catch {
    sm2 = null;
  }
  return sm2;
}

export function privateKey(): string {
  return (process.env.MODEL_SM_SECRET || '').trim();
}

/** 平台通路是否可用（私钥与 sm-crypto 都就位） */
export function devPlatformConfigured(): boolean {
  return Boolean(privateKey()) && Boolean(loadSm2());
}

const b64u = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

function authHeaders(): Record<string, string> {
  const key = privateKey();
  const lib = loadSm2();
  if (!key || !lib) throw new Error('开发者平台未配置（MODEL_SM_SECRET / sm-crypto）');
  const ts = String(Date.now());
  const nonce = Math.random().toString(36).slice(2, 12);
  const queryTime = String(Date.now());
  const payload = `${SLUG}\n${ts}\n${nonce}\n${queryTime}`;
  const sign = lib.doSignature(payload, key, { hash: true, der: false });
  return {
    'x-model-Authorization': [b64u(SLUG), b64u(ts), b64u(nonce), b64u(sign)].join('.'),
    'x-model-query-time': queryTime,
  };
}

interface Envelope<T> {
  code: number;
  message: string;
  data?: T;
}

async function call<T>(
  path: string,
  opts?: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number }
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 10_000);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: opts?.method ?? 'GET',
      headers: { ...authHeaders(), ...(opts?.body != null ? { 'Content-Type': 'application/json' } : {}) },
      body: opts?.body != null ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as Partial<Envelope<T>>;
    if (!res.ok || json.code !== 0) {
      const hint = json.message ? `：${json.message}` : '';
      throw new Error(`开发者平台接口失败 (${res.status})${hint}`);
    }
    return json.data as T;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('开发者平台接口超时');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** —— developers.check（带 60s 进程内缓存，避免高频调用平台） —— */

const checkCache = new Map<string, { at: number; data: DeveloperCheck }>();
const CHECK_TTL_MS = 60_000;

export async function checkDeveloper(oauthId: string): Promise<DeveloperCheck> {
  const hit = checkCache.get(oauthId);
  if (hit && Date.now() - hit.at < CHECK_TTL_MS) return hit.data;
  const data = await call<DeveloperCheck>(
    `/api/open/developers/check?oauthId=${encodeURIComponent(oauthId)}`
  );
  checkCache.set(oauthId, { at: Date.now(), data });
  return data;
}

/** —— OA 审批 —— */

export function submitOa(input: {
  oaid: string;
  title: string;
  content?: string;
  extra?: Record<string, unknown>;
}): Promise<OaItem> {
  return call<OaItem>('/api/open/oa/submit', {
    method: 'POST',
    body: {
      oaid: input.oaid,
      title: input.title,
      content: input.content || '',
      extra: input.extra ?? {},
    },
  });
}

export function queryOa(oaid: string): Promise<OaItem> {
  return call<OaItem>(`/api/open/oa/query?oaid=${encodeURIComponent(oaid)}`);
}

export const DEV_PLATFORM_BASE_URL = BASE_URL;

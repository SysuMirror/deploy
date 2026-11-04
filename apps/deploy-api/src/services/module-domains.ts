/**
 * 模块访问域名（子域名 / 自定义域名）
 * - 一模块可挂多个 host；全局 host 唯一
 * - 保留：根域、www、cloud 等不可占用
 * - gray_* 字段预留按 header/query 灰度（后续网关 map）
 */
import { randomUUID } from 'crypto';
import { db, getBaseDomain } from '../db/init.js';
import { defaultModuleHost } from './routing.js';
import type { DeployEnv } from '../types.js';

export type DomainKind = 'subdomain' | 'custom';
export type GrayMatchType = 'none' | 'header' | 'query' | 'cookie';
/** 域名反代到模块的前端端口还是 API 端口 */
export type DomainRouteTarget = 'web' | 'api';

export interface ModuleDomain {
  id: string;
  moduleId: string;
  env: DeployEnv;
  kind: DomainKind;
  /** 完整主机名，小写，如 image.ssemarket.cn */
  host: string;
  /** 子域标签（kind=subdomain），如 image；custom 为空 */
  label: string;
  /** web=前端上游；api=后端上游（sseinfra 单端口时两者相同） */
  routeTarget: DomainRouteTarget;
  enabled: boolean;
  isPrimary: boolean;
  grayMatchType: GrayMatchType;
  grayMatchKey: string;
  grayMatchValue: string;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
}

type DomainRow = {
  id: string;
  module_id: string;
  env: string;
  kind: string;
  host: string;
  label: string;
  route_target?: string;
  enabled: number;
  is_primary: number;
  gray_match_type: string;
  gray_match_key: string;
  gray_match_value: string;
  created_at: string;
  created_by: string | null;
  updated_at: string;
};

/**
 * 不可作为「平台子域名标签」占用。
 * 注意：`api` / `platform` 已开放给业务模块（如 sseapi 的 api. / platform.）。
 */
export const RESERVED_SUBDOMAIN_LABELS = new Set([
  'cloud',
  'www',
  'sso',
  'mail',
  'ftp',
  'admin',
  'monitor',
  'jaeger',
  'sdpy',
  'deploy',
  'iwiki',
  'ns1',
  'ns2',
  'mx',
  'cdn',
  'static',
  'assets',
  'gateway',
  'frp',
  'minio',
  'storage',
]);

function mapRow(r: DomainRow): ModuleDomain {
  return {
    id: r.id,
    moduleId: r.module_id,
    env: r.env as DeployEnv,
    kind: r.kind as DomainKind,
    host: r.host,
    label: r.label ?? '',
    routeTarget: (r.route_target as string) === 'api' ? 'api' : 'web',
    enabled: Boolean(r.enabled),
    isPrimary: Boolean(r.is_primary),
    grayMatchType: (r.gray_match_type as GrayMatchType) || 'none',
    grayMatchKey: r.gray_match_key ?? '',
    grayMatchValue: r.gray_match_value ?? '',
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
  };
}

export function ensureModuleDomainsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS module_domains (
      id TEXT PRIMARY KEY,
      module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      env TEXT NOT NULL CHECK (env IN ('test', 'prod')),
      kind TEXT NOT NULL CHECK (kind IN ('subdomain', 'custom')),
      host TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      route_target TEXT NOT NULL DEFAULT 'web',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_primary INTEGER NOT NULL DEFAULT 0,
      gray_match_type TEXT NOT NULL DEFAULT 'none',
      gray_match_key TEXT NOT NULL DEFAULT '',
      gray_match_value TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_module_domains_host ON module_domains(host);
    CREATE INDEX IF NOT EXISTS idx_module_domains_module ON module_domains(module_id, env);
  `);
  const cols = db.prepare(`PRAGMA table_info(module_domains)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'route_target')) {
    db.exec(`ALTER TABLE module_domains ADD COLUMN route_target TEXT NOT NULL DEFAULT 'web'`);
  }
}

function normalizeHost(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
}

function isValidHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (host.includes('..') || host.startsWith('.') || host.endsWith('.')) return false;
  // 允许 punycode / 常规 DNS 标签
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    host
  );
}

function isValidSubdomainLabel(label: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

/** 根域、www、以及保留标签对应的 FQDN */
export function assertHostAllowed(host: string, kind: DomainKind, label?: string): void {
  const base = getBaseDomain().toLowerCase();
  const h = normalizeHost(host);

  if (!isValidHostname(h)) {
    throw new Error(`非法域名: ${host}`);
  }
  if (h === base || h === `www.${base}`) {
    throw new Error(`不可使用平台根域名（${base} / www.${base}）`);
  }

  // 任意 kind 都不能占用 cloud.base 等保留 FQDN
  for (const reserved of RESERVED_SUBDOMAIN_LABELS) {
    if (h === `${reserved}.${base}`) {
      throw new Error(`子域名「${reserved}」为平台保留，不可占用`);
    }
  }

  if (kind === 'subdomain') {
    const lbl = (label ?? h.slice(0, -(base.length + 1))).toLowerCase();
    if (!lbl) {
      throw new Error('子域名不能为空');
    }
    if (h !== `${lbl}.${base}`) {
      throw new Error(`子域名须落在 *.${base} 下（期望 ${lbl}.${base}）`);
    }
    // 允许多级子域名（如 test.image.base，测试环境子域名），逐段校验
    const segments = lbl.split('.');
    for (const seg of segments) {
      if (!isValidSubdomainLabel(seg)) {
        throw new Error(`子域名标签「${seg}」须为小写字母/数字/连字符，且不能以连字符开头或结尾`);
      }
      if (RESERVED_SUBDOMAIN_LABELS.has(seg)) {
        throw new Error(`子域名「${seg}」为平台保留，不可占用`);
      }
    }
  } else {
    // 自定义域名：禁止写成平台根或其保留子域
    if (h === base || h.endsWith(`.${base}`)) {
      // 允许用户用「自定义」形态登记非保留的平台子域？更清晰：平台子域请用 kind=subdomain
      const maybeLabel = h.slice(0, -(base.length + 1));
      if (!maybeLabel.includes('.')) {
        throw new Error(`登记 *.${base} 请使用「平台子域名」类型，不要用自定义域名`);
      }
    }
  }
}

export function listModuleDomains(moduleId: string, env?: DeployEnv): ModuleDomain[] {
  if (env) {
    return (
      db
        .prepare(
          `SELECT * FROM module_domains WHERE module_id = ? AND env = ? ORDER BY is_primary DESC, created_at ASC`
        )
        .all(moduleId, env) as DomainRow[]
    ).map(mapRow);
  }
  return (
    db
      .prepare(
        `SELECT * FROM module_domains WHERE module_id = ? ORDER BY env ASC, is_primary DESC, created_at ASC`
      )
      .all(moduleId) as DomainRow[]
  ).map(mapRow);
}

export function getModuleDomain(id: string): ModuleDomain | null {
  const row = db.prepare('SELECT * FROM module_domains WHERE id = ?').get(id) as DomainRow | undefined;
  return row ? mapRow(row) : null;
}

export function findDomainByHost(host: string): ModuleDomain | null {
  const row = db
    .prepare('SELECT * FROM module_domains WHERE host = ?')
    .get(normalizeHost(host)) as DomainRow | undefined;
  return row ? mapRow(row) : null;
}

/** 列出已启用且对应环境有上游端口的域名（供网关生成） */
export function listEnabledDomainsForGateway(): Array<
  ModuleDomain & { moduleName: string; upstreamPort: number | null }
> {
  const rows = db
    .prepare(
      `SELECT d.*, m.name as module_name,
              CASE
                WHEN d.route_target = 'api' THEN
                  CASE d.env
                    WHEN 'test' THEN COALESCE(m.active_test_api_port, m.active_test_web_port, m.active_test_port)
                    ELSE COALESCE(m.active_prod_api_port, m.active_prod_web_port, m.active_prod_port)
                  END
                ELSE
                  CASE d.env
                    WHEN 'test' THEN COALESCE(m.active_test_web_port, m.active_test_port, m.active_test_api_port)
                    ELSE COALESCE(m.active_prod_web_port, m.active_prod_port, m.active_prod_api_port)
                  END
              END as upstream_port
       FROM module_domains d
       JOIN modules m ON m.id = d.module_id
       WHERE d.enabled = 1
       ORDER BY d.host ASC`
    )
    .all() as Array<DomainRow & { module_name: string; upstream_port: number | null }>;

  return rows.map((r) => ({
    ...mapRow(r),
    moduleName: r.module_name,
    upstreamPort: r.upstream_port ?? null,
  }));
}

export interface AddDomainInput {
  env: DeployEnv;
  kind: DomainKind;
  /** subdomain: 标签如 image；custom: 完整域名 app.example.com */
  value: string;
  /** web=控制台/前端；api=后端 API 域名 */
  routeTarget?: DomainRouteTarget;
  isPrimary?: boolean;
  grayMatchType?: GrayMatchType;
  grayMatchKey?: string;
  grayMatchValue?: string;
}

export function addModuleDomain(
  moduleId: string,
  input: AddDomainInput,
  actorId?: string
): ModuleDomain {
  const base = getBaseDomain().toLowerCase();
  const kind = input.kind;
  let label = '';
  let host = '';

  if (kind === 'subdomain') {
    const v = normalizeHost(input.value);
    // 支持多级子域名：test.image.ssemarket.cn → label = test.image
    if (v.endsWith(`.${base}`)) {
      label = v.slice(0, -(base.length + 1));
      host = v;
    } else {
      label = v.split('.')[0] ?? '';
      host = `${label}.${base}`;
    }
  } else {
    host = normalizeHost(input.value);
    label = '';
  }

  assertHostAllowed(host, kind, label);

  const routeTarget: DomainRouteTarget = input.routeTarget === 'api' ? 'api' : 'web';

  const clash = findDomainByHost(host);
  if (clash) {
    if (clash.moduleId === moduleId) {
      throw new Error(`域名 ${host} 已绑定本模块`);
    }
    throw new Error(`域名 ${host} 已被其他模块占用`);
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const grayType = input.grayMatchType ?? 'none';
  const grayKey = (input.grayMatchKey ?? '').trim();
  const grayValue = (input.grayMatchValue ?? '').trim();
  if (grayType !== 'none' && (!grayKey || !grayValue)) {
    throw new Error('灰度匹配须同时填写 key 与 value（后续生效）');
  }

  // 主域名仅针对「前端」域名；API 域名不抢主站 URL
  let isPrimary = Boolean(input.isPrimary) && routeTarget === 'web';
  const existing = listModuleDomains(moduleId, input.env).filter((d) => d.routeTarget === 'web');
  if (routeTarget === 'web' && existing.length === 0) isPrimary = true;
  if (isPrimary) {
    db.prepare(
      `UPDATE module_domains SET is_primary = 0, updated_at = ? WHERE module_id = ? AND env = ?`
    ).run(now, moduleId, input.env);
  }

  db.prepare(
    `INSERT INTO module_domains (
      id, module_id, env, kind, host, label, route_target, enabled, is_primary,
      gray_match_type, gray_match_key, gray_match_value,
      created_at, created_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    moduleId,
    input.env,
    kind,
    host,
    label,
    routeTarget,
    isPrimary ? 1 : 0,
    grayType,
    grayKey,
    grayValue,
    now,
    actorId ?? null,
    now
  );

  return getModuleDomain(id)!;
}

export function updateModuleDomain(
  id: string,
  patch: {
    enabled?: boolean;
    isPrimary?: boolean;
    routeTarget?: DomainRouteTarget;
    grayMatchType?: GrayMatchType;
    grayMatchKey?: string;
    grayMatchValue?: string;
  },
  moduleId: string
): ModuleDomain {
  const cur = getModuleDomain(id);
  if (!cur || cur.moduleId !== moduleId) throw new Error('域名记录不存在');

  const now = new Date().toISOString();
  const enabled = patch.enabled === undefined ? (cur.enabled ? 1 : 0) : patch.enabled ? 1 : 0;
  const routeTarget: DomainRouteTarget =
    patch.routeTarget === 'api' || patch.routeTarget === 'web'
      ? patch.routeTarget
      : cur.routeTarget;
  let isPrimary = patch.isPrimary === undefined ? (cur.isPrimary ? 1 : 0) : patch.isPrimary ? 1 : 0;
  if (routeTarget === 'api') isPrimary = 0;
  const grayType = patch.grayMatchType ?? cur.grayMatchType;
  const grayKey =
    patch.grayMatchKey !== undefined ? patch.grayMatchKey.trim() : cur.grayMatchKey;
  const grayValue =
    patch.grayMatchValue !== undefined ? patch.grayMatchValue.trim() : cur.grayMatchValue;

  if (grayType !== 'none' && (!grayKey || !grayValue)) {
    throw new Error('灰度匹配须同时填写 key 与 value');
  }

  if (isPrimary) {
    db.prepare(
      `UPDATE module_domains SET is_primary = 0, updated_at = ? WHERE module_id = ? AND env = ? AND id != ?`
    ).run(now, moduleId, cur.env, id);
  }

  db.prepare(
    `UPDATE module_domains SET
       enabled = ?, is_primary = ?, route_target = ?,
       gray_match_type = ?, gray_match_key = ?, gray_match_value = ?,
       updated_at = ?
     WHERE id = ?`
  ).run(enabled, isPrimary, routeTarget, grayType, grayKey, grayValue, now, id);

  return getModuleDomain(id)!;
}

export function deleteModuleDomain(id: string, moduleId: string): void {
  const cur = getModuleDomain(id);
  if (!cur || cur.moduleId !== moduleId) throw new Error('域名记录不存在');
  db.prepare('DELETE FROM module_domains WHERE id = ?').run(id);
  if (cur.isPrimary) {
    const next = listModuleDomains(moduleId, cur.env).find(
      (d) => d.enabled && d.routeTarget === 'web'
    );
    if (next) {
      db.prepare(`UPDATE module_domains SET is_primary = 1, updated_at = ? WHERE id = ?`).run(
        new Date().toISOString(),
        next.id
      );
    }
  }
}

/** 部署写回 / 注入环境变量时优先用的公网 Web URL（仅 routeTarget=web） */
export function resolvePreferredPublicWebUrl(
  moduleId: string,
  env: DeployEnv,
  fallbackPathUrl: string
): string {
  const domains = listModuleDomains(moduleId, env).filter(
    (d) => d.enabled && d.routeTarget === 'web'
  );
  const primary = domains.find((d) => d.isPrimary) ?? domains[0];
  if (primary) return `https://${primary.host}`;
  return fallbackPathUrl;
}

/** API 公网 URL：优先 routeTarget=api 的域名 */
export function resolvePreferredPublicApiUrl(
  moduleId: string,
  env: DeployEnv,
  fallbackPathUrl: string
): string {
  const domains = listModuleDomains(moduleId, env).filter(
    (d) => d.enabled && d.routeTarget === 'api'
  );
  const pick = domains[0];
  if (pick) return `https://${pick.host}`;
  return fallbackPathUrl;
}

export function publicUrlForDomain(host: string): string {
  return `https://${normalizeHost(host)}`;
}

/**
 * 「仅子域名」模式的默认访问域名：prod={module}.base、test=test.{module}.base。
 * 首次部署（或切换到该模式）时自动登记，幂等。
 */
export function ensureDefaultDomainsForModule(
  moduleId: string,
  moduleName: string,
  env: DeployEnv,
  actorId?: string
): ModuleDomain | null {
  const host = defaultModuleHost(moduleName, env);
  const existing = findDomainByHost(host);
  if (existing) {
    if (existing.moduleId === moduleId) {
      if (!existing.enabled) {
        updateModuleDomain(existing.id, { enabled: true }, moduleId);
        return getModuleDomain(existing.id);
      }
      return existing;
    }
    throw new Error(`默认域名 ${host} 已被其他模块占用`);
  }
  return addModuleDomain(
    moduleId,
    { env, kind: 'subdomain', value: host, routeTarget: 'web', isPrimary: true },
    actorId
  );
}

/**
 * 模块环境变量：按 test / prod 分槽存储与校验。
 * 部署时转为根目录 .env，并注入进程/组环境（与 MODULE_DATA 同为平台基础隔离）。
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { db } from '../db/init.js';
import type { DeployEnv } from '../types.js';
import { getModuleDataRoot } from './module-data.js';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 平台注入键：用户配置可存，部署时一律以平台值为准覆盖 */
export const PLATFORM_ENV_KEYS = new Set([
  'PORT',
  'SDPY_ENV',
  'SDPY_MODULE',
  'SDPY_DATA_DIR',
  'DATA_DIR',
  'WEB_HOST_PORT',
  'API_HOST_PORT',
  'COMPOSE_PROJECT_NAME',
  'SDPY_PUBLIC_BASE',
  'SDPY_API_PUBLIC_BASE',
  'SDPY_PUBLIC_URL',
  'SDPY_API_PUBLIC_URL',
  /** 模块优先级：部署台注入，sseinfra 据此排杀序（压力降级分层） */
  'PRIORITY',
]);

export function ensureModuleEnvConfigTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS module_env_configs (
      module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      env TEXT NOT NULL CHECK (env IN ('test', 'prod')),
      vars_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      PRIMARY KEY (module_id, env)
    );
  `);
}

export function parseEnvInput(raw: unknown): Record<string, string> {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return normalizeVars(raw as Record<string, unknown>);
  }
  if (typeof raw !== 'string') {
    throw new Error('环境变量须为 JSON 对象或 .env 文本');
  }
  const text = raw.trim();
  if (!text) return {};
  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('JSON 解析失败，请检查格式');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON 须为对象，如 {"KEY":"value"}');
    }
    return normalizeVars(parsed as Record<string, unknown>);
  }
  return parseDotEnvText(text);
}

function normalizeVars(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = k.trim();
    if (!key) continue;
    if (!KEY_RE.test(key)) {
      throw new Error(`非法变量名: ${key}（仅字母/数字/下划线，且不能以数字开头）`);
    }
    if (v == null) continue;
    out[key] = String(v);
  }
  return out;
}

function parseDotEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) throw new Error(`无法解析行: ${t.slice(0, 80)}`);
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!KEY_RE.test(key)) {
      throw new Error(`非法变量名: ${key}`);
    }
    out[key] = val;
  }
  return out;
}

/** 转为根目录可读的 .env 正文 */
export function varsToDotEnv(vars: Record<string, string>): string {
  const keys = Object.keys(vars).sort();
  if (!keys.length) return '';
  return (
    keys
      .map((k) => {
        const v = vars[k] ?? '';
        if (/[\n\r#]/.test(v) || /\s/.test(v) || /["'=]/.test(v)) {
          return `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
        }
        return `${k}=${v}`;
      })
      .join('\n') + '\n'
  );
}

export function getModuleEnvVars(moduleId: string, env: DeployEnv): Record<string, string> {
  ensureModuleEnvConfigTable();
  const row = db
    .prepare('SELECT vars_json FROM module_env_configs WHERE module_id = ? AND env = ?')
    .get(moduleId, env) as { vars_json: string } | undefined;
  if (!row?.vars_json) return {};
  try {
    const parsed = JSON.parse(row.vars_json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return normalizeVars(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

export function setModuleEnvVars(
  moduleId: string,
  env: DeployEnv,
  vars: Record<string, string>,
  updatedBy?: string
): Record<string, string> {
  ensureModuleEnvConfigTable();
  const normalized = normalizeVars(vars);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO module_env_configs (module_id, env, vars_json, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(module_id, env) DO UPDATE SET
       vars_json = excluded.vars_json,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  ).run(moduleId, env, JSON.stringify(normalized), now, updatedBy ?? null);
  return normalized;
}

export function getModuleEnvConfigMeta(moduleId: string, env: DeployEnv, moduleName: string) {
  ensureModuleEnvConfigTable();
  const vars = getModuleEnvVars(moduleId, env);
  const row = db
    .prepare(
      'SELECT updated_at, updated_by FROM module_env_configs WHERE module_id = ? AND env = ?'
    )
    .get(moduleId, env) as { updated_at: string; updated_by: string | null } | undefined;
  return {
    env,
    vars,
    envFile: varsToDotEnv(vars),
    keyCount: Object.keys(vars).length,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
    /** 该环境业务数据目录（与配置同为 test/prod 隔离） */
    dataDir: `${getModuleDataRoot()}/${moduleName}/${env}`,
    reservedKeys: [...PLATFORM_ENV_KEYS].sort(),
  };
}

/**
 * 合并用户配置与平台键：平台键覆盖用户同名项。
 * 返回用于 supervisord / setEnv / .env 的最终映射。
 */
export function mergeDeployEnv(
  userVars: Record<string, string>,
  platformVars: Record<string, string>
): Record<string, string> {
  const merged = { ...userVars, ...platformVars };
  return merged;
}

/** 写入部署目录根 `.env`（应用可读）；不含空映射则写空文件或跳过 */
export function writeRootDotEnv(dir: string, vars: Record<string, string>): string {
  const path = join(dir, '.env');
  writeFileSync(path, varsToDotEnv(vars), 'utf8');
  return path;
}

export function countUserEnvKeys(moduleId: string, env: DeployEnv): number {
  return Object.keys(getModuleEnvVars(moduleId, env)).length;
}

/** 将变量写入 sseinfra 组；优先 setEnvMany（只重登一次） */
export async function pushEnvToSseinfraGroup(
  client: {
    setEnv: (group: string, key: string, value: string) => Promise<void>;
    setEnvMany?: (group: string, vars: Record<string, string>) => Promise<void>;
  },
  group: string,
  vars: Record<string, string>,
  log: (line: string) => void
): Promise<void> {
  const keys = Object.keys(vars);
  if (!keys.length) return;
  if (typeof client.setEnvMany === 'function') {
    try {
      await client.setEnvMany(group, vars);
      log(`[env] 已向组同步环境变量 ${keys.length} 个（含平台键，单次登录）`);
      return;
    } catch (e) {
      log(`[env] setEnvMany 失败，回退逐个写入: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let ok = 0;
  for (const k of keys) {
    try {
      await client.setEnv(group, k, vars[k]!);
      ok++;
    } catch (e) {
      log(`[env] setEnv ${k} 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log(`[env] 已向组同步环境变量 ${ok}/${keys.length} 个（含平台键）`);
}

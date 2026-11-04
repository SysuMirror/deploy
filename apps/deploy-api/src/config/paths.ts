import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getPlatformSetting } from '../db/init.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getDataDir(): string {
  const dir = process.env.DEPLOY_DATA_DIR ?? join(__dirname, '../../data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getWorkDir(): string {
  const dir = process.env.WORK_DIR ?? join(getDataDir(), 'work');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getUploadsDir(): string {
  const dir = join(getDataDir(), 'uploads');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getNginxDir(): string {
  const dir = join(getDataDir(), 'nginx');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 归一化路径前缀：空 / `/` → ''（根路径模式），否则去尾斜杠、确保以 `/` 开头。
 */
export function normalizeBasePath(raw: string): string {
  const v = raw.trim();
  if (!v || v === '/') return '';
  return v.startsWith('/') ? v.replace(/\/+$/, '') : `/${v.replace(/\/+$/, '')}`;
}

/**
 * 用户模块公网路径前缀（平台默认）：
 * - 管理员可在管理台配置（platform_settings.public_base_path），优先于环境变量
 * - 未设置：默认根路径模式 → /test/{m}、/{m}
 * - 设为 `/` 或空：根路径模式（同默认）
 * - 设为 `/sdpy`：前缀模式 → /sdpy/test/{m}、/sdpy/{m}
 */
export function getPublicBasePath(): string {
  const dbVal = getPlatformSetting('public_base_path');
  if (dbVal !== undefined) return normalizeBasePath(dbVal);
  const env = process.env.PUBLIC_BASE_PATH;
  return env === undefined ? '' : normalizeBasePath(env);
}

/** 是否根路径模式（模块挂在 / 与 /test） */
export function isRootPublicBase(): boolean {
  return getPublicBasePath() === '';
}

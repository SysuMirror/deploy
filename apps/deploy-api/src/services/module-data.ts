import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { DeployEnv } from '../types.js';
import { findComposeFile } from './package-store.js';

const OVERRIDE_FILE = 'compose.sdpy.data.yml';

/** 用户模块持久化根目录（宿主机）。默认 /root/SSE_Market/sse-sdpy/data */
export function getModuleDataRoot(): string {
  const raw = (process.env.MODULE_DATA_ROOT ?? '/root/SSE_Market/sse-sdpy/data').trim();
  return raw.replace(/\/+$/, '') || '/root/SSE_Market/sse-sdpy/data';
}

/**
 * 模块数据目录：{MODULE_DATA_ROOT}/{模块名}/{test|prod}
 * 测试与正式拆开；目录不存在则创建。重建容器不丢数据。
 */
export function ensureModuleDataDir(moduleName: string, env: DeployEnv): string {
  const dir = join(getModuleDataRoot(), moduleName, env);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getModuleDataDir(moduleName: string, env: DeployEnv): string {
  return join(getModuleDataRoot(), moduleName, env);
}

/** 粗估目录字节数（有条目上限，防巨树拖死） */
export function approxModuleDataBytes(dir: string, maxEntries = 8000): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  let n = 0;
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (n++ > maxEntries) return;
      const p = join(d, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else total += st.size;
      } catch {
        // skip
      }
    }
  };
  walk(dir);
  return total;
}

/** 去掉用户 compose 里已有的 /data 绑定，避免与平台 bind mount 冲突 */
function stripDataBinds(composeText: string): string {
  return composeText
    .split(/\r?\n/)
    .filter((line) => !/^\s*-\s+\S+:\/data\/?\s*$/.test(line))
    .join('\n');
}

/**
 * 在部署工作目录写入 compose overlay，把宿主机模块目录 bind 到 api 容器 /data。
 * 返回要追加的 compose -f 参数（含主文件）。
 */
export function prepareModuleDataMount(
  buildDir: string,
  hostDataDir: string
): { composeFiles: string[]; overrideFile: string } {
  const main = findComposeFile(buildDir);
  if (!main) throw new Error('包内未找到 compose 文件');

  const mainPath = join(buildDir, main);
  const original = readFileSync(mainPath, 'utf8');
  const stripped = stripDataBinds(original);
  if (stripped !== original) {
    writeFileSync(mainPath, stripped, 'utf8');
  }

  const override = `services:
  api:
    volumes:
      - ${hostDataDir}:/data
`;
  const overridePath = join(buildDir, OVERRIDE_FILE);
  writeFileSync(overridePath, override, 'utf8');

  return { composeFiles: [main, OVERRIDE_FILE], overrideFile: OVERRIDE_FILE };
}

export function composeFileArgs(files: string[]): string {
  return files.map((f) => `-f ${f}`).join(' ');
}

export function moduleDataDirExists(moduleName: string, env?: DeployEnv): boolean {
  const dir = env
    ? join(getModuleDataRoot(), moduleName, env)
    : join(getModuleDataRoot(), moduleName);
  return existsSync(dir);
}

/** 导出上限（未压缩粗估），默认 512MB，可用 MODULE_DATA_EXPORT_MAX_MB 覆盖 */
export function moduleDataExportMaxBytes(): number {
  const mb = Number(process.env.MODULE_DATA_EXPORT_MAX_MB) || 512;
  return Math.max(16, mb) * 1024 * 1024;
}

export type ModuleDataExportInfo = {
  env: DeployEnv;
  dataDir: string;
  exists: boolean;
  approxBytes: number;
  empty: boolean;
  tooLarge: boolean;
  maxBytes: number;
  fileName: string;
};

export function describeModuleDataExport(
  moduleName: string,
  env: DeployEnv
): ModuleDataExportInfo {
  const dataDir = getModuleDataDir(moduleName, env);
  const exists = existsSync(dataDir);
  const approxBytes = exists ? approxModuleDataBytes(dataDir) : 0;
  const maxBytes = moduleDataExportMaxBytes();
  const empty = !exists || approxBytes === 0;
  return {
    env,
    dataDir,
    exists,
    approxBytes,
    empty,
    tooLarge: approxBytes > maxBytes,
    maxBytes,
    fileName: `${moduleName}-${env}-data.zip`,
  };
}

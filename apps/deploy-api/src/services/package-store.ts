import AdmZip from 'adm-zip';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { nanoid } from 'nanoid';
import { getUploadsDir } from '../config/paths.js';

const COMPOSE_NAMES = ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml'];

export interface StoredPackage {
  version: string;
  packagePath: string;
  fileName: string;
  composeFile: string;
  label: string;
}

export function findComposeFile(root: string): string | null {
  for (const name of COMPOSE_NAMES) {
    if (existsSync(join(root, name))) return name;
  }
  return null;
}

/** 解压后若只有单层目录，则进入该目录（常见 zip 包装） */
function resolvePackageRoot(extractDir: string): string {
  const entries = readdirSync(extractDir).filter((n) => n !== '__MACOSX');
  if (entries.length === 1) {
    const only = join(extractDir, entries[0]);
    if (statSync(only).isDirectory()) {
      const hasFrontend = existsSync(join(only, 'frontend'));
      const hasBackend = existsSync(join(only, 'backend'));
      const hasDeploySh = existsSync(join(only, 'deploy.sh'));
      if (hasFrontend || hasBackend || hasDeploySh || findComposeFile(only)) {
        return only;
      }
    }
  }
  return extractDir;
}

export function hasDeploySh(root: string): boolean {
  return existsSync(join(root, 'deploy.sh'));
}

/**
 * 校验上传包。
 * - compose：frontend + backend + compose.yml（本机 docker）
 * - sseinfra / either：允许「仅 deploy.sh」或传统 compose 结构
 */
export function validatePackageLayout(
  root: string,
  mode: 'compose' | 'sseinfra' | 'either' = 'either'
): { composeFile: string; kind: 'compose' | 'deploy.sh' } {
  if (hasDeploySh(root) && (mode === 'sseinfra' || mode === 'either')) {
    return { composeFile: '', kind: 'deploy.sh' };
  }

  const needCompose = mode === 'compose' || mode === 'either';
  if (!needCompose && !hasDeploySh(root)) {
    throw new Error('K8s 压缩包须包含可执行 deploy.sh');
  }

  if (!existsSync(join(root, 'frontend')) || !statSync(join(root, 'frontend')).isDirectory()) {
    throw new Error('压缩包须包含 frontend/ 目录，或根目录提供 deploy.sh（K8s 部署）');
  }
  if (!existsSync(join(root, 'backend')) || !statSync(join(root, 'backend')).isDirectory()) {
    throw new Error('压缩包须包含 backend/ 目录，或根目录提供 deploy.sh（K8s 部署）');
  }
  const composeFile = findComposeFile(root);
  if (!composeFile) {
    if (hasDeploySh(root)) return { composeFile: '', kind: 'deploy.sh' };
    throw new Error(
      '压缩包根目录须包含 compose.yml / docker-compose.yml，或提供 deploy.sh（推荐 K8s）'
    );
  }
  return { composeFile, kind: 'compose' };
}

export function saveAndExtractPackage(
  moduleId: string,
  fileName: string,
  buffer: Buffer,
  label?: string
): StoredPackage {
  const version = `v-${nanoid(10)}`;
  const moduleDir = join(getUploadsDir(), moduleId);
  const versionDir = join(moduleDir, version);
  const extractDir = join(versionDir, '_extract');
  mkdirSync(extractDir, { recursive: true });

  const zipPath = join(versionDir, 'source.zip');
  writeFileSync(zipPath, buffer);

  try {
    const zip = new AdmZip(buffer);
    zip.extractAllTo(extractDir, true);
  } catch (e) {
    rmSync(versionDir, { recursive: true, force: true });
    throw new Error(`解压失败: ${e instanceof Error ? e.message : String(e)}`);
  }

  const packageRoot = resolvePackageRoot(extractDir);
  let composeFile: string;
  try {
    ({ composeFile } = validatePackageLayout(packageRoot, 'either'));
  } catch (e) {
    rmSync(versionDir, { recursive: true, force: true });
    throw e;
  }

  const finalPath = join(versionDir, 'app');
  if (packageRoot !== extractDir) {
    renameSync(packageRoot, finalPath);
    rmSync(extractDir, { recursive: true, force: true });
  } else {
    renameSync(extractDir, finalPath);
  }

  // 保留历史版本，不再清理同模块其他目录
  const trimmedLabel = (label ?? '').trim() || fileName;

  return {
    version,
    packagePath: finalPath,
    fileName,
    composeFile,
    label: trimmedLabel,
  };
}

export function getPackageComposePath(packagePath: string): string {
  const composeFile = findComposeFile(packagePath);
  if (!composeFile) throw new Error('包内未找到 compose 文件');
  return join(packagePath, composeFile);
}

export function removePackageVersionDir(moduleId: string, version: string): void {
  const versionDir = join(getUploadsDir(), moduleId, version);
  if (existsSync(versionDir)) {
    rmSync(versionDir, { recursive: true, force: true });
  }
}

export function removeModuleUploads(moduleId: string): void {
  const moduleDir = join(getUploadsDir(), moduleId);
  if (existsSync(moduleDir)) {
    rmSync(moduleDir, { recursive: true, force: true });
  }
}

/**
 * 本机 docker compose → sseinfra/K8s 迁移：识别旧槽位、同步 MODULE_DATA、停旧站。
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { DeployEnv, Module, ModuleSlot } from '../types.js';
import { getModuleDataRoot, ensureModuleDataDir, moduleDataDirExists } from './module-data.js';
import { composeProjectName, regenerateNginxRoutes, stopComposeProject } from './routing.js';
import { getWorkDir } from '../config/paths.js';
import { getDeployment } from './project.js';

export type LegacySlotInfo = {
  env: DeployEnv;
  legacy: boolean;
  reason: string;
  composeProject: string;
  hostDataDir: string;
  dataExists: boolean;
  dataApproxBytes: number;
  webPort?: number;
  apiPort?: number;
  url?: string;
  deploymentId?: string;
  imageTag?: string;
};

function approxDirBytes(dir: string, maxEntries = 5000): number {
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

/** 槽位是否仍像本机 compose（有宿主端口，或 imageTag 非 infra*） */
export function isLegacyComposeSlot(mod: Module, env: DeployEnv): boolean {
  const slot: ModuleSlot = env === 'test' ? mod.test : mod.prod;
  const web = slot.webPort ?? slot.port ?? 0;
  const api = slot.apiPort ?? 0;
  if (web > 0 || api > 0) return true;
  if (!slot.deploymentId) return false;
  const dep = getDeployment(slot.deploymentId);
  const tag = dep?.imageTag || '';
  if (!tag) return false;
  return !tag.startsWith('infra:') && !tag.startsWith('infra-pkg:');
}

export function describeLegacySlot(mod: Module, env: DeployEnv): LegacySlotInfo {
  const slot = env === 'test' ? mod.test : mod.prod;
  const composeProject = composeProjectName(mod.name, env);
  const hostDataDir = join(getModuleDataRoot(), mod.name, env);
  const dataExists = moduleDataDirExists(mod.name, env);
  const dep = slot.deploymentId ? getDeployment(slot.deploymentId) : undefined;
  const legacy = isLegacyComposeSlot(mod, env);
  let reason = '已在 K8s / 未部署';
  if (legacy) {
    const web = slot.webPort ?? slot.port ?? 0;
    const api = slot.apiPort ?? 0;
    if (web > 0 || api > 0) reason = `本机端口 web=${web} api=${api}`;
    else reason = `compose 镜像标记 ${dep?.imageTag || composeProject}`;
  }
  return {
    env,
    legacy,
    reason,
    composeProject,
    hostDataDir,
    dataExists,
    dataApproxBytes: dataExists ? approxDirBytes(hostDataDir) : 0,
    webPort: slot.webPort ?? slot.port,
    apiPort: slot.apiPort,
    url: slot.url,
    deploymentId: slot.deploymentId,
    imageTag: dep?.imageTag,
  };
}

export function getModuleLegacyStatus(mod: Module): {
  test: LegacySlotInfo;
  prod: LegacySlotInfo;
  anyLegacy: boolean;
} {
  const test = describeLegacySlot(mod, 'test');
  const prod = describeLegacySlot(mod, 'prod');
  return { test, prod, anyLegacy: test.legacy || prod.legacy };
}

/** 迁移成功后停本机 compose 并刷新 nginx（保留 MODULE_DATA 宿主机副本作备份） */
export async function stopLegacyComposeAfterMigrate(
  mod: Module,
  env: DeployEnv,
  log: (line: string) => void
): Promise<void> {
  const projectName = composeProjectName(mod.name, env);
  const slot = env === 'test' ? mod.test : mod.prod;
  const workRoot = getWorkDir();
  const depId = slot.deploymentId;
  const cwd =
    depId && existsSync(join(workRoot, depId)) ? join(workRoot, depId) : workRoot;
  log(`[migrate] 停止本机 compose 项目 ${projectName}`);
  await stopComposeProject(projectName, cwd, log);
  regenerateNginxRoutes(log);
  log('[migrate] 已刷新 nginx；宿主机 MODULE_DATA 仍保留作备份，未删除');
}

export function ensureDataDirForMigrate(moduleName: string, env: DeployEnv): string {
  return ensureModuleDataDir(moduleName, env);
}

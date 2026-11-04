import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { db, getBaseDomain } from '../db/init.js';
import { getWorkDir } from '../config/paths.js';
import {
  appendDeploymentLog,
  getDeployment,
  getModule,
  getModuleGitSource,
  resolvePackageForDeploy,
  setModuleActiveSlot,
  updateDeploymentStatus,
} from './project.js';
import { validatePackageLayout, hasDeploySh } from './package-store.js';
import {
  composeFileArgs,
  ensureModuleDataDir,
  prepareModuleDataMount,
} from './module-data.js';
import {
  assertGitAvailable,
  cloneBranch,
  cloneCommit,
  detectGitProvider,
  redactCredentials,
  type GitSourceConfig,
} from './git-source.js';
import {
  buildPathPrefix,
  buildPublicUrl,
  composeProjectName,
  gatewayUpstreamHost,
  defaultModuleHost,
  isDomainOnlyMode,
  parseFrpWebHost,
  parseFrpWebPort,
  refreshGatewayCertificates,
  regenerateNginxRoutes,
  resolveAccessUrl,
  runShellCommand,
  stopComposeProject,
} from './routing.js';
import {
  ensureDefaultDomainsForModule,
  resolvePreferredPublicApiUrl,
  resolvePreferredPublicWebUrl,
} from './module-domains.js';
import { fixBuild, maxAutoFixAttempts, shouldUseAgentFixer } from './build-fixer.js';
import {
  isSseinfraRuntime,
  platformDeployToken,
  sseinfraGroupName,
  SseinfraClient,
} from './sseinfra-client.js';
import {
  abortableSleep,
  packageProgramLogs,
  packageProgramStatus,
  syncHostDataToPod,
  syncPackageAndStart,
  throwIfAborted,
  waitForGroupPod,
  waitGroupRolloutSettled,
  waitForHttpReady,
  resolveReadyTimeoutMs,
} from './sseinfra-pod.js';
import { ensureDataDirForMigrate, stopLegacyComposeAfterMigrate } from './legacy-migrate.js';
import {
  getModuleEnvVars,
  mergeDeployEnv,
  pushEnvToSseinfraGroup,
  writeRootDotEnv,
} from './module-env-config.js';
import { ensurePackageHasDeploySh } from './generate-deploy-sh.js';
import type { DeployEnv } from '../types.js';
import { nanoid } from 'nanoid';

/** 用户模块环境变量里 SDPY_READY_SKIP=1 时跳过部署后就绪探测（非 HTTP 服务用） */
function readySkipFlag(envVars: Record<string, string>): boolean {
  const v = (envVars.SDPY_READY_SKIP ?? '').trim();
  return /^(1|true|yes)$/i.test(v);
}

/** 部署后就绪探测：公网入口指向的 frp 端口必须真的有 HTTP 响应才算成功 */
async function waitFrpReady(
  frpWebUrl: string,
  opts: {
    log: (line: string) => void;
    signal?: AbortSignal;
    skip?: boolean;
    onCheck?: () => Promise<void> | void;
    /** 前端域名完整 URL（额外探测目标，用于验证“前端有内容”） */
    probeUrls?: string[];
    /** 严格模式：要求 HTTP 2xx 且响应体非空 */
    expectContent?: boolean;
  }
): Promise<void> {
  const port = parseFrpWebPort(frpWebUrl);
  // frp 隧道真实入口：宿主 nginx 230xx（ssl 化）↔ frps 原生 130xx，恒差 10000。
  // 就绪探测应从容器内直接探 frps 原生 HTTP 端口（host.docker.internal:130xx），
  // 它既真实反映应用是否监听，又能在容器内通达，且不依赖公网 nginx 子域路由是否已写。
  // 上游 host 统一用 gatewayUpstreamHost()（= GATEWAY_UPSTREAM_HOST，默认 host.docker.internal），
  // 与网关实际访问宿主的地址保持一致，避免在“宿主机裸跑 / 容器”之间来回切换硬编码。
  const upstreamHost = gatewayUpstreamHost();
  const frpsProbeUrl = `http://${upstreamHost}:${Math.max(port - 10000, 0)}/`;
  const probeUrls = Array.from(
    new Set([frpsProbeUrl, ...(opts.probeUrls ?? [])].filter(Boolean))
  );
  await waitForHttpReady(port, {
    log: opts.log,
    signal: opts.signal,
    onCheck: opts.onCheck,
    skip: opts.skip,
    probeUrls,
    expectContent: opts.expectContent,
    hosts: Array.from(
      new Set([parseFrpWebHost(frpWebUrl), gatewayUpstreamHost(), '127.0.0.1'])
    ),
  });
}

/** 用户已确认时：缺 deploy.sh 则在 worker 内 Agent 生成（尊重 abort） */
async function maybeGenerateDeploySh(
  deploymentId: string,
  moduleId: string,
  packageVersion: string | undefined,
  signal: AbortSignal,
  log: (line: string) => void
) {
  const dep = getDeployment(deploymentId);
  if (!dep || dep.source !== 'package') return;
  const pkg = resolvePackageForDeploy(moduleId, packageVersion);
  if (hasDeploySh(pkg.packagePath)) return;
  if (!dep.confirmAgentGenerate) {
    throw new Error('压缩包缺少 deploy.sh，且未确认使用 Agent 生成');
  }
  if (signal.aborted) throw new Error('已取消');
  log('[agent] 用户已确认：开始生成 deploy.sh（可在日志页取消）…');
  updateDeploymentStatus(deploymentId, 'building');
  const r = await ensurePackageHasDeploySh(moduleId, {
    packageVersion,
    signal,
    onEvent: (ev) => {
      if (ev.type === 'meta') log(`[agent] ${ev.message}`);
      if (ev.type === 'tool_call') log(`[agent] → ${ev.name}`);
      if (ev.type === 'tool_result') log(`[agent] ← ${ev.ok ? 'ok' : 'fail'} ${ev.name}`);
    },
  });
  log(`[agent] ${r.summary}`);
}

/** 用户配置（按 env 分槽）+ 平台键 → 写根 .env / 回传合并结果 */
function prepareUserAndPlatformEnv(
  moduleId: string,
  moduleName: string,
  env: DeployEnv,
  platformVars: Record<string, string>,
  opts?: { writeDir?: string; log?: (line: string) => void }
): Record<string, string> {
  const userVars = getModuleEnvVars(moduleId, env);
  const merged = mergeDeployEnv(userVars, platformVars);
  const n = Object.keys(userVars).length;
  opts?.log?.(
    n
      ? `[env] 加载 ${env} 环境用户变量 ${n} 个（与正式/测试配置分槽；平台键优先）`
      : `[env] ${env} 环境无用户变量（可在模块页配置）`
  );
  if (opts?.writeDir) {
    writeRootDotEnv(opts.writeDir, merged);
    opts.log?.(`[env] 已写入 ${opts.writeDir}/.env（根目录可读）`);
  }
  return merged;
}

const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_DEPLOYS) || 2);

// 部署队列：并发上限 + 同模块同环境串行（compose 项目名相同，避免互相冲突）
const queue: string[] = [];
const running = new Set<string>();
const activeModuleEnv = new Map<string, string>(); // `${moduleId}:${env}` -> deploymentId
const abortControllers = new Map<string, AbortController>(); // deploymentId -> AbortController
/** 本次是否新建组：仅新建失败才释放，避免打挂已有线上 */
const infraLeaseByDeploy = new Map<string, { group: string; releaseOnFail: boolean }>();

export function enqueueDeployment(deploymentId: string) {
  if (running.has(deploymentId) || queue.includes(deploymentId)) return;
  queue.push(deploymentId);
  pump();
}

function pump() {
  while (running.size < MAX_CONCURRENT) {
    const idx = queue.findIndex((id) => {
      const dep = getDeployment(id);
      if (!dep) return true; // 无效记录，丢弃
      const key = `${dep.moduleId}:${dep.env}`;
      return !activeModuleEnv.has(key);
    });
    if (idx === -1) break;
    const id = queue.splice(idx, 1)[0];
    const dep = getDeployment(id);
    if (!dep) continue;
    start(id, `${dep.moduleId}:${dep.env}`);
  }
}

function start(deploymentId: string, key: string) {
  running.add(deploymentId);
  activeModuleEnv.set(key, deploymentId);
  const ac = new AbortController();
  abortControllers.set(deploymentId, ac);
  const dep = getDeployment(deploymentId);
  // DEPLOY_RUNTIME=sseinfra：Git 与压缩包都走 K8s；compose：本机 docker
  const useInfra = Boolean(dep && isSseinfraRuntime());
  const runner = useInfra ? runSseinfraDeploy : runComposeDeploy;
  runner(deploymentId, ac.signal)
    .catch(async (e) => {
      const log = (line: string) => appendDeploymentLog(deploymentId, line);
      const msg = e instanceof Error ? e.message : String(e);
      const stack =
        e instanceof Error && e.stack
          ? e.stack.split('\n').slice(0, 8).join('\n')
          : '';
      if (ac.signal.aborted || getDeployment(deploymentId)?.status === 'cancelled') {
        await teardownPartial(deploymentId);
        log('[取消] 部署已取消');
        if (stack) log(`[取消] 堆栈摘要:\n${stack}`);
        if (useInfra && dep) {
          await releaseSseinfraGroupAfterFail(dep, log, 'cancelled');
        }
        updateDeploymentStatus(deploymentId, 'cancelled');
      } else {
        log(`[错误] ${msg}`);
        if (stack) log(`[错误] 堆栈摘要:\n${stack}`);
        log(
          `[错误] 上下文: deploymentId=${deploymentId} moduleId=${dep?.moduleId || '?'} env=${dep?.env || '?'} action=${dep?.action || '?'} platform=${process.platform}`
        );
        if (useInfra && dep) {
          await releaseSseinfraGroupAfterFail(dep, log, 'failed');
        } else {
          await teardownPartial(deploymentId);
        }
        updateDeploymentStatus(deploymentId, 'failed');
      }
    })
    .finally(() => {
      infraLeaseByDeploy.delete(deploymentId);
      running.delete(deploymentId);
      abortControllers.delete(deploymentId);
      if (activeModuleEnv.get(key) === deploymentId) activeModuleEnv.delete(key);
      pump();
    });
}

/** 取消排队中或运行中的部署 */
export function cancelDeployment(deploymentId: string): { ok: boolean; message: string } {
  const dep = getDeployment(deploymentId);
  if (!dep) return { ok: false, message: '部署记录不存在' };
  if (['success', 'failed', 'cancelled'].includes(dep.status)) {
    return { ok: false, message: '部署已结束，无法取消' };
  }
  const qi = queue.indexOf(deploymentId);
  if (qi !== -1) {
    queue.splice(qi, 1);
    updateDeploymentStatus(deploymentId, 'cancelled');
    appendDeploymentLog(deploymentId, '[取消] 部署尚未开始，已取消');
    return { ok: true, message: '已取消排队中的部署' };
  }
  const ac = abortControllers.get(deploymentId);
  if (ac) {
    ac.abort();
    updateDeploymentStatus(deploymentId, 'cancelled');
    appendDeploymentLog(deploymentId, '[取消] 已中断当前步骤（SSH/传包等子进程已终止）');
    return { ok: true, message: '已取消' };
  }
  // 服务重启后内存队列丢失，但 DB 仍为非终态
  updateDeploymentStatus(deploymentId, 'cancelled');
  appendDeploymentLog(deploymentId, '[取消] 部署进程已不在运行，已标记为取消');
  return { ok: true, message: '已取消（进程已不在运行）' };
}

async function teardownPartial(deploymentId: string) {
  const dep = getDeployment(deploymentId);
  if (!dep) return;
  const mod = getModule(dep.moduleId);
  if (!mod) return;
  if (isSseinfraRuntime()) {
    // 取消时由 releaseSseinfraGroupAfterFail 整组释放；此处仅作 compose 回退清理
    return;
  }
  const buildDir = join(getWorkDir(), deploymentId);
  try {
    await stopComposeProject(composeProjectName(mod.name, dep.env), buildDir);
  } catch {
    // 清理失败不阻断取消
  }
}

/**
 * 准备组容器：
 * - 默认复用已有组（不先删），避免迁移/重试把线上直接打挂
 * - SSEINFRA_FORCE_RECREATE=1 时先删再建
 * 仅「本次新建」的组在失败时自动释放
 */
async function ensureSseinfraGroupForDeploy(
  client: SseinfraClient,
  group: string,
  deploymentId: string,
  log: (line: string) => void
): Promise<void> {
  const cfg = await import('./sseinfra-settings.js').then((m) => m.getSseinfraRuntimeConfig());
  const force =
    (process.env.SSEINFRA_FORCE_RECREATE || '').trim() === '1' ||
    /^(true|yes)$/i.test((process.env.SSEINFRA_FORCE_RECREATE || '').trim());

    log(
      `[sseinfra] 准备组 ${group} · 面板=${cfg.baseUrl} · 账号=${cfg.username || '(未配置)'} · 规格 cpu=${cfg.defaultCpu} mem=${cfg.defaultMem} storage=${cfg.defaultStorage} · forceRecreate=${force}`
    );
    if (!cfg.username?.trim()) {
      log('[sseinfra] 警告：未配置 SSEINFRA_USERNAME，默认 admin；面板须用 admin + SSE_Market 登录才有建组权限');
    }

  const before = await client.getGroup(group);
  let releaseOnFail = !before.exists;

  if (force && before.exists) {
    log(`[sseinfra] SSEINFRA_FORCE_RECREATE=1：先释放旧组再重建`);
    const del = await client.deleteGroup(group);
    if (del.deleted) {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const g = await client.getGroup(group);
        if (!g.exists) {
          log(`[sseinfra] 旧组已释放（轮询 ${i + 1} 次）`);
          break;
        }
        if (i % 5 === 4) log(`[sseinfra] 等待释放… ${i + 1}/30`);
      }
    }
    releaseOnFail = true;
  } else if (before.exists) {
    log(
      `[sseinfra] 复用已有组（running=${before.running} web=${before.webUrl || '无'}）；失败时不删组，避免线上中断`
    );
  } else {
    log(`[sseinfra] 组不存在，将新建；若本次失败会自动释放`);
  }

  await client.ensureGroup(group);
  const listed = await client.listGroups();
  const after = await client.getGroup(group);
  log(
    `[sseinfra] 组就绪 exists=${after.exists} running=${after.running} listed=${listed.includes(group.toLowerCase())} webUrl=${after.webUrl || '(待解析)'} ssh=${after.sshHint || '(无)'} releaseOnFail=${releaseOnFail}`
  );
  if (!after.exists || !listed.includes(group.toLowerCase())) {
    throw new Error(
      `sseinfra 组 ${group} 未能通过 API 创建（面板列表未出现）。请检查管理台 sseinfra 账号是否有建组权限/配额。`
    );
  }
  infraLeaseByDeploy.set(deploymentId, { group, releaseOnFail });
}

/** 失败/取消：仅释放「本次新建」的组；已有线上组保留 */
async function releaseSseinfraGroupAfterFail(
  dep: {
    id: string;
    moduleId: string;
    env: DeployEnv;
    operatorId?: string;
    operatorName?: string;
  },
  log: (line: string) => void,
  reason: 'failed' | 'cancelled'
): Promise<void> {
  const mod = getModule(dep.moduleId);
  if (!mod) return;
  const group = sseinfraGroupName(mod.name, dep.env);
  const lease = infraLeaseByDeploy.get(dep.id);
  const releaseOnFail = lease?.releaseOnFail ?? false;

  if (!releaseOnFail) {
    log(
      `[sseinfra] 部署${reason === 'failed' ? '失败' : '取消'}：保留组 ${group}（复用已有组 / 未新建），不清理线上地址`
    );
    return;
  }

  try {
    const client = new SseinfraClient();
    const r = await client.deleteGroup(group);
    if (r.deleted) {
      log(
        `[sseinfra] 部署${reason === 'failed' ? '失败' : '取消'}：已释放本次新建组 ${group}（模块=${mod.name} env=${dep.env}）`
      );
    } else {
      log(`[sseinfra] 组 ${group} 不存在，无需释放（模块=${mod.name} env=${dep.env}）`);
    }
    try {
      const { writeAudit } = await import('./audit.js');
      writeAudit({
        action: 'sseinfra.group.delete',
        actorId: dep.operatorId ?? null,
        targetType: 'sseinfra_group',
        targetId: group,
        summary: `部署${reason === 'failed' ? '失败' : '取消'}自动释放新建组 ${group}`,
        meta: { moduleId: mod.id, moduleName: mod.name, env: dep.env, reason },
      });
    } catch {
      /* ignore */
    }
  } catch (e) {
    log(
      `[sseinfra] 自动释放组失败：${e instanceof Error ? e.message : String(e)}（请到面板手动删 ${group}）`
    );
  }
  try {
    setModuleActiveSlot(mod.id, dep.env, {
      deploymentId: '',
      webPort: 0,
      apiPort: 0,
      url: '',
      apiUrl: '',
    });
  } catch {
    /* ignore */
  }
}

/** K8s 无 Pod 时删组并通过面板 API 重建一次 */
async function waitGroupPodOrRecreate(
  client: SseinfraClient,
  group: string,
  log: (line: string) => void,
  signal?: AbortSignal
): Promise<string> {
  try {
    return await waitForGroupPod(group, log, { timeoutMs: 45_000, signal });
  } catch (first) {
    throwIfAborted(signal);
    const msg = first instanceof Error ? first.message : String(first);
    log(`[sseinfra] K8s 仍无 Pod，尝试删组并 API 重建：${msg.slice(0, 160)}`);
    await client.deleteGroup(group);
    throwIfAborted(signal);
    await client.ensureGroup(group);
    const listed = await client.listGroups();
    if (!listed.includes(group.toLowerCase())) {
      throw new Error(`重建组 ${group} 后面板列表仍无该组，请检查 sseinfra 账号（须 admin）与建组权限`);
    }
    await client.waitRunning(group);
    return await waitForGroupPod(group, log, { signal });
  }
}

async function prepareMigrateData(
  deploymentId: string,
  mod: { id: string; name: string },
  env: DeployEnv,
  group: string,
  client: SseinfraClient,
  log: (line: string) => void
) {
  const dep = getDeployment(deploymentId);
  if (!dep || dep.action !== 'migrate') return;
  log('[migrate] 同步本机 MODULE_DATA → 组容器…');
  const hostDir = ensureDataDirForMigrate(mod.name, env);
  await syncHostDataToPod({ group, localDir: hostDir, log });
  try {
    await client.setEnv(group, 'SDPY_DATA_DIR', '/home/cloud/data');
    await client.setEnv(group, 'DATA_DIR', '/home/cloud/data');
    log('[migrate] 已设置组环境变量 SDPY_DATA_DIR=/home/cloud/data');
  } catch (e) {
    log(`[migrate] 设置组 env 失败（可忽略）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function finishMigrateIfNeeded(
  deploymentId: string,
  mod: { id: string; name: string; test: unknown; prod: unknown },
  env: DeployEnv,
  log: (line: string) => void
) {
  const dep = getDeployment(deploymentId);
  if (!dep || dep.action !== 'migrate') return;
  const full = getModule(mod.id);
  if (!full) return;
  await stopLegacyComposeAfterMigrate(full, env, log);
}

/** 远程：sseinfra 建组 +（Git clone 或 压缩包同步）+ deploy.sh */
async function runSseinfraDeploy(deploymentId: string, signal: AbortSignal) {
  const dep = getDeployment(deploymentId);
  if (!dep) return;
  const mod = getModule(dep.moduleId);
  if (!mod) throw new Error('模块不存在');

  if (dep.source === 'package') {
    await runSseinfraPackageDeploy(deploymentId, signal);
    return;
  }
  if (dep.source !== 'git') {
    throw new Error('未知部署来源');
  }

  const env: DeployEnv = dep.env;
  const log = (line: string) => appendDeploymentLog(deploymentId, line);
  const group = sseinfraGroupName(mod.name, env);
  const lockKey = `${dep.moduleId}:${env}`;

  const git = getModuleGitSource(mod.id);
  if (!git?.repoUrl) throw new Error('请先在模块中配置 Git 仓库地址（Gitee/GitHub HTTPS）');

  const branch = dep.branch || git.defaultBranch || 'main';
  const token = platformDeployToken(git.token);

  if (!acquireDeployLock(lockKey, deploymentId)) {
    throw new Error('该模块当前环境正在被其他实例部署，请稍后重试');
  }

  try {
    if (signal.aborted) throw new Error('已取消');
    updateDeploymentStatus(deploymentId, 'cloning');
    log(`[sseinfra] Git 部署 · 组=${group} · env=${env}`);
    log(`[sseinfra] 仓库 ${git.repoUrl} · 分支 ${branch}${token ? ' · 已带 token' : ''}`);

    const buildDir = join(getWorkDir(), deploymentId);
    const deployName = `${mod.name}-${env}`;
    const programId = nanoid(10);

    const client = new SseinfraClient();
    await client.login();
    log('[sseinfra] 已登录控制面板');

    if (signal.aborted) throw new Error('已取消');
    updateDeploymentStatus(deploymentId, 'building');
    await ensureSseinfraGroupForDeploy(client, group, deploymentId, log);
    try {
      const { writeAudit } = await import('./audit.js');
      writeAudit({
        action: 'sseinfra.group.create',
        actorId: dep.operatorId,
        targetType: 'sseinfra_group',
        targetId: group,
        summary: `${dep.operatorName || dep.operatorId} 部署创建组 ${group}`,
        meta: { moduleId: mod.id, moduleName: mod.name, env, deploymentId, source: 'git' },
      });
    } catch {
      /* ignore audit errors */
    }
    const info = await client.waitRunning(group);
    log(`[sseinfra] Pod Running · Web ${info.webUrl || '(解析中)'}`);

    // 下载 Git 仓库到本机，复用「压缩包 → kubectl cp → supervisord」链路，
    // 不再依赖面板 addDeploy/runDeploy（面板不写 supervisord program 配置，导致 UNLOADED）。
    await assertGitAvailable(log);
    const provider = detectGitProvider(git.repoUrl);
    const gitCfg: GitSourceConfig = { repoUrl: git.repoUrl, provider, username: git.username, token };
    if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });
    mkdirSync(buildDir, { recursive: true });
    const commitRef = dep.commitSha
      ? await cloneCommit(gitCfg, dep.commitSha, buildDir, log, signal)
      : await cloneBranch(gitCfg, branch, buildDir, log, signal);
    log(`Git 提交: ${commitRef} · 仓库: ${redactCredentials(git.repoUrl)}`);
    updateDeploymentStatus(deploymentId, 'unpacking', { commitSha: commitRef });
    if (!hasDeploySh(buildDir)) {
      throw new Error('Git 仓库根目录须包含 deploy.sh（K8s 组内无 Docker，无法直接跑 compose）');
    }
    log(`[git-deploy] 仓库已下载到本机 ${buildDir}（含 deploy.sh）`);

    await prepareMigrateData(deploymentId, mod, env, group, client, log);

    // 「仅子域名」模式：先登记默认域名（prod={module}.base / test=test.{module}.base），
    // 这样 PUBLIC_BASE 注入的就是子域名，应用按根路径构建前端
    if (isDomainOnlyMode(mod.pathMode)) {
      ensureDefaultDomainsForModule(mod.id, mod.name, env, dep.operatorId);
      log(`[domain] 已确保默认子域名 ${defaultModuleHost(mod.name, env)}`);
    }
    const domain = getBaseDomain();
    const publicBase = buildPathPrefix(mod.name, env, 'web', mod.pathMode);
    const apiPublicBase = buildPathPrefix(mod.name, env, 'api', mod.pathMode);
    const pathPublicUrl = `https://${domain}${publicBase}`;
    const pathApiUrl = `https://${domain}${apiPublicBase}`;
    const preferredWeb = resolvePreferredPublicWebUrl(mod.id, env, pathPublicUrl);
    const preferredApi = resolvePreferredPublicApiUrl(mod.id, env, pathApiUrl);
    const platformEnv = {
      PORT: '8080',
      SDPY_ENV: env,
      SDPY_MODULE: mod.name,
      SDPY_DATA_DIR: '/home/cloud/data',
      DATA_DIR: '/home/cloud/data',
      SDPY_PUBLIC_BASE: publicBase,
      SDPY_API_PUBLIC_BASE: apiPublicBase,
      SDPY_PUBLIC_URL: preferredWeb,
      SDPY_API_PUBLIC_URL: preferredApi,
      // 常见应用（如 imagebed）用 PUBLIC_BASE 拼资源直链
      PUBLIC_BASE: preferredWeb,
      PRIORITY: mod.priority,
    };
    const mergedEnv = prepareUserAndPlatformEnv(mod.id, mod.name, env, platformEnv, {
      writeDir: buildDir,
      log,
    });
    await pushEnvToSseinfraGroup(client, group, mergedEnv, log);

    if (signal.aborted) throw new Error('已取消');
    // 写 env 会触发面板 rollout restart，Pod 被整体替换；等新 Pod 稳定后再 cp，
    // 否则可能打进正在终止的旧 Pod（表现为 env 阶段与 cp 阶段 Pod 名不一致）。
    await waitGroupRolloutSettled(group, log, { signal });
    updateDeploymentStatus(deploymentId, 'deploying', {
      imageTag: `infra-git:${group}:${programId}`,
    });

    // 复用「压缩包 → kubectl cp → Pod 内 supervisord」链路：
    // 面板不生成 supervisord program 配置，导致 UNLOADED / no such process。
    // Git 部署改为：本机 clone → tar → kubectl cp → 写 supervisord 配置并 start。
    await syncPackageAndStart({
      group,
      deployName,
      programId,
      localDir: buildDir,
      env: mergedEnv,
      log,
      signal,
    });

    let ok = false;
    // 探测容忍窗口（约 30s）：k3s API 负载高时偶发拒连，不应直接判死
    let probeFailures = 0;
    const maxProbeFailures = 10;
    let lastProbeErr = '';
    for (let i = 0; i < 60; i++) {
      throwIfAborted(signal);
      await abortableSleep(3000, signal);
      let st = '';
      try {
        st = await packageProgramStatus(group, programId, { signal });
        probeFailures = 0;
      } catch (e) {
        probeFailures += 1;
        lastProbeErr = e instanceof Error ? e.message : String(e);
        if (probeFailures >= maxProbeFailures) {
          throw new Error(
            `连续 ${probeFailures} 次探测 supervisord 状态失败（疑似 k3s API 抖动或 SSH 故障）：${lastProbeErr.slice(0, 200)}`
          );
        }
        log(`[git-deploy] 状态探测暂时失败 ${probeFailures}/${maxProbeFailures}，继续等待：${lastProbeErr.slice(0, 120)}`);
        continue;
      }
      const state = (st || '').toUpperCase();
      log(`[git-deploy] ${st.slice(0, 120)}`);
      if (/RUNNING/i.test(state)) {
        ok = true;
        const logs = await safeProgramLogs(group, deployName, signal);
        if (logs) {
          for (const line of logs.split(/\r?\n/).filter(Boolean).slice(-30)) log(`[pod] ${line}`);
        }
        break;
      }
      const logs = await safeProgramLogs(group, deployName, signal);
      if (logs) {
        for (const line of logs.split(/\r?\n/).filter(Boolean).slice(-20)) log(`[pod] ${line}`);
      }
      if (/FATAL|BACKOFF|EXITED|FAILED/i.test(state)) {
        throw new Error(`进程异常: ${st}`);
      }
    }
    if (!ok) throw new Error('等待 supervisord RUNNING 超时');

    const finalInfo = await client.getGroup(group);
    const frpWebUrl = finalInfo.webUrl || info.webUrl;
    if (!frpWebUrl) throw new Error('未能解析组 frp Web 地址');

    // 就绪探测：supervisord RUNNING ≠ 应用已监听；未就绪就切网关会让公网 502。
    // 追加探测前端域名（publicUrl）并要求“有内容”，避免测试环境因应用未真正拉起而伪成功。
    const pathUrl = buildPublicUrl(mod.name, env, 'web', mod.pathMode);
    const publicUrl = resolvePreferredPublicWebUrl(mod.id, env, pathUrl);
    await waitFrpReady(frpWebUrl, {
      log,
      signal,
      skip: readySkipFlag(mergedEnv),
      probeUrls: [publicUrl],
      expectContent: true,
      onCheck: async () => {
        let st = '';
        try {
          st = await packageProgramStatus(group, programId, { signal });
        } catch {
          return; // 瞬时 k3s/SSH 抖动：本轮跳过退出判定，由 HTTP 探测兜底
        }
        if (/FATAL|EXITED|FAILED/i.test(st)) {
          throw new Error(`应用进程已退出，无法就绪: ${st}`);
        }
      },
    });

    // 迁移：先停旧 compose（须在覆盖 active slot 之前读旧 deploymentId）
    await finishMigrateIfNeeded(deploymentId, mod, env, log);

    await publishSseinfraToGateway({
      moduleId: mod.id,
      moduleName: mod.name,
      pathMode: mod.pathMode,
      env,
      deploymentId,
      frpWebUrl,
      sshHint: finalInfo.sshHint || info.sshHint,
      imageTag: `infra-git:${group}:${programId}`,
      commitSha: commitRef,
      log,
    });
  } finally {
    releaseDeployLock(lockKey, deploymentId);
  }
}

/** 容错取 Pod 日志：瞬时 SSH/k3s 抖动时返回空，不打断部署流程 */
async function safeProgramLogs(
  group: string,
  deployName: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    return await packageProgramLogs(group, deployName, { signal });
  } catch {
    return '';
  }
}

/** 压缩包 → K8s：建组后 kubectl 同步目录，supervisord 跑 deploy.sh */
async function runSseinfraPackageDeploy(deploymentId: string, signal: AbortSignal) {
  const dep = getDeployment(deploymentId);
  if (!dep) return;
  const mod = getModule(dep.moduleId);
  if (!mod) throw new Error('模块不存在');

  const env: DeployEnv = dep.env;
  const log = (line: string) => appendDeploymentLog(deploymentId, line);
  const group = sseinfraGroupName(mod.name, env);
  const lockKey = `${dep.moduleId}:${env}`;
  const deployName = `${mod.name}-${env}`;
  const programId = nanoid(10);

  if (!acquireDeployLock(lockKey, deploymentId)) {
    throw new Error('该模块当前环境正在被其他实例部署，请稍后重试');
  }

  const workRoot = getWorkDir();
  const buildDir = join(workRoot, deploymentId);

  try {
    if (signal.aborted) throw new Error('已取消');
    updateDeploymentStatus(deploymentId, 'unpacking');
    if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });
    mkdirSync(buildDir, { recursive: true });

    const pkg = resolvePackageForDeploy(dep.moduleId, dep.commitSha || undefined);
    if (!pkg.packagePath || !existsSync(pkg.packagePath)) {
      throw new Error('模块压缩包不存在，请重新上传');
    }
    await maybeGenerateDeploySh(deploymentId, mod.id, dep.commitSha || undefined, signal, log);
    log(`[k8s-pkg] 准备包 ${pkg.version} → 组 ${group}`);
    cpSync(pkg.packagePath, buildDir, { recursive: true });

    if (!hasDeploySh(buildDir)) {
      throw new Error(
        'K8s 压缩包须含根目录 deploy.sh（容器内无 Docker）。请确认使用 Agent 生成，或上传模板包 / 改用 Git。'
      );
    }

    if (signal.aborted) throw new Error('已取消');
    updateDeploymentStatus(deploymentId, 'building');
    const client = new SseinfraClient();
    await client.login();
    await ensureSseinfraGroupForDeploy(client, group, deploymentId, log);
    try {
      const { writeAudit } = await import('./audit.js');
      writeAudit({
        action: 'sseinfra.group.create',
        actorId: dep.operatorId,
        targetType: 'sseinfra_group',
        targetId: group,
        summary: `${dep.operatorName || dep.operatorId} 包部署创建组 ${group}`,
        meta: { moduleId: mod.id, moduleName: mod.name, env, deploymentId, source: 'package' },
      });
    } catch {
      /* ignore */
    }
    const info = await client.waitRunning(group);
    log(`[k8s-pkg] 面板 Running · ${info.webUrl || '(无 Web 地址)'}`);
    const podName = await waitGroupPodOrRecreate(client, group, log, signal);
    log(`[k8s-pkg] K8s Pod 就绪 · ${podName}`);

    await prepareMigrateData(deploymentId, mod, env, group, client, log);

    if (signal.aborted) throw new Error('已取消');
    updateDeploymentStatus(deploymentId, 'deploying', {
      imageTag: `infra-pkg:${group}:${programId}`,
    });

    // 「仅子域名」模式：先登记默认域名（prod={module}.base / test=test.{module}.base），
    // 这样 PUBLIC_BASE 注入的就是子域名，应用按根路径构建前端
    if (isDomainOnlyMode(mod.pathMode)) {
      ensureDefaultDomainsForModule(mod.id, mod.name, env, dep.operatorId);
      log(`[domain] 已确保默认子域名 ${defaultModuleHost(mod.name, env)}`);
    }
    const domain = getBaseDomain();
    const publicBase = buildPathPrefix(mod.name, env, 'web', mod.pathMode);
    const apiPublicBase = buildPathPrefix(mod.name, env, 'api', mod.pathMode);
    const pathPublicUrl = `https://${domain}${publicBase}`;
    const pathApiUrl = `https://${domain}${apiPublicBase}`;
    const preferredWeb = resolvePreferredPublicWebUrl(mod.id, env, pathPublicUrl);
    const preferredApi = resolvePreferredPublicApiUrl(mod.id, env, pathApiUrl);
    const platformEnv = {
      PORT: '8080',
      SDPY_ENV: env,
      SDPY_MODULE: mod.name,
      SDPY_DATA_DIR: '/home/cloud/data',
      DATA_DIR: '/home/cloud/data',
      SDPY_PUBLIC_BASE: publicBase,
      SDPY_API_PUBLIC_BASE: apiPublicBase,
      SDPY_PUBLIC_URL: preferredWeb,
      SDPY_API_PUBLIC_URL: preferredApi,
      PUBLIC_BASE: preferredWeb,
      PRIORITY: mod.priority,
    };
    const mergedEnv = prepareUserAndPlatformEnv(mod.id, mod.name, env, platformEnv, {
      writeDir: buildDir,
      log,
    });
    await pushEnvToSseinfraGroup(client, group, mergedEnv, log);

    // 写 env 会触发面板 rollout restart，Pod 被整体替换；等新 Pod 稳定后再 cp，
    // 否则可能打进正在终止的旧 Pod（表现为 env 阶段与 cp 阶段 Pod 名不一致）。
    await waitGroupRolloutSettled(group, log, { signal });

    await syncPackageAndStart({
      group,
      deployName,
      programId,
      localDir: buildDir,
      env: mergedEnv,
      log,
      signal,
    });

    let ok = false;
    // 连续探测失败容忍窗口（约 30s）：k3s API 在负载高时偶发拒连/列表短暂为空，不应直接判死
    let probeFailures = 0;
    const maxProbeFailures = 10;
    let lastProbeErr = '';
    for (let i = 0; i < 60; i++) {
      throwIfAborted(signal);
      await abortableSleep(3000, signal);
      let st = '';
      try {
        st = await packageProgramStatus(group, programId, { signal });
        probeFailures = 0;
      } catch (e) {
        if (e instanceof Error && e.message === '已取消') throw e;
        probeFailures += 1;
        lastProbeErr = e instanceof Error ? e.message : String(e);
        if (probeFailures >= maxProbeFailures) {
          throw new Error(
            `连续 ${probeFailures} 次探测 supervisord 状态失败（疑似 k3s API 抖动或 SSH 故障）：${lastProbeErr.slice(0, 200)}`
          );
        }
        log(
          `[k8s] 状态探测暂时失败 ${probeFailures}/${maxProbeFailures}，继续等待：${lastProbeErr.slice(0, 120)}`
        );
        continue;
      }
      log(`[k8s-pkg] ${st.slice(0, 120)}`);
      if (/RUNNING/i.test(st)) {
        ok = true;
        const logs = await safeProgramLogs(group, deployName, signal);
        if (logs) {
          for (const line of logs.split(/\r?\n/).filter(Boolean).slice(-30)) log(`[pod] ${line}`);
        }
        break;
      }
      const logs = await safeProgramLogs(group, deployName, signal);
      if (logs) {
        for (const line of logs.split(/\r?\n/).filter(Boolean).slice(-20)) log(`[pod] ${line}`);
      }
      if (/FATAL|BACKOFF|EXITED|FAILED/i.test(st)) {
        throw new Error(`进程异常: ${st}`);
      }
    }
    if (!ok) throw new Error('等待 RUNNING 超时');

    const finalInfo = await client.getGroup(group);
    const frpWebUrl = finalInfo.webUrl || info.webUrl;
    if (!frpWebUrl) throw new Error('未能解析组 frp Web 地址');

    // 就绪探测：supervisord RUNNING 只说明 deploy.sh 起来了，
    // 应用可能还在编译（此前就因直接置 success 导致公网 502）。
    // 追加探测前端域名（publicUrl）并要求“有内容”，避免测试环境因应用未真正拉起而伪成功。
    const pathUrl = buildPublicUrl(mod.name, env, 'web', mod.pathMode);
    const publicUrl = resolvePreferredPublicWebUrl(mod.id, env, pathUrl);
    await waitFrpReady(frpWebUrl, {
      log,
      signal,
      skip: readySkipFlag(mergedEnv),
      probeUrls: [publicUrl],
      expectContent: true,
      onCheck: async () => {
        let st = '';
        try {
          st = await packageProgramStatus(group, programId, { signal });
        } catch {
          return; // 瞬时 k3s/SSH 抖动：本轮跳过退出判定，由 HTTP 探测兜底
        }
        if (/FATAL|EXITED|FAILED/i.test(st)) {
          throw new Error(`应用进程已退出，无法就绪: ${st}`);
        }
      },
    });

    await finishMigrateIfNeeded(deploymentId, mod, env, log);

    await publishSseinfraToGateway({
      moduleId: mod.id,
      moduleName: mod.name,
      pathMode: mod.pathMode,
      env,
      deploymentId,
      frpWebUrl,
      sshHint: finalInfo.sshHint || info.sshHint,
      imageTag: `infra-pkg:${group}:${programId}`,
      commitSha: pkg.version,
      log,
    });
  } finally {
    releaseDeployLock(lockKey, deploymentId);
  }
}

// —— 跨实例锁：用 deploy_locks 表对 `${moduleId}:${env}` 做进程间互斥 ——

function acquireDeployLock(key: string, deploymentId: string): boolean {
  try {
    db.prepare('DELETE FROM deploy_locks WHERE deployment_id = ?').run(deploymentId);
    const claim = db.transaction(() => {
      const existing = db
        .prepare('SELECT deployment_id FROM deploy_locks WHERE key = ?')
        .get(key) as { deployment_id: string } | undefined;
      if (existing && existing.deployment_id !== deploymentId) return false;
      db.prepare(
        'INSERT OR REPLACE INTO deploy_locks (key, deployment_id, locked_at) VALUES (?, ?, ?)'
      ).run(key, deploymentId, new Date().toISOString());
      return true;
    });
    return claim.immediate();
  } catch {
    return false;
  }
}

function releaseDeployLock(key: string, deploymentId: string) {
  try {
    db.prepare('DELETE FROM deploy_locks WHERE key = ? AND deployment_id = ?').run(key, deploymentId);
  } catch {
    // 忽略
  }
}

/**
 * sseinfra 成功后：frp 端口写入 active slot → 路径 + Host 网关 → reload。
 * 对外主 URL：若配置了主域名则用 https://{host}，否则仍用路径 URL。
 */
async function publishSseinfraToGateway(opts: {
  moduleId: string;
  moduleName: string;
  pathMode?: string;
  env: DeployEnv;
  deploymentId: string;
  frpWebUrl: string;
  sshHint?: string;
  imageTag: string;
  commitSha: string;
  log: (line: string) => void;
}): Promise<{ publicUrl: string; publicApiUrl: string; frpPort: number }> {
  const live = getDeployment(opts.deploymentId);
  if (!live || live.status === 'cancelled') {
    throw new Error('已取消');
  }
  const { moduleName, env, frpWebUrl, log } = opts;
  const frpPort = parseFrpWebPort(frpWebUrl);
  const pathUrl = buildPublicUrl(moduleName, env, 'web', opts.pathMode);
  const publicUrl = resolvePreferredPublicWebUrl(opts.moduleId, env, pathUrl);
  const publicApiUrl = buildPublicUrl(moduleName, env, 'api', opts.pathMode);
  // 单端口 8080：web / api 路径都指到同一 frp 端口
  updateDeploymentStatus(opts.deploymentId, 'success', {
    url: publicUrl,
    apiUrl: publicApiUrl,
    port: frpPort,
    apiPort: frpPort,
    imageTag: opts.imageTag,
    commitSha: opts.commitSha,
  });
  setModuleActiveSlot(opts.moduleId, env, {
    deploymentId: opts.deploymentId,
    webPort: frpPort,
    apiPort: frpPort,
    url: publicUrl,
    apiUrl: publicApiUrl,
  });
  log(
    `[gateway] 提取上游 ${frpWebUrl} → 端口 ${frpPort}；路径 ${buildPathPrefix(moduleName, env, 'web', opts.pathMode)}/；主访问 ${publicUrl}`
  );
  regenerateNginxRoutes(log);
  // 多级子域名（如 test.xxx.base）不在通配符证书内，需单独签发后再刷一次路由
  await refreshGatewayCertificates(log);
  log(`部署成功 [${env}] · ${publicUrl}`);
  log(`API 路径: ${publicApiUrl}（与 Web 同上游 :${frpPort}）`);
  if (opts.sshHint) log(`SSH: ${opts.sshHint}`);
  return { publicUrl, publicApiUrl, frpPort };
}

function recordFix(deploymentId: string, attempts: number, fixedByAgent: boolean) {
  db.prepare('UPDATE deployments SET fix_attempts = ?, fixed_by_agent = ? WHERE id = ?').run(
    attempts,
    fixedByAgent ? 1 : 0,
    deploymentId
  );
}

function writeEnvFile(dir: string, vars: Record<string, string | number>): string {
  const path = join(dir, '.env.sdpy');
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('\n');
  writeFileSync(path, `${body}\n`, 'utf8');
  return path;
}

async function assertDockerAvailable(log: (line: string) => void): Promise<void> {
  try {
    await runShellCommand(process.cwd(), 'docker compose version', log);
  } catch {
    throw new Error(
      '本机未检测到 Docker Compose（命令 docker compose version 失败）。请安装 Docker 并确保当前用户可执行 docker 命令后再部署。'
    );
  }
}

async function runComposeDeploy(deploymentId: string, signal: AbortSignal) {
  const dep = getDeployment(deploymentId);
  if (!dep) return;
  const mod = getModule(dep.moduleId);
  if (!mod) throw new Error('模块不存在');

  const env: DeployEnv = dep.env;
  const log = (line: string) => appendDeploymentLog(deploymentId, line);
  const workRoot = getWorkDir();
  const buildDir = join(workRoot, deploymentId);
  const projectName = composeProjectName(mod.name, env);
  const noCache = dep.noCache || dep.branch.includes('nocache');
  const lockKey = `${dep.moduleId}:${env}`;

  if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  let commitRef = dep.commitSha;

  try {
    await assertDockerAvailable(log);

    if (dep.source === 'git') {
      updateDeploymentStatus(deploymentId, 'cloning');
      const git = getModuleGitSource(mod.id);
      if (!git?.repoUrl) throw new Error('模块未配置 Git 仓库地址');
      const branch = dep.branch || git.defaultBranch || 'main';
      const provider = detectGitProvider(git.repoUrl);
      await assertGitAvailable(log);
      if (dep.action === 'promote') {
        log(`[晋升] 测试 → 正式，源部署: ${dep.sourceDeploymentId ?? '-'}`);
      } else if (dep.action === 'rollback') {
        log(`[回滚] 恢复到提交 ${dep.commitSha || '-'}`);
      }
      log(`[${env}] 克隆 Git 仓库 ${provider}/${dep.commitSha && dep.action === 'rollback' ? dep.commitSha : branch}`);
      const cfg = { repoUrl: git.repoUrl, provider, username: git.username, token: git.token };
      if (dep.action === 'rollback' && dep.commitSha) {
        commitRef = await cloneCommit(cfg, dep.commitSha, buildDir, log, signal);
      } else {
        commitRef = await cloneBranch(cfg, branch, buildDir, log, signal);
      }
      validatePackageLayout(buildDir, 'compose');
      log(`Git 提交: ${commitRef} · 仓库: ${redactCredentials(git.repoUrl)}`);
      updateDeploymentStatus(deploymentId, 'building', { commitSha: commitRef });
    } else {
      updateDeploymentStatus(deploymentId, 'unpacking');
      if (dep.action === 'promote') {
        log(`[晋升] 测试 → 正式，源部署: ${dep.sourceDeploymentId ?? '-'}`);
      } else if (dep.action === 'rollback') {
        log(`[回滚] 恢复到版本 ${dep.commitSha || '-'}`);
      }
      const pkg = resolvePackageForDeploy(dep.moduleId, dep.commitSha || undefined);
      if (!pkg.packagePath || !existsSync(pkg.packagePath)) {
        throw new Error('模块压缩包不存在，请重新上传');
      }
      log(`[${env}] 准备部署目录 ${buildDir}`);
      cpSync(pkg.packagePath, buildDir, { recursive: true });
      log(`使用包版本: ${pkg.version} (${'fileName' in pkg ? pkg.fileName : ''})`);
      updateDeploymentStatus(deploymentId, 'building');
    }

    const webPort = dep.port;
    const apiPort = dep.apiPort || dep.port + 1;
    const publicBase = buildPathPrefix(mod.name, env, 'web', mod.pathMode);
    const apiPublicBase = buildPathPrefix(mod.name, env, 'api', mod.pathMode);
    const domain = getBaseDomain();
    const pathPublicUrl = `https://${domain}${publicBase}`;
    const pathApiUrl = `https://${domain}${apiPublicBase}`;
    const preferredWeb = resolvePreferredPublicWebUrl(mod.id, env, pathPublicUrl);
    const preferredApi = resolvePreferredPublicApiUrl(mod.id, env, pathApiUrl);
    const moduleDataDir = ensureModuleDataDir(mod.name, env);
    log(`模块数据目录: ${moduleDataDir}（不存在已自动创建，挂载到容器 /data）`);
    const { composeFiles } = prepareModuleDataMount(buildDir, moduleDataDir);

    const platformEnv = {
      SDPY_ENV: env,
      SDPY_MODULE: mod.name,
      WEB_HOST_PORT: String(webPort),
      API_HOST_PORT: String(apiPort),
      SDPY_PUBLIC_BASE: publicBase,
      SDPY_API_PUBLIC_BASE: apiPublicBase,
      SDPY_PUBLIC_URL: preferredWeb,
      SDPY_API_PUBLIC_URL: preferredApi,
      SDPY_DATA_DIR: moduleDataDir,
      COMPOSE_PROJECT_NAME: projectName,
      PRIORITY: mod.priority,
    };
    const mergedEnv = prepareUserAndPlatformEnv(mod.id, mod.name, env, platformEnv, {
      writeDir: buildDir,
      log,
    });
    writeEnvFile(buildDir, mergedEnv);

    // 跨实例互斥：同模块同环境同一时刻只允许一个构建
    if (!acquireDeployLock(lockKey, deploymentId)) {
      throw new Error('该模块当前环境正在被其他实例部署，请稍后重试');
    }

    const buildFlag = noCache ? '--build --no-cache' : '--build';
    const fileArgs = composeFileArgs(composeFiles);
    const composeCmd = `docker compose -p ${projectName} ${fileArgs} --env-file .env.sdpy up -d ${buildFlag} --force-recreate`;

    const maxFix = shouldUseAgentFixer(dep) ? maxAutoFixAttempts() : 0;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 1 + maxFix; attempt++) {
      if (signal.aborted) throw new Error('已取消');
      log(`执行: ${composeCmd}`);
      try {
        await runShellCommand(buildDir, composeCmd, log, { signal });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (signal.aborted) throw e;
        if (attempt > maxFix) throw e;
        const logTail = (getDeploymentLogs(deploymentId) ?? '').split('\n').slice(-120).join('\n');
        log(`[Agent] 构建失败，尝试自动修复（第 ${attempt}/${maxFix} 次）`);
        try {
          const res = await fixBuild({ buildDir, logTail });
          if (!res.changed) {
            log(`[Agent] ${res.summary}`);
            throw e;
          }
          recordFix(deploymentId, attempt, true);
          log(`[Agent] 已修复：${res.summary}`);
        } catch (fixErr) {
          if (fixErr === e) throw e;
          log(`[Agent] 修复失败：${fixErr instanceof Error ? fixErr.message : String(fixErr)}`);
          throw e;
        }
      }
    }
    if (lastErr) throw lastErr;

    releaseDeployLock(lockKey, deploymentId);
    updateDeploymentStatus(deploymentId, 'deploying');
    const webUrl = resolveAccessUrl(mod.name, env, 'web', webPort, mod.pathMode);
    const apiUrl = resolveAccessUrl(mod.name, env, 'api', apiPort, mod.pathMode);

    // 就绪探测：容器 up ≠ 应用已监听端口（就绪失败则不改路由、置 failed）
    await waitForHttpReady([webPort, apiPort], {
      log,
      signal,
      skip: readySkipFlag(mergedEnv),
      timeoutMs: resolveReadyTimeoutMs(180_000),
      hosts: Array.from(new Set([gatewayUpstreamHost(), '127.0.0.1'])),
    });

    updateDeploymentStatus(deploymentId, 'success', {
      url: webUrl,
      apiUrl,
      port: webPort,
      apiPort,
      commitSha: commitRef,
      imageTag: projectName,
    });
    setModuleActiveSlot(mod.id, env, {
      deploymentId,
      webPort,
      apiPort,
      url: webUrl,
      apiUrl,
    });
    regenerateNginxRoutes(log);
    log(`部署成功 [${env}]`);
    log(`前端: ${webUrl}`);
    log(`后端: ${apiUrl}`);
    log(`提示: 前端构建时请将 API 基址设为 ${apiUrl}`);
  } catch (e) {
    releaseDeployLock(lockKey, deploymentId);
    throw e;
  }
}

export function getDeploymentLogs(id: string): string {
  return getDeployment(id)?.logs ?? '';
}

/** 服务重启后，把上次中断（非终态）的部署标记为失败，避免僵尸记录 */
export function recoverStaleDeployments(): void {
  const rows = db
    .prepare(`SELECT id FROM deployments WHERE status NOT IN ('success', 'failed', 'cancelled')`)
    .all() as Array<{ id: string }>;
  for (const r of rows) {
    appendDeploymentLog(r.id, '[系统] 服务重启，该部署被中断并标记为失败');
    updateDeploymentStatus(r.id, 'failed');
  }
  if (rows.length) {
    console.log(`[deploy-worker] 已恢复 ${rows.length} 条中断部署为 failed`);
  }
  // 重启后清空过期锁
  try {
    db.prepare('DELETE FROM deploy_locks').run();
  } catch {
    // 忽略
  }
}

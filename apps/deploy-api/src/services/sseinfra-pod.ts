/**
 * 经集市机跳板在 WZ8 上对 students 命名空间执行 kubectl / 传包。
 * 依赖：运行机有 sshpass + scp/ssh + tar；密码同管理台 / SSEINFRA_PASSWORD。
 */
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { randomBytes } from 'crypto';
import { getSseinfraRuntimeConfig } from './sseinfra-settings.js';

function jumpCfg() {
  const c = getSseinfraRuntimeConfig();
  return {
    host: c.sshHost,
    user: c.sshUser,
    password: c.password,
  };
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function redactArgs(cmd: string, args: string[]): string {
  const out = [cmd, ...args];
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] === '-p' || out[i] === '--password') out[i + 1] = '***';
  }
  return out.join(' ');
}

function toolMissingError(cmd: string, cause: Error): Error {
  const plat = process.platform;
  return new Error(
    [
      `找不到命令「${cmd}」（${cause.message}）`,
      `平台=${plat} NODE=${process.version}`,
      `压缩包→K8s 需要 deploy-api 所在环境安装: openssh-client、sshpass、tar`,
      `生产：重建 sdpy-api 镜像（Dockerfile 已含 sshpass）后重启`,
      `本机 Windows 裸跑：请用 Git 部署，或设 DEPLOY_RUNTIME=compose`,
    ].join(' | ')
  );
}

type RunOpts = {
  timeoutMs?: number;
  log?: (line: string) => void;
  quiet?: boolean;
  signal?: AbortSignal;
};

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('已取消');
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('已取消'));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function run(cmd: string, args: string[], opts?: RunOpts) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    if (opts?.signal?.aborted) {
      reject(new Error('已取消'));
      return;
    }
    if (!opts?.quiet) opts?.log?.(`[exec] ${redactArgs(cmd, args)}`);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      opts?.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(() => reject(new Error('已取消')));
    };
    opts?.signal?.addEventListener('abort', onAbort);
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() =>
        reject(
          new Error(
            `命令超时(${opts?.timeoutMs ?? 300_000}ms): ${redactArgs(cmd, args)} | stderr=${stderr.slice(0, 400)}`
          )
        )
      );
    }, opts?.timeoutMs ?? 300_000);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      if (/ENOENT|not found/i.test(e.message)) {
        finish(() => reject(toolMissingError(cmd, e)));
        return;
      }
      finish(() => reject(e));
    });
    child.on('close', (code) => {
      if (opts?.signal?.aborted) {
        finish(() => reject(new Error('已取消')));
        return;
      }
      finish(() => resolve({ code: code ?? 1, stdout, stderr }));
    });
  });
}

function sleep(ms: number) {
  return abortableSleep(ms);
}

function fmtMb(n: number): string {
  return (n / (1024 * 1024)).toFixed(1);
}

/**
 * 经 SSH 在跳板机执行命令。
 * 用 base64 包裹，避免 OpenSSH `shell -c` 二次转义弄坏 sudo/引号（会表现为 sudo usage）。
 */
async function sshJump(
  remoteCommand: string,
  log?: (line: string) => void,
  opts?: { timeoutMs?: number; quiet?: boolean; signal?: AbortSignal }
): Promise<{ stdout: string; stderr: string }> {
  const { host, user, password } = jumpCfg();
  if (!password) {
    throw new Error(
      '未配置 sseinfra 密码，无法 SSH 跳板传包到 K8s（管理台填写 SSEINFRA_PASSWORD / k8s_password）'
    );
  }
  const timeoutMs = opts?.timeoutMs ?? 300_000;
  if (!opts?.quiet) {
    log?.(
      `[ssh] 跳板 ${user}@${host} · timeout=${Math.round(timeoutMs / 1000)}s · 远端命令预览: ${remoteCommand.slice(0, 200)}${
        remoteCommand.length > 200 ? '…' : ''
      }`
    );
  }
  const b64 = Buffer.from(remoteCommand, 'utf8').toString('base64');
  // 仅含 [A-Za-z0-9+/=]，无空格引号，sshd 二次转义也安全
  const wrapped = `echo ${b64} | base64 -d | bash`;
  const r = await run(
    'sshpass',
    [
      '-p',
      password,
      'ssh',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'PreferredAuthentications=password',
      '-o',
      'PubkeyAuthentication=no',
      `${user}@${host}`,
      wrapped,
    ],
    { timeoutMs, log, quiet: opts?.quiet, signal: opts?.signal }
  );
  if (r.code !== 0) {
    throw new Error(
      `SSH 跳板失败 exit=${r.code} host=${user}@${host} | stderr=${(r.stderr || '').slice(0, 800)} | stdout=${(r.stdout || '').slice(0, 400)}`
    );
  }
  if (!opts?.quiet) {
    if (r.stdout.trim()) log?.(`[ssh] stdout: ${r.stdout.trim().slice(0, 800)}`);
    if (r.stderr.trim()) log?.(`[ssh] stderr: ${r.stderr.trim().slice(0, 400)}`);
  }
  return r;
}

/** 在 WZ8（gpu）上执行 bash 脚本；跳板 → sse 用户 → gpu */
export async function runOnGpu(
  remoteBash: string,
  log?: (line: string) => void,
  opts?: { timeoutMs?: number; quiet?: boolean; signal?: AbortSignal }
) {
  if (!opts?.quiet) {
    log?.(
      `[gpu] 经跳板→gpu 执行: ${remoteBash.slice(0, 180)}${remoteBash.length > 180 ? '…' : ''}`
    );
  }
  const innerB64 = Buffer.from(remoteBash, 'utf8').toString('base64');
  // 跳板机解码后经 ssh stdin 喂给 gpu 的 bash，避免 bash -lc 嵌套引号
  const onJump = `echo ${innerB64} | base64 -d | sudo -u sse -H ssh -o BatchMode=yes -o ConnectTimeout=20 gpu bash`;
  const r = await sshJump(onJump, log, opts);
  if (!opts?.quiet && log && r.stdout.trim()) log(`[gpu] ${r.stdout.trim().slice(0, 2000)}`);
  return r;
}

/** API 机 → 跳板 scp，同时轮询跳板上文件大小 */
async function scpLocalToJumpWithProgress(opts: {
  tarPath: string;
  tarName: string;
  totalBytes: number;
  timeoutMs: number;
  log: (line: string) => void;
  pollMs?: number;
}) {
  const { tarPath, tarName, totalBytes, timeoutMs, log, pollMs = 5000 } = opts;
  const { host, user, password } = jumpCfg();
  log(`[migrate] 上传跳板 ${fmtMb(totalBytes)}MB → ${user}@${host}:/tmp/${tarName}`);

  let finished = false;
  const scpP = run(
    'sshpass',
    [
      '-p',
      password,
      'scp',
      '-o',
      'StrictHostKeyChecking=accept-new',
      tarPath,
      `${user}@${host}:/tmp/${tarName}`,
    ],
    { timeoutMs, log, quiet: true }
  ).finally(() => {
    finished = true;
  });

  const started = Date.now();
  let last = -1;
  while (!finished) {
    await sleep(pollMs);
    if (finished) break;
    try {
      const st = await sshJump(
        `stat -c%s /tmp/${tarName} 2>/dev/null || echo 0`,
        undefined,
        { timeoutMs: 30_000, quiet: true }
      );
      const remote = Number((st.stdout || '').trim().split('\n').pop()) || 0;
      const pct = totalBytes > 0 ? Math.min(99, Math.floor((remote / totalBytes) * 100)) : 0;
      if (remote !== last) {
        last = remote;
        log(`[migrate] →跳板 ${fmtMb(remote)}/${fmtMb(totalBytes)} MB (${pct}%)`);
      } else {
        log(
          `[migrate] →跳板 仍在传… ${fmtMb(remote)}/${fmtMb(totalBytes)} MB（已 ${Math.round((Date.now() - started) / 1000)}s）`
        );
      }
    } catch {
      /* 轮询失败忽略，等主 scp */
    }
  }

  const scp = await scpP;
  if (scp.code !== 0) {
    throw new Error(
      `scp 数据到跳板失败 exit=${scp.code} → ${user}@${host}:/tmp/${tarName} | ${(scp.stderr || scp.stdout || '').slice(0, 600)}`
    );
  }
  log(`[migrate] →跳板完成 ${fmtMb(totalBytes)}MB（用时 ${Math.round((Date.now() - started) / 1000)}s）`);
}

/** 跳板前台 scp → GPU，并行轮询 GPU 文件大小（与 →跳板 同模式，避免后台 setsid 卡死无日志） */
async function scpJumpToGpuWithProgress(opts: {
  tarName: string;
  totalBytes: number;
  timeoutMs: number;
  log: (line: string) => void;
  pollMs?: number;
  /** 日志前缀，便于区分 migrate / deploy 场景 */
  tag?: string;
  /** 取消信号：中断时终止 scp 子进程 */
  signal?: AbortSignal;
}) {
  const {
    tarName,
    totalBytes,
    timeoutMs,
    log,
    pollMs = 5000,
    tag = 'migrate',
    signal,
  } = opts;
  log(
    `[${tag}] 跳板→GPU 开始，目标 ${fmtMb(totalBytes)}MB（前台 scp + 并行进度，超时上限 ${Math.round(timeoutMs / 60000)}min）`
  );

  await sshJump(`chmod 644 /tmp/${tarName}`, undefined, {
    timeoutMs: 30_000,
    quiet: true,
    signal,
  });

  let finished = false;
  const started = Date.now();
  const scpP = sshJump(
    `sudo -u sse -H scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new /tmp/${tarName} gpu:/tmp/${tarName} && rm -f /tmp/${tarName}`,
    undefined,
    { timeoutMs, quiet: true, signal }
  ).finally(() => {
    finished = true;
  });

  let lastRemote = -1;
  while (!finished) {
    await sleep(pollMs);
    if (finished) break;
    try {
      const st = await sshJump(
        `sudo -u sse -H ssh -o BatchMode=yes -o ConnectTimeout=10 gpu "stat -c%s /tmp/${tarName} 2>/dev/null || echo 0"`,
        undefined,
        { timeoutMs: 30_000, quiet: true }
      );
      const remote = Number((st.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()) || 0;
      const pct = totalBytes > 0 ? Math.min(99, Math.floor((remote / totalBytes) * 100)) : 0;
      if (remote !== lastRemote) {
        lastRemote = remote;
        log(`[${tag}] 跳板→GPU ${fmtMb(remote)}/${fmtMb(totalBytes)} MB (${pct}%)`);
      } else {
        log(
          `[${tag}] 跳板→GPU 仍在传… ${fmtMb(remote)}/${fmtMb(totalBytes)} MB（已 ${Math.round((Date.now() - started) / 1000)}s）`
        );
      }
    } catch (e) {
      log(
        `[${tag}] 跳板→GPU 进度探测暂失败（已 ${Math.round((Date.now() - started) / 1000)}s）: ${
          e instanceof Error ? e.message.slice(0, 120) : String(e)
        }`
      );
    }
  }

  try {
    await scpP;
  } catch (e) {
    throw new Error(
      `跳板→GPU scp 失败: ${e instanceof Error ? e.message.slice(0, 800) : String(e)}`
    );
  }
  log(`[${tag}] 跳板→GPU 完成 ${fmtMb(totalBytes)}MB（用时 ${Math.round((Date.now() - started) / 1000)}s）`);
}

/** GPU 前台 kubectl cp → Pod，并行轮询容器内文件大小 */
async function kubectlCpToPodWithProgress(opts: {
  tarName: string;
  pod: string;
  totalBytes: number;
  timeoutMs: number;
  log: (line: string) => void;
  pollMs?: number;
}) {
  const { tarName, pod, totalBytes, timeoutMs, log, pollMs = 5000 } = opts;
  const kc = 'sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n students';
  log(`[migrate] kubectl cp → Pod 开始，目标 ${fmtMb(totalBytes)}MB`);

  let finished = false;
  const started = Date.now();
  const cpP = runOnGpu(
    `${kc} cp /tmp/${tarName} ${pod}:/tmp/${tarName} && rm -f /tmp/${tarName}`,
    undefined,
    { timeoutMs, quiet: true }
  ).finally(() => {
    finished = true;
  });

  let last = -1;
  while (!finished) {
    await sleep(pollMs);
    if (finished) break;
    try {
      const st = await runOnGpu(
        `${kc} exec ${pod} -- stat -c%s /tmp/${tarName} 2>/dev/null || echo 0`,
        undefined,
        { timeoutMs: 30_000, quiet: true }
      );
      const remote = Number((st.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()) || 0;
      const pct = totalBytes > 0 ? Math.min(99, Math.floor((remote / totalBytes) * 100)) : 0;
      if (remote !== last) {
        last = remote;
        log(`[migrate] →Pod ${fmtMb(remote)}/${fmtMb(totalBytes)} MB (${pct}%)`);
      } else {
        log(
          `[migrate] →Pod 仍在传… ${fmtMb(remote)}/${fmtMb(totalBytes)} MB（已 ${Math.round((Date.now() - started) / 1000)}s）`
        );
      }
    } catch (e) {
      log(
        `[migrate] →Pod 进度探测暂失败（已 ${Math.round((Date.now() - started) / 1000)}s）: ${
          e instanceof Error ? e.message.slice(0, 120) : String(e)
        }`
      );
    }
  }

  try {
    await cpP;
  } catch (e) {
    throw new Error(`kubectl cp 失败: ${e instanceof Error ? e.message.slice(0, 800) : String(e)}`);
  }
  log(`[migrate] kubectl cp 完成 ${fmtMb(totalBytes)}MB（用时 ${Math.round((Date.now() - started) / 1000)}s）`);
}

export async function resolveGroupPod(
  group: string,
  log?: (line: string) => void,
  opts?: { signal?: AbortSignal }
): Promise<string> {
  throwIfAborted(opts?.signal);
  log?.(`[k8s] 解析组 Pod：app=group-${group}（namespace=students）`);
  // -o name：Pod 列表为空时输出空而非 jsonpath index 报错（k3s 抖动窗口更平滑）
  const r = await runOnGpu(
    `sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n students get pod -l app=group-${group} -o name`,
    log,
    { signal: opts?.signal }
  );
  const name =
    (r.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean)
      ?.replace(/^pod\//, '') ?? '';
  if (!name) {
    throw new Error(
      `找不到组 ${group} 的 Pod（label app=group-${group}）。面板是否 Running？kubectl 输出空。stdout=${(r.stdout || '').slice(0, 200)} stderr=${(r.stderr || '').slice(0, 200)}`
    );
  }
  log?.(`[k8s] 解析到 pod=${name}`);
  return name;
}

/** 面板 Running 与 K8s Pod 可能短暂不一致；同步包前必须等到 Pod 真实存在 */
export async function waitForGroupPod(
  group: string,
  log?: (line: string) => void,
  opts?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const intervalMs = opts?.intervalMs ?? 3000;
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < timeoutMs) {
    throwIfAborted(opts?.signal);
    try {
      return await resolveGroupPod(group, log, { signal: opts?.signal });
    } catch (e) {
      if (e instanceof Error && e.message === '已取消') throw e;
      lastErr = e instanceof Error ? e.message : String(e);
      log?.(
        `[k8s] 等待 Pod… ${Math.round((Date.now() - start) / 1000)}s（${lastErr.slice(0, 100)}）`,
      );
      await abortableSleep(intervalMs, opts?.signal);
    }
  }
  throw new Error(
    `组 ${group}：面板可能显示 Running，但 K8s 无 Pod（label app=group-${group}）。` +
      `请到 sseinfra 面板删除该组后重部署，或在 deploy-api 设置 SSEINFRA_FORCE_RECREATE=1 强制重建。` +
      `最后错误：${lastErr}`,
  );
}

/**
 * 等待组 Deployment 的 rollout 收敛，且 Pod 名连续两次一致（不再有滚动在路上）。
 *
 * 面板 groups.set_env 每写一个环境变量都会 `kubectl rollout restart`，Pod 会被整体替换。
 * 写 env 后若立刻 `kubectl cp`，可能打进「正在被终止」的旧 Pod（部署日志里 env 阶段与
 * cp 阶段 Pod 名不一致即此现象）。故写 env 之后、同步包之前必须等 rollout 收敛。
 *
 * 返回收敛后的 Pod 名（可直接用于 kubectl cp）。
 */
/**
 * 等待组 Deployment 的 rollout 收敛，并返回一个「未被删除」的在跑 Pod 名。
 *
 * 面板 groups.set_env 每写一个环境变量都会 `kubectl rollout restart`，Pod 会被整体替换。
 * 写 env 后若立刻 `kubectl cp`，可能打进「正在被终止」的旧 Pod（部署日志里 env 阶段与
 * cp 阶段 Pod 名不一致即此现象）。故写 env 之后、同步包之前必须等 rollout 收敛。
 *
 * 实现要点（性能）：跳板→gpu 是两层 SSH，单次往返约 20s，因此把「等 rollout」与
 * 「查 Pod」合并为**一次**远程调用；并优先用 rollout status 阻塞等待，通常一轮即完成。
 *
 * 健壮性：rollout 迟迟不完成时不硬失败（避免把原本能成的部署变成失败），
 * 超时后若已看到可用 Pod 则降级返回该 Pod 并告警。
 */
export async function waitGroupRolloutSettled(
  group: string,
  log?: (line: string) => void,
  opts?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 180_000;
  const intervalMs = opts?.intervalMs ?? 2000;
  const start = Date.now();
  const deadline = start + timeoutMs;
  const K = 'sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n students';
  let bestEffortPod = '';
  let lastErr = '';

  // 一次远程调用内完成：等 rollout 收敛（已稳定则立即返回）+ 列出未被删除的 Pod
  const scriptFor = (remainSec: number) =>
    [
      `${K} rollout status deployment/group-${group} --timeout=${remainSec}s >/dev/null 2>&1 ` +
        `&& echo __ROLLOUT_OK__ || echo __ROLLOUT_PENDING__`,
      `${K} get pod -l app=group-${group} ` +
        `-o jsonpath='{range .items[*]}{.metadata.name}|{.metadata.deletionTimestamp}{"\\n"}{end}'`,
    ].join('; ');

  while (Date.now() < deadline) {
    throwIfAborted(opts?.signal);
    const remainSec = Math.max(10, Math.floor((deadline - Date.now()) / 1000) - 5);
    let rolloutOk = false;
    let livePod = '';
    try {
      const r = await runOnGpu(scriptFor(remainSec), undefined, {
        quiet: true,
        signal: opts?.signal,
      });
      const lines = (r.stdout || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      rolloutOk = lines.includes('__ROLLOUT_OK__');
      for (const line of lines) {
        if (line.startsWith('__ROLLOUT_')) continue;
        const [name, deleting] = line.split('|');
        // deletionTimestamp 非空 = 正在被删除（旧 Pod），cp 进去会失败
        if (name && !(deleting || '').trim()) {
          livePod = name;
          break;
        }
      }
      lastErr = livePod ? '' : '未找到未被删除的 Pod';
    } catch (e) {
      if (e instanceof Error && e.message === '已取消') throw e;
      lastErr = e instanceof Error ? e.message : String(e);
      log?.(`[k8s] 等待 rollout 收敛…（${lastErr.slice(0, 120)}）`);
    }

    const secs = Math.round((Date.now() - start) / 1000);
    if (rolloutOk && livePod) {
      log?.(`[k8s] rollout 已收敛 pod=${livePod}（耗时 ${secs}s）`);
      return livePod;
    }
    if (livePod) bestEffortPod = livePod;
    log?.(
      `[k8s] 等待 rollout 收敛… ${secs}s（rollout=${rolloutOk ? 'ok' : 'pending'}${
        livePod ? ` pod=${livePod}` : ` ${lastErr.slice(0, 80)}`
      }）`,
    );
    if (Date.now() + intervalMs < deadline) await abortableSleep(intervalMs, opts?.signal);
  }

  // 超时：不硬失败，降级用已发现的可用 Pod（避免把原本能成的部署变失败）
  if (bestEffortPod) {
    log?.(
      `[k8s] [警告] rollout 未在 ${Math.round(timeoutMs / 1000)}s 内确认收敛，` +
        `降级使用 pod=${bestEffortPod} 继续同步（如失败请稍后重试部署）`,
    );
    return bestEffortPod;
  }
  throw new Error(
    `组 ${group}：等待 Deployment rollout 收敛超时（${Math.round(timeoutMs / 1000)}s），` +
      `且未找到可用 Pod：${lastErr}`,
  );
}

export async function syncPackageAndStart(opts: {
  group: string;
  deployName: string;
  programId: string;
  localDir: string;
  env: Record<string, string>;
  log: (line: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { group, deployName, programId, localDir, env, log, signal } = opts;
  throwIfAborted(signal);
  log(`[k8s] 开始同步压缩包 → 组 ${group}`);
  log(`[k8s] localDir=${localDir} deployName=${deployName} programId=${programId}`);
  if (!existsSync(localDir) || !statSync(localDir).isDirectory()) {
    throw new Error(`本地包目录不存在: ${localDir}`);
  }
  if (!existsSync(join(localDir, 'deploy.sh'))) {
    throw new Error(
      `K8s 部署压缩包须在根目录包含 deploy.sh（当前目录 ${localDir} 无此文件；组内无 Docker，无法直接跑 compose）`
    );
  }
  log(`[k8s] 已确认存在 deploy.sh`);

  const pod = await resolveGroupPod(group, log, { signal });
  log(`[k8s] 目标 pod=${pod}`);

  const tmp = mkdtempSync(join(tmpdir(), 'sdpy-pkg-'));
  const tarName = `sdpy-${randomBytes(4).toString('hex')}.tar.gz`;
  const tarPath = join(tmp, tarName);
  const { host, user, password } = jumpCfg();

  try {
    throwIfAborted(signal);
    const parent = join(localDir, '..');
    const base = basename(localDir);
    log(`[k8s] 本地打包 tar -czf … -C ${parent} ${base}`);
    const tarRes = await run('tar', ['-czf', tarPath, '-C', parent, base], {
      timeoutMs: 120_000,
      log,
      signal,
    });
    if (tarRes.code !== 0) {
      throw new Error(
        `本地 tar 打包失败 exit=${tarRes.code}: ${(tarRes.stderr || tarRes.stdout || '请确认系统有 tar').slice(0, 500)}`
      );
    }
    const sizeMb = statSync(tarPath).size / (1024 * 1024);
    if (sizeMb > 80) {
      throw new Error(
        `压缩包过大（${sizeMb.toFixed(1)}MB），请去掉 node_modules/大模型后重试，或改用 Git`
      );
    }
    log(`[k8s] 打包完成 ${sizeMb.toFixed(2)}MB → 上传 ${user}@${host}:/tmp/${tarName}`);

    const scp = await run(
      'sshpass',
      [
        '-p',
        password,
        'scp',
        '-o',
        'StrictHostKeyChecking=accept-new',
        tarPath,
        `${user}@${host}:/tmp/${tarName}`,
      ],
      { timeoutMs: 300_000, log, signal }
    );
    if (scp.code !== 0) {
      throw new Error(
        `scp 到跳板失败 exit=${scp.code} → ${user}@${host}:/tmp/${tarName} | ${(scp.stderr || scp.stdout || '').slice(0, 600)}`
      );
    }
    log(`[k8s] scp 到跳板成功，继续跳板→GPU→Pod`);

    // 跳板→GPU 常走 Tailscale DERP 中继，RTT 可达 1s+、偶发丢包，实测吞吐可能低至 100KB/s 量级；
    // 默认 5min 会让 40MB+ 的包必定超时（历史故障）。故按体积给足超时（至少 30min 或约 15s/MB），
    // 并复用带进度的传输函数，避免长传输期间日志「假死」。
    const hopTimeoutMs = Math.max(1_800_000, Math.ceil(sizeMb) * 15_000);
    log(`[k8s] 跳板→GPU 超时上限 ${Math.round(hopTimeoutMs / 60000)}min（包 ${sizeMb.toFixed(2)}MB）`);
    await scpJumpToGpuWithProgress({
      tarName,
      totalBytes: statSync(tarPath).size,
      timeoutMs: hopTimeoutMs,
      log,
      tag: 'k8s',
      signal,
    });
    log('[k8s] 已传到 GPU:/tmp，写入 Pod…');

    await runOnGpu(
      `sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n students cp /tmp/${tarName} ${pod}:/tmp/${tarName} && rm -f /tmp/${tarName}`,
      log,
      { signal }
    );
    log(`[k8s] kubectl cp 完成 → ${pod}:/tmp/${tarName}，解压并配置 supervisord…`);

    const envKeys = Object.keys(env);
    log(`[k8s] 注入环境变量 ${envKeys.length} 个: ${envKeys.slice(0, 20).join(',')}${envKeys.length > 20 ? '…' : ''}`);

    const envStr = Object.entries(env)
      .map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      .join(',');

    const extractAndStart = `
set -e
KC="sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n students"
POD=${shQuote(pod)}
$KC exec "$POD" -- bash -lc ${shQuote(`
set -e
mkdir -p /home/cloud/deploy/programs
rm -rf /home/cloud/deploy/${deployName}.new /home/cloud/deploy/${deployName}
mkdir -p /home/cloud/deploy/${deployName}.new
tar -xzf /tmp/${tarName} -C /home/cloud/deploy/${deployName}.new
# strip single top-level dir if present
entries=$(ls -A /home/cloud/deploy/${deployName}.new | wc -l)
if [ "$entries" = "1" ]; then
  d=$(ls -A /home/cloud/deploy/${deployName}.new)
  if [ -d "/home/cloud/deploy/${deployName}.new/$d" ]; then
    mkdir -p /home/cloud/deploy/${deployName}
    mv /home/cloud/deploy/${deployName}.new/$d/* /home/cloud/deploy/${deployName}/ 2>/dev/null || true
    mv /home/cloud/deploy/${deployName}.new/$d/.[!.]* /home/cloud/deploy/${deployName}/ 2>/dev/null || true
    rm -rf /home/cloud/deploy/${deployName}.new
  else
    mv /home/cloud/deploy/${deployName}.new /home/cloud/deploy/${deployName}
  fi
else
  mv /home/cloud/deploy/${deployName}.new /home/cloud/deploy/${deployName}
fi
mkdir -p /home/cloud/deploy/${deployName}/logs
# Windows zip 常带 CRLF → bash: set: pipefail\\r invalid option name
sed -i 's/\\r$//' /home/cloud/deploy/${deployName}/deploy.sh || true
chmod +x /home/cloud/deploy/${deployName}/deploy.sh
# zip 常丢执行位；预编译二进制须 +x，否则会误下 Go 工具链
chmod +x /home/cloud/deploy/${deployName}/bin/* 2>/dev/null || true
chown -R 1001:1001 /home/cloud/deploy/${deployName} 2>/dev/null || chown -R cloud:cloud /home/cloud/deploy/${deployName} || true
rm -f /tmp/${tarName}
test -x /home/cloud/deploy/${deployName}/deploy.sh
`)}

$KC exec "$POD" -- bash -lc ${shQuote(`
set -e
if [ ! -f /home/cloud/deploy/supervisord.conf ]; then
cat > /home/cloud/deploy/supervisord.conf <<'EOF'
[unix_http_server]
file=/home/cloud/deploy/supervisor.sock
chmod=0700
[supervisord]
logfile=/home/cloud/deploy/supervisord.log
pidfile=/home/cloud/deploy/supervisord.pid
nodaemon=false
[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface
[supervisorctl]
serverurl=unix:///home/cloud/deploy/supervisor.sock
[include]
files = /home/cloud/deploy/programs/*.conf
EOF
chown cloud:cloud /home/cloud/deploy/supervisord.conf 2>/dev/null || true
fi
mkdir -p /home/cloud/deploy/programs
su -l cloud -c 'command -v ~/.local/bin/supervisord >/dev/null || pip install --user supervisor'

# 确保只有一份 supervisord（复用组时勿二次启动抢 sock）
su -l cloud -c '
set +e
CONF="$HOME/deploy/supervisord.conf"
SC="$HOME/.local/bin/supervisorctl"
SD="$HOME/.local/bin/supervisord"
SOCK="$HOME/deploy/supervisor.sock"
PIDF="$HOME/deploy/supervisord.pid"
if "$SC" -c "$CONF" version >/dev/null 2>&1; then
  echo "[supervisord] already running (ctl ok)"
  exit 0
fi
if [ -f "$PIDF" ]; then
  old=$(cat "$PIDF" 2>/dev/null)
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    echo "[supervisord] pid $old alive, skip start"
    exit 0
  fi
fi
rm -f "$SOCK" "$PIDF"
"$SD" -c "$CONF"
sleep 1
"$SC" -c "$CONF" version >/dev/null
'

# 停掉旧 deploy-*（新 programId 每次不同，否则会占 8080）
# 注意：awk 程序须用单引号，否则 shell 会展开 $1 变成空 → 整行被当成进程名
su -l cloud -c '
set +e
CONF="$HOME/deploy/supervisord.conf"
SC="$HOME/.local/bin/supervisorctl"
"$SC" -c "$CONF" status 2>/dev/null | awk '"'"'/^deploy-/{print $1}'"'"' | while read -r p; do
  [ -n "$p" ] || continue
  echo "[supervisord] stop old $p"
  "$SC" -c "$CONF" stop "$p" || true
  "$SC" -c "$CONF" remove "$p" || true
done
true
'
rm -f /home/cloud/deploy/programs/deploy-*.conf

cat > /home/cloud/deploy/programs/deploy-${programId}.conf <<EOF
[program:deploy-${programId}]
command=bash /home/cloud/deploy/${deployName}/deploy.sh
directory=/home/cloud/deploy/${deployName}
user=cloud
autostart=true
autorestart=true
startsecs=3
stopwaitsecs=20
stdout_logfile=/home/cloud/deploy/${deployName}/logs/stdout.log
stderr_logfile=/home/cloud/deploy/${deployName}/logs/stderr.log
environment=${envStr}
EOF
chown cloud:cloud /home/cloud/deploy/programs/deploy-${programId}.conf 2>/dev/null || true

su -l cloud -c '
set +e
CONF="$HOME/deploy/supervisord.conf"
SC="$HOME/.local/bin/supervisorctl"
"$SC" -c "$CONF" reread
"$SC" -c "$CONF" update
# update 可能已因 autostart 拉起；勿重复 start 刷 already started
if ! "$SC" -c "$CONF" status deploy-${programId} 2>/dev/null | grep -q RUNNING; then
  "$SC" -c "$CONF" start deploy-${programId} || true
fi
"$SC" -c "$CONF" status deploy-${programId} || true
'
`)}
`;
    await runOnGpu(extractAndStart, log, { signal });
    log(`[k8s] 压缩包已同步并启动 supervisord program=deploy-${programId} dir=/home/cloud/deploy/${deployName}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function stopPackageProgram(group: string, programId: string, log?: (l: string) => void) {
  const pod = await resolveGroupPod(group, log);
  log?.(`[k8s] 停止 program deploy-${programId} on ${pod}`);
  await runOnGpu(
    `sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n students exec ${pod} -- bash -lc ${shQuote(
      `su -l cloud -c '~/.local/bin/supervisorctl -c ~/deploy/supervisord.conf stop deploy-${programId}' || true`
    )}`,
    log
  );
}

export async function packageProgramStatus(
  group: string,
  programId: string,
  opts?: { signal?: AbortSignal }
): Promise<string> {
  const pod = await resolveGroupPod(group, undefined, { signal: opts?.signal });
  const r = await runOnGpu(
    `sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n students exec ${pod} -- bash -lc ${shQuote(
      `su -l cloud -c '~/.local/bin/supervisorctl -c ~/deploy/supervisord.conf status deploy-${programId}' || true`
    )}`,
    undefined,
    { signal: opts?.signal }
  );
  return (r.stdout || r.stderr || '').trim();
}

export async function packageProgramLogs(
  group: string,
  deployName: string,
  opts?: { signal?: AbortSignal }
): Promise<string> {
  const pod = await resolveGroupPod(group, undefined, { signal: opts?.signal });
  // 只输出有内容的日志；避免 tail 多文件打出空的 ==> stderr.log <== 像报错
  const r = await runOnGpu(
    `sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n students exec ${pod} -- bash -lc ${shQuote(
      [
        `d=/home/cloud/deploy/${deployName}/logs`,
        `out=''`,
        `if [ -s "$d/stdout.log" ]; then out="$out--- stdout ---"$'\n'"$(tail -n 80 "$d/stdout.log")"$'\n'; fi`,
        `if [ -s "$d/stderr.log" ]; then out="$out--- stderr ---"$'\n'"$(tail -n 80 "$d/stderr.log")"$'\n'; fi`,
        `printf '%s' "$out"`,
      ].join('; ')
    )}`,
    undefined,
    { signal: opts?.signal }
  );
  return (r.stdout || '').trim();
}

export interface HttpReadyOptions {
  /** 就绪判定总超时，默认取 SDPY_READY_TIMEOUT_SECONDS，否则 15min */
  timeoutMs?: number;
  /** 轮询间隔，默认 3s */
  pollMs?: number;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** 候选主机名（容器内访问宿主机端口）；默认 ['127.0.0.1'] */
  hosts?: string[];
  /** 完整探测 URL 列表；提供时优先用它（如前端域名 https://host/test/img/），替代默认 host:port 根路径 */
  probeUrls?: string[];
  /** 严格模式：要求 HTTP 2xx 且响应体非空（用于验证“前端域名有内容”），默认仅任意状态码即算就绪 */
  expectContent?: boolean;
  /** 每轮附加检查，抛错则立即判部署失败（如 supervisord FATAL） */
  onCheck?: () => Promise<void> | void;
  /** 跳过就绪探测（非 HTTP 服务） */
  skip?: boolean;
}

/** 就绪探测总超时：优先 SDPY_READY_TIMEOUT_SECONDS，否则用调用方给的默认值 */
export function resolveReadyTimeoutMs(override?: number): number {
  const raw = (process.env.SDPY_READY_TIMEOUT_SECONDS || '').trim();
  const fromEnv = Number(raw);
  if (raw && Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv * 1000;
  return override ?? 900_000;
}

/**
 * 等待应用真正可被 HTTP 访问。supervisord RUNNING 只代表 deploy.sh 起了进程，
 * 应用可能还在编译/下载依赖（此时 frp 隧道后端无监听，公网表现为 502）。
 *
 * 判定标准（默认）：拿到任意 HTTP 状态码即算就绪（含 4xx/5xx——应用自身报错是应用问题，
 * 平台只负责「路由指向一个已监听的端口」）；连接被拒/重置/超时则继续等。
 *
 * 判定标准（严格 expectContent=true）：要求 HTTP 2xx 且响应体非空（trim 后），
 * 用于验证「访问前端域名有内容」——若模块是带前端页面的服务（如图床），
 * 前端页面返回的是空壳 / 非 2xx，则说明模块未真正拉起，继续等而不是伪成功。
 *
 * 探测目标（优先）：opts.probeUrls 里的完整 URL（如 https://ssemarket.cn/test/image/），
 * 其 scheme 以 URL 自身为准；未提供时退回 host×port 的根路径。
 * 自动协议升级：若对某 URL 用 http 探测得到 4xx（尤其是 400/426/497——典型“http 打
 * TLS 端口”信号，如宿主 nginx 的 230xx 是 listen … ssl），则会自动用同一 host:port 的
 * https 再探一次，避免把“协议不匹配”误判为“应用没起来”。
 * 跳过：模块环境变量 SDPY_READY_SKIP=1（非 HTTP 服务时用）。
 */
export async function waitForHttpReady(
  ports: number | number[],
  opts: HttpReadyOptions = {}
): Promise<void> {
  const portList = (Array.isArray(ports) ? ports : [ports]).filter(
    (p) => Number.isFinite(p) && p > 0
  );
  if (!portList.length && !(opts.probeUrls?.length)) throw new Error('无可探测端口/URL');

  const skip =
    /^(1|true|yes)$/i.test((process.env.DEPLOY_READY_SKIP || '').trim()) || opts.skip === true;
  if (skip) {
    opts.log?.('[ready] 已配置跳过就绪检查（SDPY_READY_SKIP），直接写网关');
    return;
  }

  const hosts = (opts.hosts?.length ? opts.hosts : ['127.0.0.1']).filter(Boolean);
  const timeoutMs = resolveReadyTimeoutMs(opts.timeoutMs);
  const pollMs = opts.pollMs ?? 3000;
  const probeTimeoutMs = Math.min(pollMs, 5000);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const fmt = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)}min` : `${Math.round(ms / 1000)}s`);
  const expectContent = opts.expectContent === true;

  // 把 host×port 兜底目标统一补成显式 scheme 的 URL：http 优先，约定后续可自动升级 https。
  const fallbackUrls: string[] = hosts.flatMap((h) =>
    portList.map((p) => `http://${h}:${p}/`)
  );
  // 探测目标：前端域名完整 URL（优先）+ host×port 根路径（兜底），统一去重。
  // 严格模式下仍需“2xx + 非空 body”才算就绪，任一探测目标命中即成功。
  const urls: string[] = Array.from(
    new Set([...(opts.probeUrls?.length ? opts.probeUrls : []), ...fallbackUrls])
  );

  opts.log?.(
    expectContent
      ? `[ready] 严格就绪探测：GET ${urls[0]}（最长 ${fmt(timeoutMs)}；要求 HTTP 2xx 且响应体非空，即“前端有内容”）`
      : `[ready] 等待应用就绪 GET ${urls[0]}（最长 ${fmt(timeoutMs)}；收到任意 HTTP 响应即算就绪）`
  );

  // 探测一次：返回 {ok, log}。ok=true 表示已命中就绪；false 表示本轮未命中。
  // 内部会对 http 得 4xx 的 URL 自动升级到 https 再探一次（200/2xx 则视为命中）。
  async function probeOnce(url: string): Promise<{ ok: boolean }> {
    const tryOne = async (u: string): Promise<{ status: number; body: string; fetchFailed: boolean }> => {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(probeTimeoutMs) });
        let body = '';
        try {
          body = await res.text();
        } catch {
          /* 读取失败时 body 为空，视同无内容 */
        }
        return { status: res.status, body, fetchFailed: false };
      } catch {
        return { status: 0, body: '', fetchFailed: true };
      }
    };

    let r = await tryOne(url);

    // 明确为 http 且得到 4xx/2xx 之外（400/426/497 等）→ 疑似“http 打 TLS 端口”，
    // 自动升级到同一 host:port 的 https 再探。若 https 拿到 2xx（或非严格模式任意状态码）则命中。
    const isHttp = url.startsWith('http://');
    const suspicious = isHttp && !r.fetchFailed && r.status >= 400 && r.status < 500;
    if (suspicious && [400, 421, 426, 497].includes(r.status)) {
      const httpsUrl = url.replace(/^http:\/\//i, 'https://');
      if (httpsUrl !== url) {
        opts.log?.(
          `[ready] ${url} → HTTP ${r.status}（疑似 http 打 TLS 端口），自动改试 ${httpsUrl}`
        );
        const upgraded = await tryOne(httpsUrl);
        if (!upgraded.fetchFailed) {
          r = upgraded;
        }
      }
    }

    if (r.fetchFailed) return { ok: false };
    const hasBody = r.body.trim().length > 0;
    if (expectContent) {
      const ok = r.status >= 200 && r.status < 300 && hasBody;
      if (!ok) {
        opts.log?.(
          `[ready] ${url} → HTTP ${r.status}${hasBody ? '' : '（响应体为空）'}，应用尚未拉起，继续等`
        );
        return { ok: false };
      }
      const elapsed = Date.now() - startedAt;
      opts.log?.(
        `[ready] 前端有内容（${url} → HTTP ${r.status}，响应体 ${r.body.length} 字节，耗时 ${fmt(elapsed)}）`
      );
      return { ok: true };
    }
    // 宽松模式：拿到任意状态码即算就绪
    const elapsed = Date.now() - startedAt;
    opts.log?.(
      `[ready] 应用已就绪（${url} → HTTP ${r.status}，耗时 ${fmt(elapsed)}）`
    );
    return { ok: true };
  }

  let round = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new Error('已取消');
    round += 1;
    if (opts.onCheck) await opts.onCheck();

    for (const url of urls) {
      const hit = await probeOnce(url);
      if (hit.ok) return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `应用未在 ${fmt(timeoutMs)} 内就绪（探测 ${round} 轮${expectContent ? '仍无 2xx+内容' : '无 HTTP 响应'}）。` +
          `请到部署日志查看应用是否还在编译或已崩溃；` +
          `若该模块不是 HTTP 服务，可在模块环境变量配置 SDPY_READY_SKIP=1 跳过本检查`
      );
    }
    if (round % 10 === 0) {
      const waited = Date.now() - startedAt;
      opts.log?.(`[ready] 仍未就绪，已等待 ${fmt(waited)}/${fmt(timeoutMs)}…`);
    }
    await abortableSleep(pollMs, opts.signal);
  }
}

/**
 * 将宿主机模块数据目录同步到组容器持久化路径。
 * 目标：/home/cloud/data（PVC 家目录下），并尽量 ln -sfn → /data，兼容旧应用写 /data。
 */
export async function syncHostDataToPod(opts: {
  group: string;
  localDir: string;
  log: (line: string) => void;
}): Promise<{ bytes: number; remote: string }> {
  const { group, localDir, log } = opts;
  const remoteHome = '/home/cloud/data';
  log(`[migrate] 准备同步 MODULE_DATA localDir=${localDir} → 组 ${group}:${remoteHome}`);
  if (!existsSync(localDir) || !statSync(localDir).isDirectory()) {
    log(`[migrate] 本地数据目录不存在，跳过同步: ${localDir}`);
    return { bytes: 0, remote: remoteHome };
  }

  const tmp = mkdtempSync(join(tmpdir(), 'sdpy-data-'));
  const tarName = `data-${randomBytes(4).toString('hex')}.tar.gz`;
  const tarPath = join(tmp, tarName);
  const { host, user } = jumpCfg();

  try {
    log(`[migrate] 打包数据目录…`);
    const tarRes = await run('tar', ['-czf', tarPath, '-C', localDir, '.'], {
      timeoutMs: 300_000,
      log,
    });
    if (tarRes.code !== 0) {
      throw new Error(
        `打包模块数据失败 exit=${tarRes.code}: ${(tarRes.stderr || tarRes.stdout || '').slice(0, 500)}`
      );
    }
    const bytes = statSync(tarPath).size;
    const mb = bytes / (1024 * 1024);
    if (bytes < 32) {
      log(`[migrate] 数据包几乎为空（${bytes}B / ${mb.toFixed(2)}MB），跳过 scp（无需传空包）`);
      return { bytes, remote: remoteHome };
    }
    if (mb > 1500) {
      throw new Error(`模块数据过大（${mb.toFixed(0)}MB），请先精简后再迁移，或手动 scp`);
    }
    log(`[migrate] 同步数据 ${mb.toFixed(2)}MB（${bytes} bytes）→ ${user}@${host} → 组 ${group}:${remoteHome}`);

    const pod = await resolveGroupPod(group, log);
    // 140MB+ 经跳板→GPU 常超过默认 5min；至少 30min，或按约 15s/MB
    const hopTimeoutMs = Math.max(1_800_000, Math.ceil(mb) * 15_000);
    log(`[migrate] 各跳超时上限 ${Math.round(hopTimeoutMs / 60000)}min，日志每 5s 刷新进度`);

    await scpLocalToJumpWithProgress({
      tarPath,
      tarName,
      totalBytes: bytes,
      timeoutMs: hopTimeoutMs,
      log,
    });

    await scpJumpToGpuWithProgress({
      tarName,
      totalBytes: bytes,
      timeoutMs: hopTimeoutMs,
      log,
    });

    await kubectlCpToPodWithProgress({
      tarName,
      pod,
      totalBytes: bytes,
      timeoutMs: hopTimeoutMs,
      log,
    });

    await runOnGpu(
      `sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n students exec ${pod} -- bash -lc ${shQuote(`
set -e
mkdir -p ${remoteHome}
tar -xzf /tmp/${tarName} -C ${remoteHome}
rm -f /tmp/${tarName}
chown -R cloud:cloud ${remoteHome} 2>/dev/null || chown -R 1001:1001 ${remoteHome} || true
# 兼容旧应用硬编码 /data
if [ ! -e /data ]; then
  ln -sfn ${remoteHome} /data 2>/dev/null || true
elif [ -d /data ] && [ ! "$(ls -A /data 2>/dev/null)" ]; then
  # 空 /data 目录：尽量改为软链（若为 mountpoint 则跳过）
  rmdir /data 2>/dev/null && ln -sfn ${remoteHome} /data || true
fi
# 若 /data 是普通目录且非空，再拷一份覆盖合并
if [ -d /data ] && [ ! -L /data ]; then
  cp -a ${remoteHome}/. /data/ 2>/dev/null || true
fi
`)}`,
      log,
      { timeoutMs: hopTimeoutMs }
    );

    log(`[migrate] 数据已写入 Pod ${pod}:${remoteHome}（并尽量兼容 /data）`);
    return { bytes, remote: remoteHome };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

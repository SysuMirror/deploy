/**
 * 脚本执行引擎：把用户在网页上配置的命令，放到「宿主机的根目录」里跑。
 *
 * 为什么不是直接在 deploy-api 容器里 spawn？
 *   容器非特权、只挂载了 sse-sdpy 自身目录，既看不到 /root/SSE_Market 下的其他项目，
 *   也不一定装了宿主那套 python / docker / git 版本。在容器里跑会静默错版本、错路径。
 *
 * 所以走「特权辅助容器 + nsenter 进宿主命名空间」——
 *   与 process-manager 的 killViaHost 同一套路（都是 docker run --pid=host --privileged）：
 *
 *     docker run --rm --name sdpy-script-<runId> --pid=host --privileged <image> \
 *       nsenter -t 1 -m -u -i -n -p -- sh -c "cd '<workdir>' && <命令行>"
 *
 *   nsenter 之后就是宿主的挂载/网络/PID 命名空间，等于直接在宿主上执行，
 *   用户脚本里写的 `docker`、宿主的 python3、宿主的 .env 全部可用。
 *
 * 取消执行：kill 掉本地 docker 客户端不会带走容器，必须 `docker rm -f <name>` 才真正终止。
 */
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import {
  assembleCommandLine,
  createRunRecord,
  finishRunRecord,
  getApp,
  shellQuote,
  ScriptError,
} from './script-apps.js';
import { helperContainerArgs } from './host-exec.js';
import type { ScriptParam } from '../types.js';

/** 单次执行的输出上限（防止 yes 之类把库写爆） */
const MAX_OUTPUT_BYTES = 512 * 1024;

/** 默认超时：60 分钟。部署类脚本可能很久，但要留个兜底 */
function runTimeoutMs(): number {
  const n = Number(process.env.SCRIPT_RUN_TIMEOUT_MS ?? '');
  return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000;
}

/** 同时执行上限：脚本可能会装依赖、占端口，挡一下并发 */
function maxConcurrent(): number {
  const n = Number(process.env.SCRIPT_RUN_MAX_CONCURRENT ?? '');
  return Number.isFinite(n) && n > 0 ? n : 3;
}

export type RunEvent =
  | { type: 'start'; runId: string; commandLine: string; workdir: string }
  | { type: 'chunk'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'end'; status: string; exitCode: number | null };

type LiveRun = {
  id: string;
  appId: string;
  containerName: string;
  child: ReturnType<typeof spawn>;
  emitter: EventEmitter;
  output: string;
  bytes: number;
  truncated: boolean;
  status: string;
  exitCode: number | null;
  timer: NodeJS.Timeout | null;
  finished: boolean;
};

/** 正在执行的运行（内存态；历史在 SQLite 里） */
const live = new Map<string, LiveRun>();

export function runningCount(): number {
  return live.size;
}

export function listLiveRuns(): Array<{ runId: string; appId: string; status: string }> {
  return [...live.values()].map((r) => ({ runId: r.id, appId: r.appId, status: r.status }));
}

/* ------------------------------------------------------------------ *
 * 拼接预览（前端在执行前展示「即将运行的完整命令」）
 * ------------------------------------------------------------------ */

export function previewCommand(
  appId: string,
  commandId: string,
  values: Record<string, string>
): { commandLine: string; workdir: string; fullScript: string; commandName: string } {
  const app = getApp(appId);
  if (!app) throw new ScriptError('应用不存在');
  const cmd = app.commands.find((c) => c.id === commandId);
  if (!cmd) throw new ScriptError('命令组不存在');
  const { commandLine } = assembleCommandLine(cmd.mainCommand, cmd.params, values);
  return {
    commandLine,
    workdir: app.workdir,
    fullScript: buildScript(app.workdir, commandLine),
    commandName: cmd.name,
  };
}

/** 真正交给宿主 sh 执行的脚本：先 cd 到根目录，再跑拼接好的命令行 */
function buildScript(workdir: string, commandLine: string): string {
  return `cd ${shellQuote(workdir)} && ${commandLine}`;
}

/* ------------------------------------------------------------------ *
 * 启动执行
 * ------------------------------------------------------------------ */

export function startRun(input: {
  appId: string;
  commandId: string;
  values: Record<string, string>;
  operatorId: string;
}): { runId: string; commandLine: string; workdir: string; commandName: string } {
  const app = getApp(input.appId);
  if (!app) throw new ScriptError('应用不存在');
  if (!app.enabled) throw new ScriptError('应用已停用，请先启用');
  const cmd = app.commands.find((c) => c.id === input.commandId);
  if (!cmd) throw new ScriptError('命令组不存在');

  if (live.size >= maxConcurrent()) {
    throw new ScriptError(`当前已有 ${live.size} 个脚本在执行（上限 ${maxConcurrent()}），请稍后再试`);
  }

  const { commandLine } = assembleCommandLine(cmd.mainCommand, cmd.params, input.values);
  const script = buildScript(app.workdir, commandLine);

  const runId = `srun-${nanoid(12)}`;
  const containerName = `sdpy-script-${runId}`;

  createRunRecord({
    id: runId,
    appId: app.id,
    commandId: cmd.id,
    commandName: cmd.name,
    commandLine,
    paramValues: input.values,
    workdir: app.workdir,
    operatorId: input.operatorId,
  });

  const child = spawn('docker', helperContainerArgs({ name: containerName, script }), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const entry: LiveRun = {
    id: runId,
    appId: app.id,
    containerName,
    child,
    emitter: new EventEmitter(),
    output: '',
    bytes: 0,
    truncated: false,
    status: 'running',
    exitCode: null,
    timer: null,
    finished: false,
  };
  live.set(runId, entry);
  entry.emitter.setMaxListeners(50);

  // 头部要让用户一眼看清「跑的什么、在哪跑的」：
  // 命令给完整脚本（含 cd，而不是只有命令片段），位置显式写出宿主与目录。
  appendOutput(
    entry,
    'stdout',
    `$ ${script}\n[命令组] ${cmd.name}\n[执行位置] 宿主机 ${app.workdir}\n\n`
  );

  child.stdout?.on('data', (buf: Buffer) => appendOutput(entry, 'stdout', buf.toString('utf8')));
  child.stderr?.on('data', (buf: Buffer) => appendOutput(entry, 'stderr', buf.toString('utf8')));

  child.on('error', (err) => {
    appendOutput(entry, 'stderr', `\n[错误] 无法启动执行容器：${err.message}\n`);
    finalize(entry, 'failed', null);
  });

  child.on('close', (code) => {
    if (entry.finished) return;
    // docker run 自身的失败（镜像缺失、docker 不可用）也要归到 failed，别当成脚本成功
    const exitCode = typeof code === 'number' ? code : null;
    finalize(entry, exitCode === 0 ? 'success' : 'failed', exitCode);
  });

  entry.timer = setTimeout(() => {
    appendOutput(entry, 'stderr', `\n[超时] 超过 ${Math.round(runTimeoutMs() / 60000)} 分钟，已强制终止\n`);
    void killContainer(entry).finally(() => finalize(entry, 'timeout', null));
  }, runTimeoutMs());

  entry.emitter.emit('event', {
    type: 'start',
    runId,
    commandLine,
    workdir: app.workdir,
  } satisfies RunEvent);

  return { runId, commandLine, workdir: app.workdir, commandName: cmd.name };
}

function appendOutput(entry: LiveRun, stream: 'stdout' | 'stderr', text: string): void {
  if (!text) return;
  if (entry.bytes < MAX_OUTPUT_BYTES) {
    const remain = MAX_OUTPUT_BYTES - entry.bytes;
    const piece = text.length > remain ? text.slice(0, remain) : text;
    entry.output += piece;
    entry.bytes += piece.length;
    if (piece.length < text.length) {
      entry.truncated = true;
      entry.output += '\n\n[系统] 输出过长已截断，仅保留前 512KB\n';
    }
  }
  entry.emitter.emit('event', { type: 'chunk', stream, text } satisfies RunEvent);
}

function finalize(entry: LiveRun, status: string, exitCode: number | null): void {
  if (entry.finished) return;
  entry.finished = true;
  entry.status = status;
  entry.exitCode = exitCode;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.truncated) {
    entry.output += '\n[系统] 输出已达上限被截断\n';
  }
  finishRunRecord(entry.id, {
    status,
    exitCode,
    output: entry.output.slice(0, 600 * 1024),
  });
  entry.emitter.emit('event', { type: 'end', status, exitCode } satisfies RunEvent);
  // 留一点时间让 SSE 把 end 事件推出去；同时兜底清理容器
  void killContainer(entry).finally(() => {
    setTimeout(() => {
      live.delete(entry.id);
      entry.emitter.removeAllListeners();
    }, 5000);
  });
}

/** 强制删容器：kill 本地客户端不会带走宿主上的容器，必须 docker rm -f */
function killContainer(entry: LiveRun): Promise<void> {
  return new Promise((resolve) => {
    execFile('docker', ['rm', '-f', entry.containerName], { timeout: 20_000 }, () => {
      try {
        entry.child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      resolve();
    });
  });
}

/* ------------------------------------------------------------------ *
 * 取消 / 订阅
 * ------------------------------------------------------------------ */

export async function cancelRun(runId: string): Promise<{ ok: boolean; message: string }> {
  const entry = live.get(runId);
  if (!entry) {
    return { ok: false, message: '该执行已结束或不在本服务实例上' };
  }
  if (entry.finished) return { ok: false, message: '执行已结束' };
  appendOutput(entry, 'stderr', '\n[取消] 收到取消指令，正在终止...\n');
  entry.status = 'canceled';
  await killContainer(entry);
  finalize(entry, 'canceled', null);
  return { ok: true, message: '已终止' };
}

/** 订阅执行事件。返回取消订阅函数；若执行已结束则不再有事件 */
export function subscribe(
  runId: string,
  listener: (ev: RunEvent) => void
): (() => void) | null {
  const entry = live.get(runId);
  if (!entry || entry.finished) return null;
  entry.emitter.on('event', listener);
  return () => entry.emitter.off('event', listener);
}

/** SSE 回放：新接入的连接先把已有输出补上，避免「点进去是空白」 */
export function currentOutput(runId: string): string | null {
  return live.get(runId)?.output ?? null;
}

export function isRunning(runId: string): boolean {
  const e = live.get(runId);
  return Boolean(e && !e.finished);
}

/**
 * 服务启动时清理：上次进程被杀留下的执行容器仍在宿主运行着，
 * 名字前缀是固定约定，可安全批量 clear。
 */
export function cleanupOrphanContainers(): void {
  execFile(
    'docker',
    ['ps', '-aq', '--filter', 'name=sdpy-script-'],
    { timeout: 20_000 },
    (err, stdout) => {
      if (err || !stdout.trim()) return;
      const ids = stdout.trim().split(/\s+/).filter(Boolean);
      if (!ids.length) return;
      execFile('docker', ['rm', '-f', ...ids], { timeout: 30_000 }, () => {
        /* 尽力而为 */
      });
    }
  );
}

export type { ScriptParam };

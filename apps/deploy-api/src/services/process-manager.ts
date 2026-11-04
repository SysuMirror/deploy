/**
 * 主机进程监控与管理：
 * - 数据源：宿主机 /proc（容器内经 /hostproc 只读挂载；容器自身 /proc 只有本容器进程）
 * - listProcesses：读宿主 /proc 生成进程列表（pid/ppid/user/cpu/mem/rss/启动时间/命令行）
 * - killProcess：经 docker.sock 起临时 --pid=host 辅助容器向宿主进程发信号（默认 SIGTERM，可 SIGKILL）
 * - 守护：内存 ≥85% 邮件告警（防抖）；CPU ≥90% 自动 SIGKILL「最新进程」
 *
 * 安全边界：
 * - init(1)/sshd/容器核心进程受保护；killProcess 白名单外进程需要 force 标记。
 */

import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';

/** 宿主机 /proc 挂载点（compose: /proc:/hostproc:ro）；不存在时回退容器自身 /proc */
const HOST_PROC = fs.existsSync('/hostproc/stat') ? '/hostproc' : '/proc';
/** 宿主机 passwd（配合 HOST_PROC；回退时用容器自身 /etc/passwd） */
const HOST_PASSWD = HOST_PROC === '/hostproc' ? '/hostetc/passwd' : '/etc/passwd';

export interface ProcInfo {
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number; // 单核相对整机（含所有核）
  memPercent: number;
  rssMb: number;
  state: string;
  startedAt: string; // ISO
  command: string; // 短命令名
  cmdline: string; // 完整命令行（截断）
  protected: boolean; // 系统保护进程（不可杀）
}

const BOOT_MS = (() => {
  try {
    const btime = /btime (\d+)/.exec(fs.readFileSync(`${HOST_PROC}/stat`, 'utf8'))?.[1];
    if (btime) return Number(btime) * 1000;
  } catch {
    /* ignore */
  }
  return Date.now() - os.uptime() * 1000;
})();

const CLK_TCK = 100; // 常见值；getconf CLK_TCK 通常 100

let lastCpuSnapshot: { total: number; idle: number; perPid: Map<number, number> } | null = null;
/** 守护进程自身的 CPU 采样快照（保证大盘 CPU 不依赖列表被访问；与列表窗口尽量一致） */
let daemonCpuPrev: { total: number; idle: number } | null = null;
/** 最近一次进程采样的系统 CPU 使用率（与进程列表共用同一窗口，保证守护条与列表一致） */
let latestSystemCpu = 0;

/** 宿主机 CPU 核数 / 内存总量（meminfo；容器内 os.totalmem 是宿主值但语义不保证，显式读更稳） */
const HOST_CPUS = os.cpus().length;
const HOST_TOTAL_MEM_MB = (() => {
  try {
    const kb = Number(/MemTotal:\s+(\d+)/.exec(fs.readFileSync(`${HOST_PROC}/meminfo`, 'utf8'))?.[1]);
    if (Number.isFinite(kb) && kb > 0) return kb / 1024;
  } catch {
    /* ignore */
  }
  return os.totalmem() / 1024 / 1024;
})();

/** 宿主机内存占用（MemAvailable 语义，与 free/top 一致） */
function hostMemUsage(): { percent: number; usedMb: number; totalMb: number } {
  try {
    const txt = fs.readFileSync(`${HOST_PROC}/meminfo`, 'utf8');
    const totalKb = Number(/MemTotal:\s+(\d+)/.exec(txt)?.[1]);
    const availKb = Number(/MemAvailable:\s+(\d+)/.exec(txt)?.[1]);
    if (Number.isFinite(totalKb) && Number.isFinite(availKb)) {
      const usedMb = (totalKb - availKb) / 1024;
      const totalMb = totalKb / 1024;
      return { percent: Math.round((usedMb / totalMb) * 1000) / 10, usedMb, totalMb };
    }
  } catch {
    /* ignore */
  }
  const totalMb = os.totalmem() / 1024 / 1024;
  const usedMb = totalMb - os.freemem() / 1024 / 1024;
  return { percent: Math.round((usedMb / totalMb) * 1000) / 10, usedMb, totalMb };
}

function readCpuTimes(): { total: number; idle: number } {
  const fields = fs.readFileSync(`${HOST_PROC}/stat`, 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
  const total = fields.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const idle = fields[3] + (fields[4] || 0);
  return { total, idle };
}

function uidToUser(uid: string): string {
  // 快速路径：root；其余读宿主 passwd（小文件，可接受）
  if (uid === '0') return 'root';
  try {
    const passwd = fs.readFileSync(HOST_PASSWD, 'utf8');
    const line = passwd.split('\n').find((l) => l.endsWith(`:${uid}:`) || l.includes(`:${uid}:`));
    if (line) return line.split(':')[0];
  } catch {
    /* ignore */
  }
  return `uid${uid}`;
}

const PROTECTED_PATTERNS = [
  /^systemd$/,
  /^init$/,
  /^sshd/,
  /^containerd/,
  /^dockerd/,
  /^systemd-/,
  /^dbus-daemon$/,
  /^cron$/,
  /^rsyslogd/,
  /^polkitd/,
  /^snapd$/,
  /^unattended/,
  /^networkd/,
  /^resolved$/,
  /^login$/,
  /^bash$/,
  /^sh$/,
  /^zsh$/,
];

/** 读取宿主机 /proc 全量进程并计算 CPU%（两次采样差） */
export function listProcesses(): Array<ProcInfo> {
  const cpuNow = readCpuTimes();
  const totalNow = cpuNow.total;
  const prev = lastCpuSnapshot;
  const perPidPrev = prev?.perPid ?? new Map<number, number>();
  const perPidNow = new Map<number, number>();
  const out: Array<ProcInfo> = [];
  const nowMs = Date.now();

  let pids: Array<string> = [];
  try {
    pids = fs.readdirSync(HOST_PROC).filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }

  for (const pidStr of pids) {
    try {
      const stat = fs.readFileSync(`${HOST_PROC}/${pidStr}/stat`, 'utf8');
      // comm 可含空格/括号，取最后一个 ')' 之后
      const closeIdx = stat.lastIndexOf(')');
      const comm = stat.slice(stat.indexOf('(') + 1, closeIdx);
      const rest = stat.slice(closeIdx + 2).split(' ');
      // rest[0]=state ppid=rest[1] ... utime=rest[11] stime=rest[12] starttime=rest[19]
      const state = rest[0];
      const ppid = Number(rest[1]);
      const utime = Number(rest[11]);
      const stime = Number(rest[12]);
      const starttime = Number(rest[19]);
      const cpuTicks = utime + stime;

      let uid = '';
      try {
        const status = fs.readFileSync(`${HOST_PROC}/${pidStr}/status`, 'utf8');
        uid = /Uid:\s+(\d+)/.exec(status)?.[1] ?? '';
      } catch {
        /* ignore */
      }

      let cmdline = '';
      try {
        cmdline = fs.readFileSync(`${HOST_PROC}/${pidStr}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      } catch {
        /* ignore */
      }

      let rssMb = 0;
      try {
        const statm = fs.readFileSync(`${HOST_PROC}/${pidStr}/statm`, 'utf8').split(' ');
        const rssPages = Number(statm[1]);
        rssMb = (rssPages * 4096) / 1024 / 1024; // 页大小固定 4KiB（x86_64）
      } catch {
        /* ignore */
      }

      perPidNow.set(Number(pidStr), cpuTicks);
      const prevTicks = perPidPrev.get(Number(pidStr)) ?? cpuTicks;
      const dTicks = Math.max(0, cpuTicks - prevTicks);
      const dTotal = prev ? Math.max(1, totalNow - prev.total) : 1;
      // 差值法：cpu% = 进程 tick 增量 / 总 tick 增量 * 100（跨所有核）
      const cpuPercent = prev ? Math.min(100 * HOST_CPUS, (dTicks / dTotal) * 100) : 0;

      const startedMs = BOOT_MS + (starttime / CLK_TCK) * 1000;
      const isProtected =
        PROTECTED_PATTERNS.some((re) => re.test(comm)) || Number(pidStr) <= 2 || cmdline.startsWith('[');

      out.push({
        pid: Number(pidStr),
        ppid,
        user: uidToUser(uid),
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        memPercent: Math.round((rssMb / HOST_TOTAL_MEM_MB) * 1000) / 10,
        rssMb: Math.round(rssMb * 10) / 10,
        state,
        startedAt: new Date(startedMs).toISOString(),
        command: comm,
        cmdline: cmdline ? cmdline.slice(0, 240) : `[${comm}]`,
        protected: isProtected,
      });
    } catch {
      /* 进程可能已退出 */
    }
  }

  lastCpuSnapshot = { total: totalNow, idle: cpuNow.idle, perPid: perPidNow };
  // 用同一采样窗口计算整机 CPU 使用率（1 - idle 增量 / total 增量），与进程列表共用快照
  if (prev) {
    const dTotalCpu = Math.max(1, totalNow - prev.total);
    const dIdle = Math.max(0, cpuNow.idle - prev.idle);
    latestSystemCpu = Math.round(Math.min(100, (1 - dIdle / dTotalCpu) * 100) * 10) / 10;
  }
  // 首次调用 cpuPercent 全 0，调用方应连续采样（路由层每 3s 刷新前端自动二次拉取）
  return out.sort((a, b) => b.cpuPercent - a.cpuPercent || b.rssMb - a.rssMb);
}

/** 返回最近一次进程采样计算出的系统 CPU 使用率（未采样过返回 0） */
export function getLatestSystemCpu(): number {
  return latestSystemCpu;
}

/** 杀宿主机进程；经 docker.sock 起临时 --pid=host 辅助容器发信号（容器内 process.kill 到不了宿主 PID 命名空间） */
export function killProcess(pid: number, opts?: { force?: boolean }): { ok: boolean; message: string } {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, message: '非法 PID' };
  const target = listProcesses().find((p) => p.pid === pid);
  if (!target) return { ok: false, message: `进程 ${pid} 不存在或已退出` };
  if (target.protected && !opts?.force) {
    return { ok: false, message: `进程 ${pid}（${target.command}）为系统保护进程，禁止终止` };
  }
  const signal = opts?.force ? 'SIGKILL' : 'SIGTERM';
  const r = killViaHost(pid, signal);
  if (r.ok) return { ok: true, message: `已向 PID ${pid}（${target.command}）发送 ${signal}` };
  // 宿主 kill 辅助失败时，若目标恰在本容器命名空间（同 PID 可见）再试 process.kill
  try {
    process.kill(pid, 0);
    process.kill(pid, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
    return { ok: true, message: `已向 PID ${pid}（${target.command}）发送 ${signal}（容器内）` };
  } catch {
    return r;
  }
}

/**
 * 经宿主 docker 发信号：
 * docker run --rm --pid=host <node 镜像> kill -<SIGNAL> <pid>
 * 辅助容器与宿主共享 PID 命名空间，kill 可直达任意宿主进程。
 */
function killViaHost(pid: number, signal: string): { ok: boolean; message: string } {
  const shortSignal = signal.replace('SIG', '').toLowerCase();
  const image = process.env.HOST_KILL_IMAGE || 'docker.m.daocloud.io/library/alpine:3.20';
  const args = [
    'run', '--rm', '--pid=host', '--privileged', image,
    'kill', `-${shortSignal}`, String(pid),
  ];
  try {
    execFileSync('docker', args, { timeout: 30_000, stdio: 'pipe' });
    return { ok: true, message: 'ok' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `宿主 kill 失败: ${msg.slice(0, 200)}` };
  }
}

/** —— 内存 守护：告警 + 内存 ≥95% 自动杀最大进程 —— */

/** 内存强杀阈值（默认 95%） */
const MEM_KILL_THRESHOLD = Number(process.env.MEM_KILL_THRESHOLD || 95);
/** 内存告警阈值（默认 85%） */
const MEM_WARN_THRESHOLD = Number(process.env.MEM_ALERT_THRESHOLD || 85);
/** 连续超阈值采样数（守护 10s 一轮） */
const WARN_STREAK = 3;
const KILL_STREAK = 6;

let daemonTimer: ReturnType<typeof setInterval> | null = null;
let killStreak = 0;
let memWarnStreak = 0;
let lastKillAt = 0;
let lastMemWarnAt = 0;
export const daemonState = {
  lastCpu: 0,
  lastMemPercent: 0,
  memUsedMb: 0,
  memTotalMb: 0,
  killStreak: 0,
  memWarnStreak: 0,
  lastKillAt: null as string | null,
  lastKillInfo: null as string | null,
  lastMemWarnAt: null as string | null,
};

function memUsage(): { percent: number; usedMb: number; totalMb: number } {
  return hostMemUsage();
}

/** 告警邮件（内存超阈值 / 强杀通知） */
async function sendAlertMail(
  kind: 'mem',
  value: number,
  extra: string
): Promise<void> {
  try {
    const { sendMail, adminRecipients } = await import('./mailer.js');
    const recipients = adminRecipients();
    if (!recipients.length) return;
    // 内存告警/强杀：按 RSS 降序取 Top5（默认按 CPU 排序会漏掉真正吃内存的进程）
    const procs = listProcesses();
    const sorted = [...procs].sort((a, b) => b.rssMb - a.rssMb);
    const top = sorted.slice(0, 5);
    const totalMemMb = HOST_TOTAL_MEM_MB;
    // 该进程占系统总内存百分比（RSS / 总内存）
    const pct = (mb: number) => ((mb / totalMemMb) * 100).toFixed(1);
    const rows = top
      .map(
        (p) =>
          `<tr><td>${p.pid}</td><td>${p.user}</td><td>${p.cpuPercent}%</td><td>${p.rssMb} MB（${pct(p.rssMb)}%）</td><td><code>${p.cmdline}</code></td></tr>`
      )
      .join('');
    const title = '内存占用过高告警';
    const valLine = `当前内存使用率 <b style="color:#dc2626;font-size:1.3em">${value.toFixed(1)}%</b>（阈值 ${MEM_WARN_THRESHOLD}%，强杀 ${MEM_KILL_THRESHOLD}%）`;
    const memTotalGb = (HOST_TOTAL_MEM_MB / 1024).toFixed(1);
    const rssSumGb = (top.reduce((a, p) => a + p.rssMb, 0) / 1024).toFixed(1);
    await sendMail({
      to: recipients.map((r) => r.email),
      subject: `【SSE Deploy】服务器 ${title} ${value.toFixed(1)}%`,
      html: `
        <div style="font-family: -apple-system, 'Segoe UI', sans-serif; max-width: 640px;">
          <h2 style="color:#dc2626;">服务器 ${title}</h2>
          <p>${valLine}。${extra}</p>
          <p>主机：${os.hostname()} · 时间：${new Date().toLocaleString('zh-CN', { hour12: false })}</p>
          <p style="background:#f8fafc;border-radius:8px;padding:8px 10px;font-size:12.5px;color:#475569;">
            说明：系统"已用内存"按 <b>MemTotal − MemAvailable</b> 计算，包含 <b>文件页缓存（page cache）</b> 等可回收部分；
            下表进程<b>内存</b>为各进程自身的 <b>RSS（常驻内存）</b>，两者口径不同，故相加通常小于系统"已用"。总内存 ${memTotalGb} GB，Top 进程 RSS 合计约 ${rssSumGb} GB。
          </p>
          <h3>资源占用 Top 5 进程</h3>
          <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;">
            <thead><tr style="background:#f8fafc;"><th>PID</th><th>用户</th><th>CPU</th><th>内存(RSS)</th><th>命令</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="color:#64748b;">可前往 SSE Deploy 监控中心 → 进程管理 处理。</p>
        </div>`,
    });
  } catch {
    /* 邮件失败不打断守护 */
  }
}

/** 守护一轮：返回本轮动作描述 */
async function daemonTick(): Promise<string> {
  // CPU：守护自行差分采样 /proc/stat（不依赖列表被访问），并同步 latestSystemCpu 使列表窗口一致
  const cur = readCpuTimes();
  let cpu = 0;
  if (daemonCpuPrev) {
    const dTotal = Math.max(1, cur.total - daemonCpuPrev.total);
    const dIdle = Math.max(0, cur.idle - daemonCpuPrev.idle);
    cpu = Math.round(Math.min(100, (1 - dIdle / dTotal) * 100) * 10) / 10;
  }
  daemonCpuPrev = cur;
  daemonState.lastCpu = cpu;
  latestSystemCpu = cpu; // 供 listProcesses 采样窗口对齐

  // 内存采样（瞬时值，无需差分）
  const mem = memUsage();
  daemonState.lastMemPercent = mem.percent;
  daemonState.memUsedMb = Math.round(mem.usedMb);
  daemonState.memTotalMb = Math.round(mem.totalMb);

  const actions: Array<string> = [];

  // ===== 已取消 CPU 告警/强杀（按需求仅保留内存告警 + 内存强杀） =====

  // 内存告警（≥85%，连续 3 轮，1 小时防抖）
  if (mem.percent >= MEM_WARN_THRESHOLD) {
    memWarnStreak += 1;
    if (memWarnStreak >= WARN_STREAK && Date.now() - lastMemWarnAt > 3_600_000) {
      lastMemWarnAt = Date.now();
      daemonState.lastMemWarnAt = new Date().toISOString();
      void sendAlertMail('mem', mem.percent, `已用 ${Math.round(mem.usedMb)} MB / 共 ${Math.round(mem.totalMb)} MB。`);
      actions.push(`内存告警邮件已触发（${mem.percent.toFixed(1)}%）`);
    }
  } else {
    memWarnStreak = 0;
  }

  // 内存强杀（≥95%，连续 6 轮 = 约 1 分钟持续高占用，10 分钟防抖）
  const memKill = mem.percent >= MEM_KILL_THRESHOLD;
  if (memKill) {
    killStreak += 1;
    if (killStreak >= KILL_STREAK && Date.now() - lastKillAt > 600_000) {
      // 「内存最大进程」= RSS 最高的非保护、非本服务自身进程
      const procs = listProcesses()
        .filter((p) => !p.protected && p.pid !== process.pid && p.rssMb > 0)
        .sort((a, b) => b.rssMb - a.rssMb);
      const victim = procs[0];
      lastKillAt = Date.now();
      daemonState.lastKillAt = new Date().toISOString();
      if (victim) {
        const r = killProcess(victim.pid, { force: true });
        daemonState.lastKillInfo = `PID ${victim.pid} ${victim.command}（${victim.rssMb}MB）: ${r.message}`;
        actions.push(`内存 ${mem.percent.toFixed(1)}% ≥ ${MEM_KILL_THRESHOLD}%：${daemonState.lastKillInfo}`);
        void sendAlertMail('mem', mem.percent, `内存 ${mem.percent.toFixed(1)}% ≥ ${MEM_KILL_THRESHOLD}%，已自动强制终止内存最大进程 PID ${victim.pid}（${victim.command}，RSS ${victim.rssMb}MB）。`);
      } else {
        daemonState.lastKillInfo = '无合适目标进程';
        actions.push(`内存 ${mem.percent.toFixed(1)}% ≥ ${MEM_KILL_THRESHOLD}%：未找到可终止的目标进程`);
      }
    }
  } else {
    killStreak = 0;
  }

  daemonState.killStreak = killStreak;
  daemonState.memWarnStreak = memWarnStreak;
  return actions.join('；');
}

/** 启动守护（index.ts 启动时调用） */
export function startCpuDaemon(): void {
  if (daemonTimer) return;
  // 每 10s 一轮（内含 1s 采样窗）
  daemonTimer = setInterval(() => {
    void daemonTick().catch(() => {});
  }, 10_000);
  daemonTimer.unref();
}

export function stopCpuDaemon(): void {
  if (daemonTimer) clearInterval(daemonTimer);
  daemonTimer = null;
}

/**
 * 网关访问日志：tail 公共 nginx access.log → sqlite（ingest_logs）。
 *
 * 设计要点：
 * - nginx 容器日志通过宿主机软链 /root/SSE_Market/nginx_logs/access.log →
 *   docker 容器 stdout（容器内 access.log → /dev/stdout，docker json-file 落盘）。
 *   deploy-api 只读宿主机文件（tail -F 跟随轮转），不侵入 nginx 容器。
 * - API 路由归一：/api/auth/showPcomments?、/ai-platform/、/ai-platform-api/
 *   等具体路径收敛为「API 名」（去 query、数字/哈希段替换为 :id），
 *   供聚合图表与模块映射使用。
 * - 模块映射：模块 API 路径 /<module>-api/ → module id；子域名 host → module；
 *   平台自身 /api/* 归 module='__platform__'。
 * - 采集节奏：tail -F 流式逐行解析，断流自动重连；分钟级定时器补全机器指标。
 */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { db } from '../db/init.js';
import os from 'os';

const LOG_DIR = process.env.NGINX_LOG_DIR || '/root/SSE_Market/nginx_logs';
const ACCESS_LOG = join(LOG_DIR, 'access.log');
const ERROR_LOG = join(LOG_DIR, 'error.log');
/** 网关 nginx 容器名（用于 docker inspect 解析 json-file 日志路径） */
const NGINX_PROXY_CONTAINER = process.env.NGINX_PROXY_CONTAINER || 'sse_market_server-nginx_proxy-1';

/** 状态保留窗口：明细 7 天，分钟聚合 30 天 */
const RETAIN_DETAIL_DAYS = 7;
const RETAIN_MINUTE_DAYS = 30;
/** 机器指标保留 3 天（10s 粒度） */
const RETAIN_METRIC_DAYS = 3;

let tailProc: ChildProcessWithoutNullStreams | null = null;
let restartedAt = 0;
let stopped = false;

function join(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/');
}

/** —— 端到端 ingest：与 PlatformIngest 兼容的最小类型 —— */
type NginxLogLine = {
  time_local?: string;
  remote_addr?: string;
  request?: string;
  status?: string | number;
  body_bytes_sent?: string | number;
  http_referer?: string;
  http_user_agent?: string;
  request_time?: string | number;
  upstream_response_time?: string | number;
  host?: string;
};

/** sqlite 表：ingest_logs（兼容监控页查询） */
function ensureIngestTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ingest_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      ts_min TEXT NOT NULL,
      host TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      api TEXT NOT NULL DEFAULT '',
      module_id TEXT NOT NULL DEFAULT '',
      status INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      request_time_ms REAL NOT NULL DEFAULT 0,
      upstream_time_ms REAL NOT NULL DEFAULT 0,
      remote_addr TEXT NOT NULL DEFAULT '',
      referer TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_ingest_ts ON ingest_logs(ts);
    CREATE INDEX IF NOT EXISTS idx_ingest_module_ts ON ingest_logs(module_id, ts);
    CREATE INDEX IF NOT EXISTS idx_ingest_api_ts ON ingest_logs(api, ts);

    CREATE TABLE IF NOT EXISTS ingest_minutes (
      minute TEXT NOT NULL,
      module_id TEXT NOT NULL DEFAULT '',
      api TEXT NOT NULL DEFAULT '',
      host TEXT NOT NULL DEFAULT '',
      total INTEGER NOT NULL DEFAULT 0,
      s2xx INTEGER NOT NULL DEFAULT 0,
      s3xx INTEGER NOT NULL DEFAULT 0,
      s4xx INTEGER NOT NULL DEFAULT 0,
      s5xx INTEGER NOT NULL DEFAULT 0,
      err INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      time_ms REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (minute, api, module_id, host)
    );

    CREATE TABLE IF NOT EXISTS ingest_metrics (
      ts TEXT PRIMARY KEY,
      cpu_percent REAL NOT NULL DEFAULT 0,
      mem_used_mb REAL NOT NULL DEFAULT 0,
      mem_total_mb REAL NOT NULL DEFAULT 0,
      load1 REAL NOT NULL DEFAULT 0,
      load5 REAL NOT NULL DEFAULT 0,
      load15 REAL NOT NULL DEFAULT 0,
      disk_used_gb REAL NOT NULL DEFAULT 0,
      disk_total_gb REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ingest_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

/** —— API 归一：把具体路径收敛为「API 名」 —— */
export function normalizeApi(path: string): string {
  let p = (path || '/').split('?')[0].split('#')[0];
  if (!p.startsWith('/')) p = `/${p}`;
  // 去尾斜杠（保留根）
  if (p.length > 1) p = p.replace(/\/+$/, '');
  // 数字 / 长哈希 / UUID / 十六进制串 → :id
  p = p
    .replace(/\/[0-9a-fA-F]{8,}\b/g, '/:id')
    .replace(/\/\d+(?=\/|$|\.)|\b\d{4,}\b(?=\/|$)/g, '/:id')
    .replace(/\/:id(?=\/:id)/g, '/:id');
  // 文件扩展名路径（.png/.jpg 等）保持原样，前端可识别静态资源
  return p || '/';
}

/** —— 模块映射：路径 → 模块名（deploy 库 modules 表 / nginx 路由规则） —— */
/** 路径 → 模块 id（sdpy 路径模式：/{module}/、/{module}-api/、/test/{module}[-api]/） */
function pathModule(path: string): string {
  const p = path.split('?')[0];
  const m = /^\/(?:test\/)?([a-zA-Z0-9_-]+?)(?:-api)?(?:\/|$)/.exec(p);
  if (m) {
    try {
      const row = db
        .prepare('SELECT id FROM modules WHERE name = ? LIMIT 1')
        .get(m[1]) as { id: string } | undefined;
      if (row) return row.id;
    } catch {
      /* ignore */
    }
  }
  // 平台自身 API / sdpy-api
  if (/^\/api(\/|$)/.test(p) || /^\/sdpy-api(\/|$)/.test(p)) return '__platform__';
  return '';
}

/** host → 模块 id（子域名模式，如 platform.ssemarket.cn → module_domains.module_id） */
function hostModule(host: string): string {
  if (!host) return '';
  try {
    const row = db
      .prepare('SELECT module_id FROM module_domains WHERE host = ? AND enabled = 1 LIMIT 1')
      .get(host.toLowerCase()) as { module_id: string } | undefined;
    return row?.module_id ?? '';
  } catch {
    return '';
  }
}

/** 解析单行 nginx 标准 combined 日志（也可为 json 格式，宽松兼容） */
export function parseNginxLine(line: string): NginxLogLine | null {
  const raw = line.trim();
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try {
      return JSON.parse(raw) as NginxLogLine;
    } catch {
      /* fallthrough */
    }
  }
  // combined: $remote_addr - $remote_user [$time_local] "REQ" status bytes "ref" "ua"
  // sdpy_ext 扩展：尾部附 sdpy_host="$host" sdpy_rt=$request_time
  const re =
    /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) (\d+|-)(?: "([^"]*)" "([^"]*)")?(?:.*?sdpy_host="([^"]*)")?(?:.*?sdpy_rt=([\d.]+))?.*$/;
  const m = re.exec(raw);
  if (!m) return null;
  const reqParts = (m[3] || '').split(' ');
  return {
    remote_addr: m[1],
    time_local: m[2],
    request: m[3],
    status: Number(m[4]),
    body_bytes_sent: m[5] === '-' ? 0 : Number(m[5]),
    http_referer: m[6] || '',
    http_user_agent: m[7] || '',
    host: m[8] || '',
    request_time: m[9] || 0,
  };
}

function parseTimeLocal(t: string): Date | null {
  // 01/Sep/2026:10:00:00 +0800
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?$/.exec(t);
  if (!m) return null;
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const mon = months[m[2]];
  if (mon === undefined) return null;
  const iso = `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[1]}T${m[4]}:${m[5]}:${m[6]}${
    m[7] ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : 'Z'
  }`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 解析 "METHOD /path HTTP/x.y" */
function parseRequest(req: string): { method: string; path: string } {
  const parts = req.split(' ');
  if (parts.length >= 2) {
    return { method: parts[0], path: parts[1] };
  }
  return { method: '', path: req };
}

const insertLog = () =>
  db.prepare(
    `INSERT INTO ingest_logs
     (ts, ts_min, host, method, path, api, module_id, status, bytes, request_time_ms, upstream_time_ms, remote_addr, referer, user_agent)
     VALUES (@ts, @tsMin, @host, @method, @path, @api, @moduleId, @status, @bytes, @requestTimeMs, @upstreamTimeMs, @remoteAddr, @referer, @userAgent)`
  );

const minuteBuffer = new Map<string, {
  total: number; s2xx: number; s3xx: number; s4xx: number; s5xx: number;
  err: number; bytes: number; timeMs: number;
}>();

function upsertMinute(key: { minute: string; moduleId: string; api: string; host: string }, st: number, bytes: number, timeMs: number): void {
  const k = `${key.minute}|${key.moduleId}|${key.api}|${key.host}`;
  let agg = minuteBuffer.get(k);
  if (!agg) {
    agg = { total: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, err: 0, bytes: 0, timeMs: 0 };
    minuteBuffer.set(k, agg);
  }
  agg.total += 1;
  if (st >= 200 && st < 300) agg.s2xx += 1;
  else if (st >= 300 && st < 400) agg.s3xx += 1;
  else if (st >= 400 && st < 500) agg.s4xx += 1;
  else if (st >= 500) agg.s5xx += 1;
  if (st >= 500) agg.err += 1;
  agg.bytes += bytes;
  agg.timeMs += timeMs;
}

export function flushMinuteBuffer(): void {
  if (!minuteBuffer.size) return;
  const upsert = db.prepare(
    `INSERT INTO ingest_minutes (minute, module_id, api, host, total, s2xx, s3xx, s4xx, s5xx, err, bytes, time_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(minute, api, module_id, host) DO UPDATE SET
       total = total + excluded.total,
       s2xx = s2xx + excluded.s2xx,
       s3xx = s3xx + excluded.s3xx,
       s4xx = s4xx + excluded.s4xx,
       s5xx = s5xx + excluded.s5xx,
       err = err + excluded.err,
       bytes = bytes + excluded.bytes,
       time_ms = time_ms + excluded.time_ms`
  );
  const tx = db.transaction(() => {
    for (const [k, v] of minuteBuffer) {
      const [minute, moduleId, api, host] = k.split('|');
      upsert.run(minute, moduleId, api, host, v.total, v.s2xx, v.s3xx, v.s4xx, v.s5xx, v.err, v.bytes, v.timeMs);
    }
  });
  tx();
  minuteBuffer.clear();
}

/** 解析 docker json-file 包裹行：{"log":"...","stream":"stdout","time":"..."} → 内层 nginx 行 */
function unwrapDockerJson(line: string): string {
  const raw = line.trim();
  if (!raw.startsWith('{"log":')) return raw;
  try {
    const obj = JSON.parse(raw) as { log?: string };
    return (obj.log ?? '').replace(/\n$/, '');
  } catch {
    return raw;
  }
}

/** 处理一行日志并落库 */
export function ingestLine(line: string): boolean {
  const inner = unwrapDockerJson(line);
  const parsed = parseNginxLine(inner);
  if (!parsed) return false;
  const { method = '', path = '/' } = parseRequest(parsed.request || '');
  const status = Number(parsed.status || 0);
  const d = parsed.time_local ? parseTimeLocal(parsed.time_local) : new Date();
  const ts = (d ?? new Date()).toISOString();
  const minute = ts.slice(0, 16);
  const host = (parsed.host || '').toLowerCase();
  const api = normalizeApi(path);
  // 模块归属：子域名 host → 模块；路径模式 /{module}[-api]/ → 模块；其余（平台自身站点）→ __platform__
  const moduleId = hostModule(host) || pathModule(path) || '__platform__';

  try {
    insertLog().run({
      ts,
      tsMin: minute,
      host,
      method,
      path: path.slice(0, 500),
      api: api.slice(0, 300),
      moduleId: moduleId.slice(0, 80),
      status,
      bytes: Number(parsed.body_bytes_sent || 0),
      requestTimeMs: Number(parsed.request_time || 0) * 1000,
      upstreamTimeMs: Number(parsed.upstream_response_time || 0) * 1000,
      remoteAddr: parsed.remote_addr || '',
      referer: (parsed.http_referer || '').slice(0, 300),
      userAgent: (parsed.http_user_agent || '').slice(0, 200),
    });
    upsertMinute(
      { minute, moduleId, api, host },
      status,
      Number(parsed.body_bytes_sent || 0),
      Number(parsed.request_time || 0) * 1000
    );
    return true;
  } catch {
    return false;
  }
}

/** —— 机器指标采集 —— */
export function collectMachineMetrics(): void {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load = os.loadavg();
  // CPU 使用率用两次采样差值；首次以 0 记录
  const stat = readProcStat();
  const prev = lastCpuStat;
  lastCpuStat = stat;
  let cpuPercent = 0;
  if (prev && stat) {
    const dIdle = stat.idle - prev.idle;
    const dTotal = stat.total - prev.total;
    if (dTotal > 0) cpuPercent = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  }
  let diskUsed = 0;
  let diskTotal = 0;
  try {
    const st = statSyncOs();
    diskUsed = st.usedGb;
    diskTotal = st.totalGb;
  } catch {
    /* 磁盘信息失败不阻塞 */
  }
  db.prepare(
    `INSERT OR REPLACE INTO ingest_metrics
     (ts, cpu_percent, mem_used_mb, mem_total_mb, load1, load5, load15, disk_used_gb, disk_total_gb)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    cpuPercent,
    (totalMem - freeMem) / 1024 / 1024,
    totalMem / 1024 / 1024,
    load[0],
    load[1],
    load[2],
    diskUsed,
    diskTotal
  );
}

let lastCpuStat: { idle: number; total: number } | null = null;

function readProcStat(): { idle: number; total: number } | null {
  try {
    const first = readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = first.split(/\s+/).slice(1).map(Number);
    if (parts.length < 5) return null;
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

function statSyncOs(): { usedGb: number; totalGb: number } {
  // /proc/mounts 粗略取根分区用量；docker overlay 也读得到
  try {
    const out = execFileSync('df', ['-k', '/'], { encoding: 'utf8' });
    const lines = out.trim().split('\n');
    const last = lines[lines.length - 1].split(/\s+/);
    const totalKb = Number(last[1]);
    const usedKb = Number(last[2]);
    return { usedGb: usedKb / 1024 / 1024, totalGb: totalKb / 1024 / 1024 };
  } catch {
    return { usedGb: 0, totalGb: 0 };
  }
}

/** 清理过期数据（每小时调用） */
export function cleanupOldLogs(): void {
  try {
    db.prepare(`DELETE FROM ingest_logs WHERE ts < datetime('now', ?)`)
      .run(`-${RETAIN_DETAIL_DAYS} days`);
    db.prepare(`DELETE FROM ingest_minutes WHERE minute < datetime('now', ?)`)
      .run(`-${RETAIN_MINUTE_DAYS} days`);
    db.prepare(`DELETE FROM ingest_metrics WHERE ts < datetime('now', ?)`)
      .run(`-${RETAIN_METRIC_DAYS} days`);
    // 清理后统计信息会失真（没有 stats 时聚合查询会选错索引，见监控页变慢事故）。
    // 明细表 4000 万行：ANALYZE 全索引扫描会同步阻塞 API 几分钟，故限制采样行数。
    db.pragma('analysis_limit = 1000');
    db.pragma('optimize');
  } catch {
    /* ignore */
  }
}

/**
 * 解析网关 nginx 容器日志文件路径：
 * 1. 显式挂载文件（LOG_DIR/access.log 存在即用）；
 * 2. docker inspect 读 HostConfig.LogConfig（json-file）→ /var/lib/docker/containers/<id>/<id>-json.log；
 * 3. 兜底：/proc/<docker-pid>/fd/1 的目标。
 */
function resolveAccessLogPath(): string {
  const mounted = join(LOG_DIR, 'access.log');
  if (existsSync(mounted)) return mounted;
  try {
    const out = execFileSync(
      'docker',
      ['inspect', '-f', '{{.Id}}', NGINX_PROXY_CONTAINER],
      { encoding: 'utf8' }
    ).trim();
    if (/^[a-f0-9]{64}$/.test(out)) {
      return `/var/lib/docker/containers/${out}/${out}-json.log`;
    }
  } catch {
    /* docker inspect 失败继续兜底 */
  }
  return mounted;
}

/** —— tail -F 跟随 nginx access.log（断流重连，从文件末尾开始） —— */
function startTail(): void {
  if (stopped) return;
  const logPath = resolveAccessLogPath();
  if (!existsSync(logPath)) {
    mkdirSync(LOG_DIR, { recursive: true });
    // 文件不存在时等下次重试；期间 nginx 可能还没启动
    setTimeout(startTail, 15_000).unref();
    return;
  }
  const proc = spawn('tail', ['-F', '-n', '0', logPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams;
  tailProc = proc;
  restartedAt = Date.now();
  activeLogPath = logPath;

  const rl = createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    try {
      ingestLine(line);
    } catch {
      /* 单行失败不中断 */
    }
  });
  proc.stderr?.on('data', () => {
    /* tail 报警仅忽略 */
  });
  proc.on('exit', () => {
    tailProc = null;
    if (stopped) return;
    // 断流重连（限频 5s）
    const wait = Math.max(0, 5_000 - (Date.now() - restartedAt));
    setTimeout(startTail, wait).unref();
  });
  proc.on('error', () => {
    try { proc.kill(); } catch { /* ignore */ }
  });
}

/** 定时器句柄集合 */
const timers: NodeJS.Timeout[] = [];

/** 启动采集（进程启动调用一次） */
export function startAccessLogCollector(): void {
  stopped = false;
  ensureIngestTables();
  startTail();
  // 分钟聚合每 30s flush 一次
  timers.push(setInterval(flushMinuteBuffer, 30_000).unref());
  // 机器指标：10s 一次
  timers.push(setInterval(collectMachineMetrics, 10_000).unref());
  // 清理：每小时
  timers.push(setInterval(cleanupOldLogs, 3_600_000).unref());
}

export function stopAccessLogCollector(): void {
  stopped = true;
  for (const t of timers) clearInterval(t);
  if (tailProc) {
    try { tailProc.kill(); } catch { /* ignore */ }
    tailProc = null;
  }
}

/** 采集状态（监控页展示） */
let activeLogPath = '';

export function collectorStatus(): { running: boolean; logPath: string; restartedAt: string | null } {
  return {
    running: Boolean(tailProc),
    logPath: activeLogPath || ACCESS_LOG,
    restartedAt: restartedAt ? new Date(restartedAt).toISOString() : null,
  };
}

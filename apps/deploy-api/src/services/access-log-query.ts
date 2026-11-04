/**
 * 访问日志查询：模块级明细 / 聚合、平台总览时序、机器运行状态。
 * 权限在 routes 层做（canReadModule / 平台管理员）。
 */
import { db } from '../db/init.js';
import os from 'os';
import { execFileSync } from 'child_process';

export type AccessLogQuery = {
  moduleId?: string;
  api?: string;
  method?: string;
  statusClass?: string; // 1xx/2xx/3xx/4xx/5xx
  host?: string;
  q?: string; // 路径模糊
  from?: string; // ISO
  to?: string; // ISO
  limit?: number;
  offset?: number;
};

type LogRow = {
  id: number;
  ts: string;
  host: string;
  method: string;
  path: string;
  api: string;
  module_id: string;
  status: number;
  bytes: number;
  request_time_ms: number;
  upstream_time_ms: number;
  remote_addr: string;
};

function buildWhere(q: AccessLogQuery, alias = ''): { sql: string; params: unknown[] } {
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (q.moduleId) {
    clauses.push(`${col('module_id')} = ?`);
    params.push(q.moduleId);
  }
  if (q.api) {
    clauses.push(`${col('api')} = ?`);
    params.push(q.api);
  }
  if (q.method) {
    clauses.push(`${col('method')} = ?`);
    params.push(q.method.toUpperCase());
  }
  if (q.statusClass) {
    const m = /^([1-5])xx$/.exec(q.statusClass);
    if (m) {
      clauses.push(`${col('status')} >= ? AND ${col('status')} < ?`);
      params.push(Number(`${m[1]}00`), Number(`${m[1]}00`) + 100);
    } else {
      // 未知取值直接给出空集，避免静默忽略过滤条件、看起来像「过滤不生效」
      clauses.push('0');
    }
  }
  if (q.host) {
    clauses.push(`${col('host')} = ?`);
    params.push(q.host.toLowerCase());
  }
  if (q.q) {
    clauses.push(`(${col('path')} LIKE ? OR ${col('api')} LIKE ?)`);
    const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  if (q.from) {
    clauses.push('ts >= ?');
    params.push(q.from);
  }
  if (q.to) {
    clauses.push('ts <= ?');
    params.push(q.to);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/* ────────────────────────── 时间范围（预设 / 自定义） ────────────────────────── */

/** 自定义时间跨度硬上限：1 天。超过直接报错（路由转 400），避免一次拉爆整库 */
export const MAX_RANGE_MINUTES = 1440;

export type MonitorTimeRange = {
  /** 'YYYY-MM-DDTHH:MM'，UTC —— 与 ingest_minutes.minute / ingest_logs.ts 同口径 */
  from: string;
  to: string;
  spanMinutes: number;
  /** 服务端聚合粒度（分钟）。长跨度下按此分桶，避免点数爆炸 */
  bucketMinutes: number;
};

/**
 * 任意时间串 → UTC 分钟串（'YYYY-MM-DDTHH:MM'）。
 * 不带时区的裸串按 UTC 解释，与 ingest_* 存储口径一致（采集侧用的是 toISOString）。
 */
function toUtcMinute(v: string): string | null {
  const raw = v.trim();
  if (!raw) return null;
  const iso = /(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 16);
}

/**
 * 自动选择聚合粒度：目标 ≤180 点。
 * 既保留曲线形态，又让 24h 跨度只回 144 点（而非 1440 点 × N 个 API）。
 */
function pickBucketMinutes(spanMinutes: number, requested?: number): number {
  if (requested && Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.max(Math.floor(requested), 1), MAX_RANGE_MINUTES);
  }
  const TARGET = 180;
  for (const step of [1, 2, 5, 10, 15, 30, 60, 120, 360]) {
    if (spanMinutes / step <= TARGET) return step;
  }
  return MAX_RANGE_MINUTES;
}

/**
 * 解析监控时间范围：优先 from/to（自定义），否则用 minutes（预设）。
 * 非法输入抛 RangeError，由路由层转成 400。
 */
export function resolveTimeRange(opts: {
  from?: string;
  to?: string;
  minutes?: number;
  bucket?: number;
}): MonitorTimeRange {
  const nowMinute = new Date().toISOString().slice(0, 16);

  let to = opts.to ? toUtcMinute(opts.to) : nowMinute;
  if (opts.to && !to) throw new RangeError('to 时间格式无法解析');
  // 监控数据不存在于未来；clamp 到当前分钟，避免选到未来时段后整屏空白（看着像坏了）
  if (to! > nowMinute) to = nowMinute;

  let from = opts.from ? toUtcMinute(opts.from) : null;
  if (opts.from && !from) throw new RangeError('from 时间格式无法解析');
  const fallback = Math.min(Math.max(Math.floor(opts.minutes ?? 60), 5), MAX_RANGE_MINUTES);
  if (!from) {
    from = new Date(Date.parse(`${to}:00Z`) - fallback * 60_000).toISOString().slice(0, 16);
  }
  if (from > to!) throw new RangeError('起始时间不能晚于结束时间');

  const spanMinutes = Math.max(
    1,
    Math.round((Date.parse(`${to}:00Z`) - Date.parse(`${from}:00Z`)) / 60_000)
  );
  if (spanMinutes > MAX_RANGE_MINUTES) {
    throw new RangeError(
      `时间跨度最多 ${MAX_RANGE_MINUTES / 60} 小时（当前 ${Math.round((spanMinutes / 60) * 10) / 10} 小时）`
    );
  }

  return { from, to: to!, spanMinutes, bucketMinutes: pickBucketMinutes(spanMinutes, opts.bucket) };
}

/**
 * minute 列按 bucket 向下取整到桶起点。
 *
 * 必须显式 CAST 成 INTEGER：better-sqlite3 绑定 JS number 时可能按 REAL 传参，
 * 而 REAL 除法 `(x / b) * b` 会浮点还原成 x 本身 —— 即「乘回去正好抵消」，
 * 分桶完全失效（表现为拿到的还是分钟级点，长区间响应体暴涨数倍）。
 */
function bucketExpr(alias = 'minute', bind = '@bucketSec'): string {
  const sec = `CAST(strftime('%s', ${alias}) AS INTEGER)`;
  const b = `CAST(${bind} AS INTEGER)`;
  return `substr(replace(datetime((${sec} / ${b}) * ${b}, 'unixepoch'), ' ', 'T'), 1, 16)`;
}

/**
 * 按粒度铺满整个区间的桶起点列表。
 *
 * 为什么要服务端生成：库里只有「有流量的分钟」，若前端用数据里出现过的桶拼横轴，
 * 空闲时段会被压缩、自定义区间两端也可能缺格，看着像时间轴对不上。
 * 首桶可能早于 from（部分桶），与 SQL 端的向下取整口径一致。
 */
function bucketStarts(range: MonitorTimeRange): string[] {
  const step = range.bucketMinutes * 60_000;
  const startMs = Math.floor(Date.parse(`${range.from}:00Z`) / step) * step;
  const endMs = Date.parse(`${range.to}:00Z`);
  const out: string[] = [];
  for (let ms = startMs; ms <= endMs && out.length < 5000; ms += step) {
    out.push(new Date(ms).toISOString().slice(0, 16));
  }
  return out;
}

/** ingest_minutes 的 WHERE：范围 + 模块/接口/host 维度 */
function minuteWhere(opts: {
  moduleId?: string;
  api?: string;
  host?: string;
}, range: MonitorTimeRange): { sql: string; params: Record<string, unknown> } {
  const clauses = ['minute >= @from', 'minute <= @to'];
  const params: Record<string, unknown> = { from: range.from, to: range.to };
  if (opts.moduleId) {
    clauses.push('module_id = @moduleId');
    params.moduleId = opts.moduleId;
  }
  if (opts.api) {
    clauses.push('api = @api');
    params.api = opts.api;
  }
  if (opts.host) {
    clauses.push('host = @host');
    params.host = opts.host;
  }
  return { sql: clauses.join(' AND '), params };
}

/** ingest_logs 的 WHERE（明细表 ts 为完整 ISO，故用 [from:00Z, to:59.999Z] 闭区间） */
function detailWhere(opts: {
  moduleId?: string;
  api?: string;
  host?: string;
}, range: MonitorTimeRange): { sql: string; params: Record<string, unknown> } {
  const clauses = ['ts >= @from', 'ts <= @to'];
  const params: Record<string, unknown> = {
    from: `${range.from}:00Z`,
    to: `${range.to}:59.999Z`,
  };
  if (opts.moduleId) {
    clauses.push('module_id = @moduleId');
    params.moduleId = opts.moduleId;
  }
  if (opts.api) {
    clauses.push('api = @api');
    params.api = opts.api;
  }
  if (opts.host) {
    clauses.push('host = @host');
    params.host = opts.host;
  }
  return { sql: clauses.join(' AND '), params };
}

function toEntry(r: LogRow) {
  return {
    id: r.id,
    ts: r.ts,
    host: r.host,
    method: r.method,
    path: r.path,
    api: r.api,
    moduleId: r.module_id,
    status: r.status,
    bytes: r.bytes,
    requestTimeMs: Math.round(r.request_time_ms * 100) / 100,
    upstreamTimeMs: Math.round(r.upstream_time_ms * 100) / 100,
    remoteAddr: r.remote_addr,
  };
}

/** 明细（不聚合） */
export function queryAccessLogs(q: AccessLogQuery): {
  logs: ReturnType<typeof toEntry>[];
  total: number;
} {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);
  const { sql, params } = buildWhere(q);
  const rows = db
    .prepare(
      `SELECT * FROM ingest_logs ${sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as unknown as LogRow[];
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS c FROM ingest_logs ${sql}`)
    .get(...params) as { c: number };
  return { logs: rows.map(toEntry), total: totalRow.c };
}

export type AggregatedApi = {
  api: string;
  method: string;
  moduleId: string;
  /** 目标子域名：同一 API 在不同站点要分开统计（test.iwiki / iwiki / 主站） */
  host: string;
  count: number;
  errCount: number;
  avgTimeMs: number;
  lastTs: string;
  lastStatus: number;
};

/** 聚合：同 API（归一路径）合并一条，显示调用量 */
export function queryAggregatedLogs(q: AccessLogQuery): {
  groups: AggregatedApi[];
  total: number;
} {
  const { sql, params } = buildWhere(q);
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const rows = db
    .prepare(
      `SELECT api, method, module_id, host, COUNT(*) AS count,
              SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS errCount,
              AVG(request_time_ms) AS avgTimeMs,
              MAX(ts) AS lastTs
       FROM ingest_logs t1 ${sql}
       GROUP BY api, method, module_id, host
       ORDER BY count DESC
       LIMIT ?`
    )
    .all(...params, limit) as unknown as Array<{
    api: string;
    method: string;
    module_id: string;
    host: string;
    count: number;
    errCount: number;
    avgTimeMs: number;
    lastTs: string;
  }>;
  // 每组在当前筛选范围内的最新状态码：复用 WHERE 条件（api=? AND method=? AND host=? AND 筛选），
  // 避免筛选 5xx 时展示组外最新状态（如 101/200）造成“状态与错误数不符”的错觉
  const lastWhere = buildWhere(q, 't2');
  const lastStatusStmt = db.prepare(
    `SELECT status FROM ingest_logs t2 ${lastWhere.sql} ${
      lastWhere.sql ? 'AND' : 'WHERE'
    } t2.api = ? AND t2.method = ? AND t2.host = ? ORDER BY t2.ts DESC, t2.id DESC LIMIT 1`
  );
  const groupCount = db
    .prepare(
      `SELECT COUNT(*) AS c FROM (SELECT api, method, host FROM ingest_logs t1 ${sql} GROUP BY api, method, host)`
    )
    .get(...params) as { c: number };
  const lastParams = lastWhere.params as unknown[];
  return {
    groups: rows.map((r) => {
      let lastStatus = 0;
      try {
        lastStatus = (
          lastStatusStmt.get(...lastParams, r.api, r.method, r.host) as
            | { status: number }
            | undefined
        )?.status ?? 0;
      } catch {
        /* ignore */
      }
      return {
        api: r.api,
        method: r.method,
        moduleId: r.module_id,
        host: r.host,
        count: r.count,
        errCount: r.errCount,
        avgTimeMs: Math.round(r.avgTimeMs * 10) / 10,
        lastTs: r.lastTs,
        lastStatus,
      };
    }),
    total: groupCount.c,
  };
}

/** 区间内按流量排序的接口榜（供「按接口查看」选择器；时序取 ingest_minutes，保留 30 天） */
export function queryTopApis(opts: {
  moduleId?: string;
  host?: string;
  from?: string;
  to?: string;
  minutes?: number;
  limit?: number;
}): {
  apis: Array<{ api: string; count: number; errCount: number }>;
  total: number;
  range: MonitorTimeRange;
} {
  const range = resolveTimeRange(opts);
  const { sql, params } = minuteWhere(opts, range);
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 200), 1), 1000);
  const apis = db
    .prepare(
      `SELECT api, SUM(total) AS count, SUM(s5xx) AS errCount
       FROM ingest_minutes WHERE ${sql}
       GROUP BY api ORDER BY count DESC LIMIT @limit`
    )
    .all({ ...params, limit }) as Array<{ api: string; count: number; errCount: number }>;
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM (SELECT api FROM ingest_minutes WHERE ${sql} GROUP BY api)`)
      .get(params) as { c: number }
  ).c;
  return { apis, total, range };
}

/** 总览：分桶时序，按 api 分系列、按状态码分折线 */
export function queryOverviewSeries(opts: {
  moduleId?: string;
  api?: string;
  host?: string;
  from?: string;
  to?: string;
  minutes?: number;
  bucket?: number;
  /** 只回流量 Top-N 的接口系列（小图只需要这些），避免长跨度下全量系列撑爆响应 */
  top?: number;
}): {
  series: Array<{
    api: string;
    statusClass: string;
    points: Array<{ minute: string; count: number }>;
  }>;
  /** 全站合计（按状态码分线），服务端算好并对齐时间轴，前端无需再拉全量系列 */
  global: Array<{ statusClass: string; total: number; values: number[] }>;
  /** Top 接口摘要（含 5xx 数），供小图排序与标题展示 */
  topApis: Array<{ api: string; total: number; errTotal: number }>;
  range: MonitorTimeRange;
  /** 完整桶时间轴（覆盖整个请求区间），供前端等距铺 x 轴 */
  timeline: string[];
  /** 区间内出现过的接口总数 */
  apiTotal: number;
} {
  const range = resolveTimeRange(opts);
  const { sql, params } = minuteWhere(opts, range);
  const bucketSec = range.bucketMinutes * 60;
  const timeline = bucketStarts(range);
  const limit = Math.min(Math.max(Math.floor(opts.top ?? 8), 1), 50);

  // Top-N 接口（按总请求量），与序列查询放在同一条语句里用 CTE，避免把全量行捞进 JS
  const topRows = db
    .prepare(
      `SELECT api, SUM(total) AS total, SUM(s5xx) AS errTotal
       FROM ingest_minutes WHERE ${sql}
       GROUP BY api ORDER BY total DESC LIMIT @limit`
    )
    .all({ ...params, limit }) as Array<{ api: string; total: number; errTotal: number }>;
  const topApis = topRows.map((r) => ({ api: r.api, total: r.total, errTotal: r.errTotal }));

  const rows = topApis.length
    ? (db
        .prepare(
          `WITH top AS (
             SELECT api FROM ingest_minutes WHERE ${sql}
             GROUP BY api ORDER BY SUM(total) DESC LIMIT @limit
           )
           SELECT ${bucketExpr()} AS bucket, api, SUM(total) AS total,
                  SUM(s2xx) AS s2xx, SUM(s3xx) AS s3xx, SUM(s4xx) AS s4xx, SUM(s5xx) AS s5xx
           FROM ingest_minutes
           WHERE ${sql} AND api IN (SELECT api FROM top)
           GROUP BY bucket, api ORDER BY bucket`
        )
        .all({ ...params, limit, bucketSec }) as Array<{
        bucket: string;
        api: string;
        total: number;
        s2xx: number;
        s3xx: number;
        s4xx: number;
        s5xx: number;
      }>)
    : [];

  // global：所有接口按桶求和（不分 api 维度），直接对齐时间轴
  const globalRows = db
    .prepare(
      `SELECT ${bucketExpr()} AS bucket, SUM(total) AS total,
              SUM(s2xx) AS s2xx, SUM(s3xx) AS s3xx, SUM(s4xx) AS s4xx, SUM(s5xx) AS s5xx
       FROM ingest_minutes WHERE ${sql} GROUP BY bucket ORDER BY bucket`
    )
    .all({ ...params, bucketSec }) as Array<{
    bucket: string;
    total: number;
    s2xx: number;
    s3xx: number;
    s4xx: number;
    s5xx: number;
  }>;
  const pos = new Map(timeline.map((t, i) => [t, i]));
  const zero = () => new Array<number>(timeline.length).fill(0);
  const globalAcc: Record<string, number[]> = {
    '1xx': zero(),
    '2xx': zero(),
    '3xx': zero(),
    '4xx': zero(),
    '5xx': zero(),
  };
  for (const r of globalRows) {
    const i = pos.get(r.bucket);
    if (i === undefined) continue;
    globalAcc['2xx'][i] = r.s2xx;
    globalAcc['3xx'][i] = r.s3xx;
    globalAcc['4xx'][i] = r.s4xx;
    globalAcc['5xx'][i] = r.s5xx;
    // 1xx（WebSocket 101 升级等）在采集侧只计入 total、不落任何状态类。
    // 这里用 total 减差补出来，否则各条线之和会小于 KPI 的请求总数，看着像统计错了。
    globalAcc['1xx'][i] = Math.max(0, r.total - (r.s2xx + r.s3xx + r.s4xx + r.s5xx));
  }
  const global = Object.entries(globalAcc)
    .map(([statusClass, values]) => ({
      statusClass,
      total: values.reduce((a, b) => a + b, 0),
      values,
    }))
    .filter((l) => l.total > 0)
    .sort((a, b) => a.statusClass.localeCompare(b.statusClass));

  const apiTotal = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM (SELECT api FROM ingest_minutes WHERE ${sql} GROUP BY api)`)
      .get(params) as { c: number }
  ).c;

  // api × statusClass → series（稀疏点，前端按 timeline 索引对齐）
  const byKey = new Map<string, { api: string; statusClass: string; points: Map<string, number> }>();
  const add = (api: string, cls: string, bucket: string, cnt: number) => {
    if (!cnt) return;
    const key = `${api}|${cls}`;
    let s = byKey.get(key);
    if (!s) {
      s = { api, statusClass: cls, points: new Map() };
      byKey.set(key, s);
    }
    s.points.set(bucket, (s.points.get(bucket) || 0) + cnt);
  };
  for (const r of rows) {
    const other = Math.max(0, r.total - (r.s2xx + r.s3xx + r.s4xx + r.s5xx));
    for (const [cls, cnt] of [
      ['1xx', other],
      ['2xx', r.s2xx],
      ['3xx', r.s3xx],
      ['4xx', r.s4xx],
      ['5xx', r.s5xx],
    ] as const) {
      add(r.api, cls, r.bucket, cnt);
    }
  }
  return {
    series: [...byKey.values()].map((s) => ({
      api: s.api,
      statusClass: s.statusClass,
      points: [...s.points.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([minute, count]) => ({ minute, count })),
    })),
    global,
    topApis,
    range,
    timeline,
    apiTotal,
  };
}

/** 总览 KPI：窗口内请求数 / 服务器错误 / 平均耗时 / QPS */
export function queryOverviewKpi(opts: {
  moduleId?: string;
  host?: string;
  from?: string;
  to?: string;
  minutes?: number;
  bucket?: number;
}): {
  total: number;
  errors: number;
  avgTimeMs: number;
  qps: number;
  range: MonitorTimeRange;
  rpsPerMinute: Array<{ minute: string; total: number; err: number }>;
} {
  const range = resolveTimeRange(opts);
  const { sql, params } = minuteWhere(opts, range);
  // 注意：ingest_minutes.err 的定义就是「status >= 500 的条数」，与 s5xx 同值。
  // 历史实现写成 SUM(err + s5xx)，导致服务器错误被算成 2 倍，此处修正为 SUM(s5xx)。
  const sum = db
    .prepare(
      `SELECT COALESCE(SUM(total),0) AS total, COALESCE(SUM(s5xx),0) AS err,
              COALESCE(SUM(time_ms),0) AS timeMs
       FROM ingest_minutes WHERE ${sql}`
    )
    .get(params) as { total: number; err: number; timeMs: number };
  const perMinute = db
    .prepare(
      `SELECT ${bucketExpr()} AS bucket, SUM(total) AS total, SUM(s5xx) AS err
       FROM ingest_minutes WHERE ${sql} GROUP BY bucket ORDER BY bucket`
    )
    .all({ ...params, bucketSec: range.bucketMinutes * 60 }) as Array<{
    bucket: string;
    total: number;
    err: number;
  }>;
  return {
    total: sum.total,
    errors: sum.err,
    avgTimeMs: sum.total ? Math.round((sum.timeMs / sum.total) * 10) / 10 : 0,
    qps: sum.total ? Math.round((sum.total / (range.spanMinutes * 60)) * 100) / 100 : 0,
    range,
    rpsPerMinute: perMinute.map((r) => ({ minute: r.bucket, total: r.total, err: r.err })),
  };
}

/* ────────────────────────── 单接口详情 ────────────────────────── */

export type ApiDetailBucket = {
  minute: string;
  total: number;
  /** 1xx（主要是 WebSocket 101 升级）：采集侧只计 total 不落状态类，这里用差值得出，否则各状态之和会小于 total */
  s1xx: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  /** 该桶内平均耗时（ms），按请求数加权 */
  avgTimeMs: number;
};

/**
 * 单接口详情：分桶时序（供折线图）+ 汇总 + 状态码/方法/host 分布 + 近期错误。
 *
 * 时序取 ingest_minutes（保留 30 天）；分布类取 ingest_logs（明细保留 7 天）。
 * 两者保留期不同，故用 truncated 标记「明细已过期」——此时分布为空但时序仍在，
 * 前端需明示原因，否则用户会以为页面坏了。
 */
export function queryApiDetail(opts: {
  moduleId?: string;
  api: string;
  host?: string;
  from?: string;
  to?: string;
  minutes?: number;
  bucket?: number;
}): {
  api: string;
  range: MonitorTimeRange;
  /** 完整桶时间轴，与 buckets 一一对应（缺桶即为 0 流量） */
  timeline: string[];
  buckets: ApiDetailBucket[];
  summary: {
    total: number;
    s1xx: number;
    s2xx: number;
    s3xx: number;
    s4xx: number;
    s5xx: number;
    errors: number;
    errorRate: number;
    avgTimeMs: number;
    peakPerBucket: number;
    peakMinute: string;
    avgPerMinute: number;
  };
  statusCodes: Array<{ code: number; count: number }>;
  methods: Array<{ method: string; count: number }>;
  hosts: Array<{ host: string; count: number }>;
  topPaths: Array<{ path: string; count: number }>;
  recentErrors: Array<{
    ts: string;
    method: string;
    path: string;
    status: number;
    requestTimeMs: number;
  }>;
  truncated: boolean;
} {
  const range = resolveTimeRange(opts);
  const { sql, params } = minuteWhere(opts, range);
  const bind = { ...params, bucketSec: range.bucketMinutes * 60 };

  const rows = db
    .prepare(
      `SELECT ${bucketExpr()} AS bucket,
              SUM(total) AS total, SUM(s2xx) AS s2xx, SUM(s3xx) AS s3xx,
              SUM(s4xx) AS s4xx, SUM(s5xx) AS s5xx, SUM(time_ms) AS time_ms
       FROM ingest_minutes WHERE ${sql}
       GROUP BY bucket ORDER BY bucket`
    )
    .all(bind) as Array<{
    bucket: string;
    total: number;
    s2xx: number;
    s3xx: number;
    s4xx: number;
    s5xx: number;
    time_ms: number;
  }>;

  const rowsByBucket = new Map(rows.map((r) => [r.bucket, r]));
  // 按完整时间轴补 0：缺桶即「该时段无请求」，前端可直接等距绘制，无需再对齐
  const timeline = bucketStarts(range);
  const buckets: ApiDetailBucket[] = timeline.map((minute) => {
    const r = rowsByBucket.get(minute);
    const total = r?.total ?? 0;
    const s2xx = r?.s2xx ?? 0;
    const s3xx = r?.s3xx ?? 0;
    const s4xx = r?.s4xx ?? 0;
    const s5xx = r?.s5xx ?? 0;
    return {
      minute,
      total,
      s1xx: Math.max(0, total - (s2xx + s3xx + s4xx + s5xx)),
      s2xx,
      s3xx,
      s4xx,
      s5xx,
      avgTimeMs: total && r ? Math.round((r.time_ms / total) * 10) / 10 : 0,
    };
  });

  const agg = buckets.reduce(
    (a, b) => ({
      total: a.total + b.total,
      s1xx: a.s1xx + b.s1xx,
      s2xx: a.s2xx + b.s2xx,
      s3xx: a.s3xx + b.s3xx,
      s4xx: a.s4xx + b.s4xx,
      s5xx: a.s5xx + b.s5xx,
      timeMs: a.timeMs + b.avgTimeMs * b.total,
    }),
    { total: 0, s1xx: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, timeMs: 0 }
  );
  let peak = buckets[0];
  for (const b of buckets) if (b.total > (peak?.total ?? -1)) peak = b;

  // —— 分布（明细表）——
  const dw = detailWhere(opts, range);
  const statusCodes = db
    .prepare(
      `SELECT status AS code, COUNT(*) AS count FROM ingest_logs
       WHERE ${dw.sql} GROUP BY status ORDER BY count DESC LIMIT 12`
    )
    .all(dw.params) as Array<{ code: number; count: number }>;
  const methods = db
    .prepare(
      `SELECT method, COUNT(*) AS count FROM ingest_logs
       WHERE ${dw.sql} GROUP BY method ORDER BY count DESC LIMIT 8`
    )
    .all(dw.params) as Array<{ method: string; count: number }>;
  const hosts = db
    .prepare(
      `SELECT host, COUNT(*) AS count FROM ingest_logs
       WHERE ${dw.sql} GROUP BY host ORDER BY count DESC LIMIT 8`
    )
    .all(dw.params) as Array<{ host: string; count: number }>;
  // 同一 api（归一路径）下仍有不同的真实 path（如 /api/user/123/profile），列出最热的几个
  const topPaths = db
    .prepare(
      `SELECT path, COUNT(*) AS count FROM ingest_logs
       WHERE ${dw.sql} GROUP BY path ORDER BY count DESC LIMIT 8`
    )
    .all(dw.params) as Array<{ path: string; count: number }>;
  // 5xx 优先（否则真实故障会被海量 404 淹没），再按时间倒序
  const recentErrors = db
    .prepare(
      `SELECT ts, method, path, status, request_time_ms FROM ingest_logs
       WHERE ${dw.sql} AND status >= 400
       ORDER BY CASE WHEN status >= 500 THEN 0 ELSE 1 END, ts DESC LIMIT 8`
    )
    .all(dw.params) as Array<{
    ts: string;
    method: string;
    path: string;
    status: number;
    request_time_ms: number;
  }>;

  const detailCount = methods.reduce((a, m) => a + m.count, 0);

  return {
    api: opts.api,
    range,
    timeline,
    buckets,
    summary: {
      total: agg.total,
      s1xx: agg.s1xx,
      s2xx: agg.s2xx,
      s3xx: agg.s3xx,
      s4xx: agg.s4xx,
      s5xx: agg.s5xx,
      errors: agg.s5xx,
      errorRate: agg.total ? Math.round((agg.s5xx / agg.total) * 10000) / 100 : 0,
      avgTimeMs: agg.total ? Math.round((agg.timeMs / agg.total) * 10) / 10 : 0,
      peakPerBucket: peak?.total ?? 0,
      peakMinute: peak?.minute ?? '',
      avgPerMinute: range.spanMinutes ? Math.round((agg.total / range.spanMinutes) * 100) / 100 : 0,
    },
    statusCodes,
    methods,
    hosts,
    topPaths,
    recentErrors: recentErrors.map((r) => ({
      ts: r.ts,
      method: r.method,
      path: r.path,
      status: r.status,
      requestTimeMs: Math.round(r.request_time_ms * 10) / 10,
    })),
    // 明细层缺数据但时序有数据 → 说明明细已过保留期（7 天）
    truncated: agg.total > 0 && detailCount === 0,
  };
}

/** 筛选项辅助：模块下出现过的 API / 方法 / host */
export function listFacets(opts: { moduleId?: string; limit?: number }): {
  apis: string[];
  methods: string[];
  hosts: string[];
} {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // ⚠ 明细表已达 4200 万行，且没有 (module_id, api) / host / method 索引：
  //   直接对它 DISTINCT 会整表扫描，监控页首屏能卡几十秒到几分钟（2026-10-24 事故）。
  //   api / host 改查分钟聚合表（保留 30 天，约 180 万行）并限定最近 24h；
  //   method 取值极少，取最近 5000 条明细去重即可枚举出在用的方法。
  const sinceMinute = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 16);
  const moduleClause = opts.moduleId ? ' AND module_id = ?' : '';
  const params = opts.moduleId ? [opts.moduleId] : [];
  // 按流量排序，并过滤掉扫描器的一次性探针（/.env、%00xxx 之类）：
  // 它们按字母序会把真实 API 挤出前 50，按流量排又能自然沉淀到低流量区。
  const apis = db
    .prepare(
      `SELECT api FROM ingest_minutes
       WHERE minute >= ?${moduleClause}
       GROUP BY api
       HAVING SUM(total) >= 3
       ORDER BY SUM(total) DESC
       LIMIT ?`
    )
    .all(sinceMinute, ...params, limit) as Array<{ api: string }>;
  const w = opts.moduleId ? 'WHERE module_id = ?' : '';
  const methods = db
    .prepare(
      `SELECT DISTINCT method FROM (
         SELECT method FROM ingest_logs ${w} ORDER BY ts DESC LIMIT 5000
       ) ORDER BY method LIMIT 10`
    )
    .all(...params) as Array<{ method: string }>;
  const hosts = db
    .prepare(
      `SELECT DISTINCT host FROM ingest_minutes
       WHERE minute >= ?${moduleClause}
       ORDER BY host LIMIT 50`
    )
    .all(sinceMinute, ...params) as Array<{ host: string }>;
  // 过滤畸形 Host 头（二进制/引号等），保留下拉框里能看懂的域名/IP
  const validHost = (h: string) => /^[A-Za-z0-9._:-]+$/.test(h);
  return {
    apis: apis.map((r) => r.api).filter(Boolean),
    methods: methods.map((r) => r.method).filter(Boolean),
    hosts: hosts.map((r) => r.host).filter(validHost),
  };
}

/** 机器运行状态（当前值 + 近期时序） */
export function machineStatus(opts?: { minutes?: number }): {
  current: {
    cpuPercent: number;
    memUsedMb: number;
    memTotalMb: number;
    load1: number;
    load5: number;
    load15: number;
    diskUsedGb: number;
    diskTotalGb: number;
    uptimeSec: number;
    hostname: string;
    platform: string;
  };
  history: Array<{
    ts: string;
    cpuPercent: number;
    memUsedMb: number;
    load1: number;
  }>;
} {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load = os.loadavg();
  let diskUsed = 0;
  let diskTotal = 0;
  try {
    const out = execFileSync('df', ['-k', '/'], { encoding: 'utf8' });
    const lines = out.trim().split('\n');
    const last = lines[lines.length - 1].split(/\s+/);
    diskTotal = Number(last[1]) / 1024 / 1024;
    diskUsed = Number(last[2]) / 1024 / 1024;
  } catch {
    /* ignore */
  }
  // 最新 cpu% 从 ingest_metrics 取（采集器已算好），取不到就用 load 近似
  const latest = db
    .prepare(`SELECT * FROM ingest_metrics ORDER BY ts DESC LIMIT 1`)
    .get() as
    | { ts: string; cpu_percent: number; mem_used_mb: number; mem_total_mb: number; load1: number }
    | undefined;
  const minutes = Math.min(Math.max(opts?.minutes ?? 30, 5), 360);
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const history = (
    db
      .prepare(
        `SELECT ts, cpu_percent, mem_used_mb, load1 FROM ingest_metrics
       WHERE ts >= ? ORDER BY ts`
      )
      .all(since) as unknown as Array<{
      ts: string;
      cpu_percent: number;
      mem_used_mb: number;
      load1: number;
    }>
  ).map((r) => ({
    ts: r.ts,
    cpuPercent: r.cpu_percent,
    memUsedMb: r.mem_used_mb,
    load1: r.load1,
  }));
  return {
    current: {
      cpuPercent: latest?.cpu_percent ?? 0,
      memUsedMb: latest?.mem_used_mb ?? (totalMem - freeMem) / 1024 / 1024,
      memTotalMb: latest?.mem_total_mb ?? totalMem / 1024 / 1024,
      load1: load[0],
      load5: load[1],
      load15: load[2],
      diskUsedGb: Math.round(diskUsed * 10) / 10,
      diskTotalGb: Math.round(diskTotal * 10) / 10,
      uptimeSec: Math.round(os.uptime()),
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()} · ${os.arch()}`,
    },
    history,
  };
}

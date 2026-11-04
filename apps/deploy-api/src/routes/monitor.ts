/**
 * 访问日志 / 监控路由（挂 /api/v1/monitor）。
 *
 * 权限模型：
 * - 平台管理员：可看任意模块与平台总览；
 * - 普通用户/开发者：可看自己可读（canReadModule）的模块日志，及对应模块的总览。
 */
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { isPlatformAdmin } from '../services/platform-admin.js';
import { canReadModule, getModule, listProjectsForUser, listModules } from '../services/project.js';
import { db } from '../db/init.js';
import {
  listFacets,
  machineStatus,
  queryAccessLogs,
  queryAggregatedLogs,
  queryApiDetail,
  queryOverviewKpi,
  queryOverviewSeries,
  queryTopApis,
  resolveTimeRange,
} from '../services/access-log-query.js';
import { collectorStatus } from '../services/access-log.js';

const router = Router();

function parseQuery(req: { query: Record<string, unknown> }) {
  const q = req.query;
  const num = (v: unknown, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    moduleId: typeof q.moduleId === 'string' && q.moduleId ? q.moduleId : undefined,
    api: typeof q.api === 'string' && q.api ? q.api : undefined,
    method: typeof q.method === 'string' && q.method ? q.method : undefined,
    statusClass: typeof q.statusClass === 'string' && q.statusClass ? q.statusClass : undefined,
    host: typeof q.host === 'string' && q.host ? q.host : undefined,
    q: typeof q.q === 'string' && q.q ? q.q : undefined,
    from: typeof q.from === 'string' && q.from ? q.from : undefined,
    to: typeof q.to === 'string' && q.to ? q.to : undefined,
    /** 聚合粒度（分钟）；不传则服务端按跨度自动选择（目标 ≤180 点） */
    bucket:
      Number.isFinite(Number(q.bucket)) && Number(q.bucket) > 0
        ? Math.floor(Number(q.bucket))
        : undefined,
    /** 预设窗口（分钟）；仅在没有 from/to 时生效 */
    minutes:
      Number.isFinite(Number(q.minutes)) && Number(q.minutes) > 0
        ? Math.floor(Number(q.minutes))
        : undefined,
    limit: num(q.limit, 100),
    offset: num(q.offset, 0),
  };
}

/** 可访问的模块 id 集合（普通用户） */
function accessibleModuleIds(userId: string): Set<string> {
  const ids = new Set<string>();
  const projects = listProjectsForUser(userId);
  for (const p of projects) {
    for (const m of listModules(p.id)) ids.add(m.id);
  }
  const memberRows = db
    .prepare('SELECT module_id FROM module_members WHERE user_id = ?')
    .all(userId) as Array<{ module_id: string }>;
  for (const r of memberRows) ids.add(r.module_id);
  return ids;
}

/** 我可见的模块清单（模块选择器数据源） */
router.get('/modules', authMiddleware, (req, res) => {
  const admin = isPlatformAdmin(req.user!.id);
  const rows = db
    .prepare(
      `SELECT id, name, project_id FROM modules ORDER BY name`
    )
    .all() as Array<{ id: string; name: string; project_id: string }>;
  const projNames = new Map(
    (
      db.prepare(`SELECT id, name FROM projects`).all() as Array<{
        id: string;
        name: string;
      }>
    ).map((p) => [p.id, p.name])
  );
  const modules = rows
    .filter((m) => admin || canReadModule(m.id, req.user!.id))
    .map((m) => ({ id: m.id, name: m.name, projectName: projNames.get(m.project_id) || '' }));
  res.json({ modules });
});

/** 明细日志（aggregate=0） */
router.get('/logs', authMiddleware, (req, res) => {
  const q = parseQuery(req);
  const admin = isPlatformAdmin(req.user!.id);
  if (!admin) {
    if (!q.moduleId) {
      res.status(400).json({ error: '请选择模块' });
      return;
    }
    if (!accessibleModuleIds(req.user!.id).has(q.moduleId)) {
      res.status(403).json({ error: '无权查看该模块日志' });
      return;
    }
  }
  const agg = ['1', 'true'].includes(String(req.query.aggregate ?? '').toLowerCase());
  const result = agg ? queryAggregatedLogs(q) : queryAccessLogs(q);
  res.json(result);
});

/** 聚合日志（aggregate=1 走 /logs；此路由等价保留，前端语义更清晰） */
router.get('/logs/aggregate', authMiddleware, (req, res) => {
  const q = parseQuery(req);
  const admin = isPlatformAdmin(req.user!.id);
  if (!admin) {
    if (!q.moduleId) {
      res.status(400).json({ error: '请选择模块' });
      return;
    }
    if (!accessibleModuleIds(req.user!.id).has(q.moduleId)) {
      res.status(403).json({ error: '无权查看该模块日志' });
      return;
    }
  }
  res.json(queryAggregatedLogs(q));
});

/** 筛选辅助（api/方法/host 下拉） */
router.get('/facets', authMiddleware, (req, res) => {
  const q = parseQuery(req);
  const admin = isPlatformAdmin(req.user!.id);
  if (!admin && (!q.moduleId || !accessibleModuleIds(req.user!.id).has(q.moduleId))) {
    res.json({ apis: [], methods: [], hosts: [] });
    return;
  }
  res.json(listFacets({ moduleId: q.moduleId }));
});

/**
 * 总览（登录即可看）：
 * - 平台管理员：可看全平台总览（不传 moduleId）；
 * - 普通开发者：仅可看自己可读模块的总览（必须传 moduleId 且有读权限）。
 *
 * 时间范围二选一：`minutes`（预设窗口）或 `from`/`to`（自定义，跨度上限 24h）。
 */
router.get('/overview', authMiddleware, (req, res) => {
  const admin = isPlatformAdmin(req.user!.id);
  const q = parseQuery(req);
  const moduleId = q.moduleId;
  if (!admin) {
    if (!moduleId) {
      res.status(403).json({ error: '请选择你的模块查看总览' });
      return;
    }
    if (!accessibleModuleIds(req.user!.id).has(moduleId)) {
      res.status(403).json({ error: '无权查看该模块总览' });
      return;
    }
  }
  try {
    // 先解析一次范围，series 与 kpi 共用同一区间与粒度，避免各自取 now() 出现错位
    const range = resolveTimeRange({
      from: q.from,
      to: q.to,
      minutes: q.minutes,
      bucket: q.bucket,
    });
    const win = { from: range.from, to: range.to, bucket: range.bucketMinutes };
    const series = queryOverviewSeries({ moduleId, api: q.api, host: q.host, ...win });
    const kpi = queryOverviewKpi({ moduleId, host: q.host, ...win });
    res.json({ kpi, ...series });
  } catch (e) {
    if (e instanceof RangeError) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }
});

/** 区间内按流量排序的接口榜（供「按接口查看」选择器，最多 1000 个） */
router.get('/apis', authMiddleware, (req, res) => {
  const admin = isPlatformAdmin(req.user!.id);
  const q = parseQuery(req);
  if (!admin) {
    if (!q.moduleId) {
      res.status(403).json({ error: '请选择你的模块查看接口列表' });
      return;
    }
    if (!accessibleModuleIds(req.user!.id).has(q.moduleId)) {
      res.status(403).json({ error: '无权查看该模块接口列表' });
      return;
    }
  }
  try {
    res.json(
      queryTopApis({
        moduleId: q.moduleId,
        host: q.host,
        from: q.from,
        to: q.to,
        minutes: q.minutes,
        limit: q.limit,
      })
    );
  } catch (e) {
    if (e instanceof RangeError) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }
});

/**
 * 单接口详情（点 Top API 小图 / 选择任意 API 后打开）：
 * 分桶时序 + 汇总 + 状态码/方法/host 分布 + 近期错误。
 */
router.get('/api-detail', authMiddleware, (req, res) => {
  const admin = isPlatformAdmin(req.user!.id);
  const q = parseQuery(req);
  const api = q.api?.trim();
  if (!api) {
    res.status(400).json({ error: '缺少 api 参数' });
    return;
  }
  if (!admin) {
    if (!q.moduleId) {
      res.status(403).json({ error: '请选择你的模块查看接口详情' });
      return;
    }
    if (!accessibleModuleIds(req.user!.id).has(q.moduleId)) {
      res.status(403).json({ error: '无权查看该模块接口详情' });
      return;
    }
  }
  try {
    res.json(
      queryApiDetail({
        moduleId: q.moduleId,
        api,
        host: q.host,
        from: q.from,
        to: q.to,
        minutes: q.minutes,
        bucket: q.bucket,
      })
    );
  } catch (e) {
    if (e instanceof RangeError) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }
});

/** 机器运行状态（登录即可看） */
router.get('/machine', authMiddleware, (_req, res) => {
  const minutes = Number(_req.query.minutes) || 30;
  res.json({ ...machineStatus({ minutes }), collector: collectorStatus() });
});

export default router;

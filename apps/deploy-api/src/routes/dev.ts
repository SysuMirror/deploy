/**
 * 开发者平台对接路由（挂 /api/v1/dev）。
 *
 * 身份模型：
 * - 「开发者」= 集市开发者平台（developer.ssemarket.cn）上 is_developer/is_admin 的用户，
 *   经 /api/open/developers/check（SM2 模块签名）实时校验（60s 缓存）。
 * - 非开发者访问受控接口返回 403 + code=NOT_DEVELOPER，前端引导跳转开发者平台申请。
 *
 * 接口：
 * - GET  /me              当前用户开发者身份（isDeveloper/isAdmin/platformUrl/joinUrl）
 * - GET  /oa/list         我的 OA 审批单（按用户本地映射表，oaid = sdpy-u{userId}-{n}）
 * - POST /oa/submit       提交 OA 审批单到开发者平台
 * - GET  /oa/:oaid        查询单据详情
 */

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { isPlatformAdmin } from '../services/platform-admin.js';
import {
  DEV_PLATFORM_BASE_URL,
  checkDeveloper,
  devPlatformConfigured,
  queryOa,
  submitOa,
} from '../services/devplatform.js';
import { db } from '../db/init.js';

const router = Router();

/** 本地 OA 单映射：SSE Deploy 用户 → 开发者平台 oaid（含提交人信息快照） */
function ensureOaTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_oa_items (
      oaid TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}
ensureOaTable();

const JOIN_URL = `${DEV_PLATFORM_BASE_URL}/join`;

/** 开发者身份查询结果（devIdentity 各分支的统一形状） */
type DevIdentity = import('../services/devplatform.js').DevIdentity;

/** 开发者身份（req.user 已挂载） */
async function devIdentity(userId: string, oauthId: string): Promise<DevIdentity> {
  const base = {
    configured: devPlatformConfigured(),
    platformUrl: DEV_PLATFORM_BASE_URL,
    joinUrl: JOIN_URL,
  };
  if (!base.configured) {
    return { ...base, checked: false, isDeveloper: false, isAdmin: false, reason: '平台通路未配置' };
  }
  try {
    const c = await checkDeveloper(oauthId);
    return {
      ...base,
      checked: true,
      isDeveloper: c.isDeveloper,
      isAdmin: c.isAdmin,
      name: c.displayName || c.name || '',
      // 平台管理员视为开发者（本模块 OA 页的管理动作只依赖 isPlatformAdmin，不依赖平台身份）
      effective: c.isDeveloper || isPlatformAdmin(userId),
    };
  } catch (e) {
    return {
      ...base,
      checked: false,
      isDeveloper: false,
      isAdmin: false,
      reason: e instanceof Error ? e.message : '查询失败',
    };
  }
}

/** 当前用户开发者身份 */
router.get('/me', authMiddleware, async (req, res) => {
  try {
    res.json(await devIdentity(req.user!.id, req.user!.oauthId));
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : '查询开发者身份失败' });
  }
});

/** 非开发者门禁（OA 相关接口统一走这里） */
async function requireDeveloper(req: import('express').Request, res: import('express').Response): Promise<boolean> {
  const id: DevIdentity = await devIdentity(req.user!.id, req.user!.oauthId);
  if (!id.configured || (id.checked && !id.effective)) {
    res.status(403).json({
      error: id.configured ? '仅开发者可使用 OA 审批，请前往开发者平台申请成为开发者' : id.reason,
      code: 'NOT_DEVELOPER',
      joinUrl: id.joinUrl,
      platformUrl: id.platformUrl,
    });
    return false;
  }
  if (!id.checked) {
    res.status(502).json({ error: id.reason || '开发者平台不可达', code: 'PLATFORM_UNREACHABLE' });
    return false;
  }
  return true;
}

/** 我的 OA 单（本地映射 + 平台实时状态；平台不可达时降级为本地标题） */
router.get('/oa/list', authMiddleware, async (req, res) => {
  if (!(await requireDeveloper(req, res))) return;
  const rows = db
    .prepare('SELECT oaid, title, created_at FROM dev_oa_items WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(req.user!.id) as Array<{ oaid: string; title: string; created_at: string }>;
  const items = await Promise.all(
    rows.map(async (r) => {
      try {
        const d = await queryOa(r.oaid);
        return { oaid: r.oaid, localTitle: r.title, createdAt: r.created_at, item: d, online: true as const };
      } catch {
        return { oaid: r.oaid, localTitle: r.title, createdAt: r.created_at, item: null, online: false as const };
      }
    })
  );
  res.json({ items, platformUrl: DEV_PLATFORM_BASE_URL });
});

/** 提交 OA 审批单 */
router.post('/oa/submit', authMiddleware, async (req, res) => {
  if (!(await requireDeveloper(req, res))) return;
  const { title, content, extra } = (req.body || {}) as {
    title?: string;
    content?: string;
    extra?: Record<string, unknown>;
  };
  const t = String(title || '').trim();
  if (!t) {
    res.status(400).json({ error: '标题必填' });
    return;
  }
  // oaid：模块内唯一业务键；同一用户自增序号
  const n =
    (db.prepare('SELECT COUNT(*) AS n FROM dev_oa_items WHERE user_id = ?').get(req.user!.id) as { n: number }).n + 1;
  const oaid = `sdpy-u${req.user!.id}-${n}`;
  try {
    const item = await submitOa({
      oaid,
      title: t.slice(0, 200),
      content: String(content || '').slice(0, 5000),
      extra: extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : undefined,
    });
    db.prepare('INSERT INTO dev_oa_items (oaid, user_id, title, created_at) VALUES (?, ?, ?, ?)').run(
      oaid,
      req.user!.id,
      t,
      new Date().toISOString()
    );
    res.json({ item });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '提交失败';
    // 平台 409（oaid 已存在）也落一条映射，保证可查询
    if (/409/.test(msg)) {
      db.prepare('INSERT OR IGNORE INTO dev_oa_items (oaid, user_id, title, created_at) VALUES (?, ?, ?, ?)').run(
        oaid,
        req.user!.id,
        t,
        new Date().toISOString()
      );
    }
    res.status(502).json({ error: msg });
  }
});

/** 查询单据 */
router.get('/oa/:oaid', authMiddleware, async (req, res) => {
  if (!(await requireDeveloper(req, res))) return;
  const oaid = String(req.params.oaid || '');
  const own = db.prepare('SELECT 1 FROM dev_oa_items WHERE oaid = ? AND user_id = ?').get(oaid, req.user!.id);
  if (!own && !isPlatformAdmin(req.user!.id)) {
    res.status(404).json({ error: '单据不存在' });
    return;
  }
  try {
    res.json({ item: await queryOa(oaid) });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : '查询失败' });
  }
});

export default router;

/**
 * 脚本应用路由（挂 /api/v1/scripts）——「非部署台应用」的网页下发执行。
 *
 * 应用 / 命令组：
 * - GET    /                   应用列表（含命令组与参数定义；登录即可看）
 * - POST   /                   新建应用（创建者自动成为 owner）
 * - GET    /:id                单个应用（含成员列表）
 * - PUT    /:id                更新应用（命令组与参数整组替换；仅创建者/平台管理员）
 * - DELETE /:id                删除应用（仅创建者/平台管理员）
 *
 * 成员（加入后才能执行）：
 * - POST   /:id/join           加入应用（自助）
 * - POST   /:id/leave          退出应用（创建者不能退）
 * - GET    /:id/members        成员列表
 * - DELETE /:id/members/:userId 移除成员（仅创建者/平台管理员）
 *
 * 执行：
 * - POST   /:id/preview        预览拼接后的完整命令（不执行）
 * - POST   /:id/run            执行（需为成员；返回 runId + 命令行）
 * - POST   /runs/:runId/stream 实时输出（SSE，POST 以便带 Authorization）
 * - POST   /runs/:runId/cancel 终止执行
 * - GET    /:id/runs           执行历史
 * - GET    /runs/:runId        单次执行详情（含完整输出）
 *
 * 权限取舍：查看对全体开发者开放（看得见有哪些应用、谁在执行），
 * 执行必须先是成员（避免任何人顺手跑别人的部署脚本），
 * 改 / 删 / 管成员只给创建者与平台管理员。
 */
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { isPlatformAdmin } from '../services/platform-admin.js';
import {
  createApp,
  deleteApp,
  getApp,
  getRun,
  isMember,
  joinApp,
  leaveApp,
  listApps,
  listMembers,
  listRuns,
  removeMember,
  ScriptError,
  updateApp,
  type AppInput,
} from '../services/script-apps.js';
import {
  cancelRun,
  currentOutput,
  isRunning,
  previewCommand,
  runningCount,
  startRun,
  subscribe,
} from '../services/script-runner.js';
import { writeAudit } from '../services/audit.js';

const router = Router();

/** ScriptError → 400（业务校验），其余交默认错误处理 */
function fail(res: import('express').Response, e: unknown) {
  if (e instanceof ScriptError) {
    res.status(400).json({ error: e.message, code: 'SCRIPT_INVALID' });
    return;
  }
  res.status(500).json({ error: e instanceof Error ? e.message : '服务器错误' });
}

function canManage(userId: string, ownerId: string): boolean {
  return userId === ownerId || isPlatformAdmin(userId);
}

/** 执行准入：成员 / 创建者 / 平台管理员 */
function canRun(appId: string, userId: string, ownerId: string): boolean {
  return isMember(appId, userId) || userId === ownerId || isPlatformAdmin(userId);
}

/* ------------------------------------------------------------------ *
 * 应用
 * ------------------------------------------------------------------ */

router.get('/', authMiddleware, (req, res) => {
  const apps = listApps({ includeDisabled: true, viewerId: req.user!.id });
  res.json({ apps, running: runningCount(), canCreate: true });
});
router.post('/', authMiddleware, async (req, res) => {
  try {
    const app = await createApp(req.body as AppInput, req.user!.id);
    writeAudit({
      action: 'script.app.create',
      actorId: req.user!.id,
      targetType: 'script_app',
      targetId: app.id,
      summary: `创建脚本应用「${app.name}」`,
      meta: { workdir: app.workdir, commands: app.commands.map((c) => c.name) },
    });
    res.json({ app });
  } catch (e) {
    fail(res, e);
  }
});

router.get('/:id', authMiddleware, (req, res) => {
  const app = getApp(req.params.id, req.user!.id);
  if (!app) {
    res.status(404).json({ error: '应用不存在' });
    return;
  }
  res.json({
    app: { ...app, members: listMembers(app.id, req.user!.id) },
    runs: listRuns(app.id, 30),
  });
});

router.put('/:id', authMiddleware, async (req, res) => {
  const existing = getApp(req.params.id);
  if (!existing) {
    res.status(404).json({ error: '应用不存在' });
    return;
  }
  if (!canManage(req.user!.id, existing.createdBy)) {
    res.status(403).json({ error: '只有创建者或平台管理员可以修改该应用' });
    return;
  }
  try {
    const app = await updateApp(req.params.id, req.body as AppInput, req.user!.id);
    writeAudit({
      action: 'script.app.update',
      actorId: req.user!.id,
      targetType: 'script_app',
      targetId: app.id,
      summary: `更新脚本应用「${app.name}」`,
      meta: { workdir: app.workdir, commands: app.commands.map((c) => c.name) },
    });
    res.json({ app });
  } catch (e) {
    fail(res, e);
  }
});

router.delete('/:id', authMiddleware, (req, res) => {
  const existing = getApp(req.params.id);
  if (!existing) {
    res.status(404).json({ error: '应用不存在' });
    return;
  }
  if (!canManage(req.user!.id, existing.createdBy)) {
    res.status(403).json({ error: '只有创建者或平台管理员可以删除该应用' });
    return;
  }
  try {
    deleteApp(req.params.id);
    writeAudit({
      action: 'script.app.delete',
      actorId: req.user!.id,
      targetType: 'script_app',
      targetId: existing.id,
      summary: `删除脚本应用「${existing.name}」`,
      meta: {},
    });
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

/* ------------------------------------------------------------------ *
 * 成员
 * ------------------------------------------------------------------ */

router.post('/:id/join', authMiddleware, (req, res) => {
  const app = getApp(req.params.id);
  if (!app) {
    res.status(404).json({ error: '应用不存在' });
    return;
  }
  try {
    joinApp(app.id, req.user!.id);
    writeAudit({
      action: 'script.app.join',
      actorId: req.user!.id,
      targetType: 'script_app',
      targetId: app.id,
      summary: `加入脚本应用「${app.name}」`,
      meta: {},
    });
    res.json({ app: getApp(app.id, req.user!.id), members: listMembers(app.id, req.user!.id) });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/:id/leave', authMiddleware, (req, res) => {
  const app = getApp(req.params.id);
  if (!app) {
    res.status(404).json({ error: '应用不存在' });
    return;
  }
  try {
    leaveApp(app.id, req.user!.id);
    writeAudit({
      action: 'script.app.leave',
      actorId: req.user!.id,
      targetType: 'script_app',
      targetId: app.id,
      summary: `退出脚本应用「${app.name}」`,
      meta: {},
    });
    res.json({ app: getApp(app.id, req.user!.id), members: listMembers(app.id, req.user!.id) });
  } catch (e) {
    fail(res, e);
  }
});

router.get('/:id/members', authMiddleware, (req, res) => {
  const app = getApp(req.params.id);
  if (!app) {
    res.status(404).json({ error: '应用不存在' });
    return;
  }
  res.json({ members: listMembers(app.id, req.user!.id) });
});

router.delete('/:id/members/:userId', authMiddleware, (req, res) => {
  const app = getApp(req.params.id);
  if (!app) {
    res.status(404).json({ error: '应用不存在' });
    return;
  }
  if (!canManage(req.user!.id, app.createdBy) && req.params.userId !== req.user!.id) {
    res.status(403).json({ error: '只有创建者或平台管理员可以移除成员' });
    return;
  }
  try {
    removeMember(app.id, req.params.userId);
    writeAudit({
      action: 'script.app.member.remove',
      actorId: req.user!.id,
      targetType: 'script_app',
      targetId: app.id,
      summary: `移除成员 ${req.params.userId}`,
      meta: {},
    });
    res.json({ members: listMembers(app.id, req.user!.id) });
  } catch (e) {
    fail(res, e);
  }
});

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */

/** 预览：让用户在执行前看到最终命令行，避免「跑完才发现参数拼错」 */
router.post('/:id/preview', authMiddleware, (req, res) => {
  const body = req.body as { commandId?: string; values?: Record<string, string> };
  try {
    if (!body.commandId) throw new ScriptError('缺少 commandId');
    const out = previewCommand(req.params.id, body.commandId, body.values ?? {});
    res.json(out);
  } catch (e) {
    fail(res, e);
  }
});

router.post('/:id/run', authMiddleware, (req, res) => {
  const body = req.body as { commandId?: string; values?: Record<string, string> };
  try {
    if (!body.commandId) throw new ScriptError('缺少 commandId');
    const app = getApp(req.params.id);
    if (!app) throw new ScriptError('应用不存在');
    if (!canRun(app.id, req.user!.id, app.createdBy)) {
      res.status(403).json({
        error: `请先加入应用「${app.name}」再执行其命令`,
        code: 'SCRIPT_NOT_MEMBER',
      });
      return;
    }
    const out = startRun({
      appId: req.params.id,
      commandId: body.commandId,
      values: body.values ?? {},
      operatorId: req.user!.id,
    });
    writeAudit({
      action: 'script.run.start',
      actorId: req.user!.id,
      targetType: 'script_run',
      targetId: out.runId,
      summary: `执行「${app.name} / ${out.commandName}」：${out.commandLine}`.slice(0, 400),
      meta: { appId: req.params.id, workdir: out.workdir },
    });
    res.json(out);
  } catch (e) {
    fail(res, e);
  }
});

router.get('/:id/runs', authMiddleware, (req, res) => {
  const app = getApp(req.params.id);
  if (!app) {
    res.status(404).json({ error: '应用不存在' });
    return;
  }
  res.json({ runs: listRuns(app.id, Number(req.query.limit) || 30) });
});

/**
 * SSE 实时输出。
 * 先补一段已产生的输出（后连上的也能看到开头），再订阅增量。
 * 与 modules.ts 的 generate-deploy-sh/stream 保持一致：POST + authMiddleware，
 * 前端用 fetch + ReadableStream 读（EventSource 不能带 Authorization 头也不支持 POST）。
 */
router.post('/runs/:runId/stream', authMiddleware, (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: '执行记录不存在' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({
    type: 'meta',
    runId: run.id,
    status: run.status,
    commandLine: run.commandLine,
    commandName: run.commandName,
    workdir: run.workdir,
  });

  // 已跑过的：先回放，避免中途接入看到空白
  const replay = currentOutput(run.id) ?? run.output;
  if (replay) send({ type: 'replay', text: replay });

  if (!isRunning(run.id)) {
    send({ type: 'end', status: run.status, exitCode: run.exitCode });
    res.end();
    return;
  }

  const unsub = subscribe(run.id, (ev) => send(ev));
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

  // 必须监听 res 而不是 req：
  // 对 POST 请求，Node 会在请求体读完时就让 req 触发 'close'（并不代表客户端断开），
  // 挂在 req 上会导致「刚推完 meta/replay 就自己把流关掉」，前端表现为一下就没后续输出。
  // res 的 'close' 才是「响应结束 / 连接断开」，此时再收摊。
  const cleanup = () => {
    clearInterval(heartbeat);
    unsub?.();
  };
  res.on('close', cleanup);
});

router.post('/runs/:runId/cancel', authMiddleware, async (req, res) => {
  try {
    const out = await cancelRun(req.params.runId);
    if (out.ok) {
      writeAudit({
        action: 'script.run.cancel',
        actorId: req.user!.id,
        targetType: 'script_run',
        targetId: req.params.runId,
        summary: '终止脚本执行',
        meta: {},
      });
    }
    res.json(out);
  } catch (e) {
    fail(res, e);
  }
});

router.get('/runs/:runId', authMiddleware, (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: '执行记录不存在' });
    return;
  }
  res.json({ run, live: isRunning(run.id) });
});

export default router;

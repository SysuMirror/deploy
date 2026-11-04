/**
 * 进程管理路由（挂 /api/v1/proc）。
 * - GET  /            进程列表（登录即可看；含守护状态）
 * - POST /:pid/kill   杀进程（仅平台管理员；body { force?: boolean }）
 * - POST /mail-test   发送测试邮件（仅平台管理员，验证 SMTP 通路）
 */
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { isPlatformAdmin } from '../services/platform-admin.js';
import {
  daemonState,
  killProcess,
  listProcesses,
} from '../services/process-manager.js';
import { adminRecipients, readSmtpConfig, sendMail } from '../services/mailer.js';

const router = Router();

/** 进程列表（登录即可看；含守护状态。kill 操作在下面单独限管理员） */
router.get('/', authMiddleware, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase() : '';
  const sort = ['cpu', 'mem', 'pid'].includes(String(req.query.sort)) ? String(req.query.sort) : 'cpu';
  let procs = listProcesses();
  if (q) procs = procs.filter((p) => p.command.toLowerCase().includes(q) || p.cmdline.toLowerCase().includes(q));
  // 排序后再截取（否则按内存/新进程排时，目标可能根本不在默认 CPU 前 80 里）
  if (sort === 'cpu') {
    procs.sort((a, b) => b.cpuPercent - a.cpuPercent || b.rssMb - a.rssMb);
  } else if (sort === 'mem') {
    procs.sort((a, b) => b.rssMb - a.rssMb || b.cpuPercent - a.cpuPercent);
  } else {
    procs.sort((a, b) => b.pid - a.pid); // PID 大 → 新启动
  }
  const isAdmin = isPlatformAdmin(req.user!.id);
  res.json({
    processes: procs, // 返回全部进程（前端表格内滚动 + 搜索过滤）
    total: procs.length,
    canManage: isAdmin,
    daemon: {
      ...daemonState,
      killThreshold: Number(process.env.MEM_KILL_THRESHOLD || 95),
      memWarnThreshold: Number(process.env.MEM_ALERT_THRESHOLD || 85),
    },
  });
});

/** 杀进程（平台管理员） */
router.post('/:pid/kill', authMiddleware, (req, res) => {
  if (!isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '需要平台管理员权限' });
    return;
  }
  const pid = Number(req.params.pid);
  const force = Boolean((req.body as { force?: boolean })?.force);
  const r = killProcess(pid, { force });
  if (!r.ok) {
    res.status(400).json(r);
    return;
  }
  res.json(r);
});

/** SMTP 测试邮件（平台管理员） */
router.post('/mail-test', authMiddleware, (req, res) => {
  if (!isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '需要平台管理员权限' });
    return;
  }
  const cfg = readSmtpConfig();
  if (!cfg) {
    res.status(400).json({ ok: false, error: 'SMTP 未配置' });
    return;
  }
  const recipients = adminRecipients();
  void sendMail({
    to: recipients.length ? recipients.map((r) => r.email) : [cfg.user],
    subject: '【SSE Deploy】SMTP 测试邮件',
    html: '<p>这是一封来自 SSE Deploy 的测试邮件，收到即说明 SMTP 通路正常。</p>',
  })
    .then((r) => res.json({ ok: r.ok, log: r.log, error: r.error, recipients: recipients.map((x) => x.email) }))
    .catch((e: unknown) => res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) }));
});

/** 邮件收件人预览（平台管理员） */
router.get('/mail-recipients', authMiddleware, (req, res) => {
  if (!isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '需要平台管理员权限' });
    return;
  }
  const cfg = readSmtpConfig();
  res.json({
    smtpConfigured: Boolean(cfg),
    smtpHost: cfg ? `${cfg.host}:${cfg.port}${cfg.secure ? ' (SSL)' : ''}` : '',
    recipients: adminRecipients(),
  });
});

export default router;

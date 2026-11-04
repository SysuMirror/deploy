import express, { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { createDeployment, getModule, getModuleWebhookSecret } from '../services/project.js';
import { enqueueDeployment } from '../services/deploy-worker.js';

const router = Router();

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? String(v[0]) : typeof v === 'string' ? v : undefined;
}

/**
 * 校验 webhook 签名，支持：
 * - GitHub：X-Hub-Signature-256: sha256=<hex>
 * - Gitee：X-Gitee-Token（纯令牌）或 X-Gitee-Signature（timestamp + 密钥 的 HMAC-SHA256）
 */
function verifySignature(secret: string, raw: Buffer, headers: Record<string, unknown>): boolean {
  const hub = header(headers, 'x-hub-signature-256');
  if (hub && hub.startsWith('sha256=')) {
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    return safeEqual(hub.slice(7), expected);
  }

  const giteeToken = header(headers, 'x-gitee-token');
  if (giteeToken) return safeEqual(giteeToken, secret);

  const giteeSig = header(headers, 'x-gitee-signature');
  if (giteeSig) {
    const m = giteeSig.match(/timestamp=(\d+)[^,]*,\s*signature=([0-9a-fA-F]+)/);
    if (m) {
      const expected = createHmac('sha256', secret).update(`${m[1]}\n${secret}`).digest('hex');
      return safeEqual(m[2], expected);
    }
  }

  return false;
}

// 注意：此路由需在全局 express.json() 之前挂载，raw body 才能保留（见 index.ts）
router.post(
  '/git/:moduleId',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const mod = getModule(req.params.moduleId);
    if (!mod) {
      res.status(404).json({ error: '模块不存在' });
      return;
    }

    const secret = getModuleWebhookSecret(mod.id);
    if (!secret) {
      res.status(403).json({ error: '模块未配置 webhook 密钥' });
      return;
    }

    const raw = req.body;
    if (!Buffer.isBuffer(raw)) {
      res.status(400).json({ error: '请求体不是 JSON（webhook 需以 application/json 发送）' });
      return;
    }

    if (!verifySignature(secret, raw, req.headers as Record<string, unknown>)) {
      res.status(401).json({ error: '签名校验失败' });
      return;
    }

    let payload: { ref?: string };
    try {
      payload = JSON.parse(raw.toString('utf8')) as { ref?: string };
    } catch {
      res.status(400).json({ error: 'JSON 解析失败' });
      return;
    }

    const branch = payload.ref?.startsWith('refs/heads/')
      ? payload.ref.slice('refs/heads/'.length)
      : undefined;
    if (!branch) {
      res.status(200).json({ ok: true, skipped: '非分支推送' });
      return;
    }

    // 仅默认分支触发自动部署，避免每个特性分支都拉起构建
    const targetBranch = mod.defaultBranch || 'main';
    if (branch !== targetBranch) {
      res.status(200).json({ ok: true, skipped: '非默认分支' });
      return;
    }

    try {
      const deployment = createDeployment(mod.id, mod.createdBy, {
        env: 'test',
        source: 'git',
        branch,
      });
      enqueueDeployment(deployment.id);
      res.status(201).json({ ok: true, deployment: { id: deployment.id, branch, env: 'test' } });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : '自动部署失败' });
    }
  }
);

export default router;

/**
 * 平台审计：谁在何时做了什么（申请/审批/建组/删组等）。
 * 不存密钥；payload 仅摘要字段。
 */
import { nanoid } from 'nanoid';
import { db } from '../db/init.js';
import { getUserById } from './user.js';

export type AuditAction =
  | 'application.create'
  | 'application.approve'
  | 'application.reject'
  | 'sseinfra.group.create'
  | 'sseinfra.group.delete'
  | 'deployment.create'
  | 'deployment.cancel';

export type AuditEntry = {
  id: string;
  action: string;
  actorId: string | null;
  actorName?: string;
  targetType: string;
  targetId: string;
  summary: string;
  meta: Record<string, unknown>;
  createdAt: string;
};

export function writeAudit(input: {
  action: AuditAction | string;
  actorId?: string | null;
  targetType: string;
  targetId: string;
  summary: string;
  meta?: Record<string, unknown>;
}): void {
  const id = `aud-${nanoid(12)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO audit_logs (id, action, actor_id, target_type, target_id, summary, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.action,
    input.actorId ?? null,
    input.targetType,
    input.targetId,
    input.summary.slice(0, 500),
    JSON.stringify(input.meta ?? {}),
    now
  );
}

export function listAuditLogs(opts?: {
  limit?: number;
  action?: string;
  actorId?: string;
}): AuditEntry[] {
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const params: unknown[] = [];
  if (opts?.action) {
    sql += ' AND action = ?';
    params.push(opts.action);
  }
  if (opts?.actorId) {
    sql += ' AND actor_id = ?';
    params.push(opts.actorId);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as {
    id: string;
    action: string;
    actor_id: string | null;
    target_type: string;
    target_id: string;
    summary: string;
    meta_json: string;
    created_at: string;
  }[];
  return rows.map((r) => {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(r.meta_json || '{}');
    } catch {
      meta = {};
    }
    const actor = r.actor_id ? getUserById(r.actor_id) : null;
    return {
      id: r.id,
      action: r.action,
      actorId: r.actor_id,
      actorName: actor?.name,
      targetType: r.target_type,
      targetId: r.target_id,
      summary: r.summary,
      meta,
      createdAt: r.created_at,
    };
  });
}

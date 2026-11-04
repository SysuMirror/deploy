import { db } from '../db/init.js';
import { getUserById } from './user.js';

export interface PlatformAdminInfo {
  oauthId: string;
  userId?: string;
  name?: string;
  email?: string;
  addedBy?: string;
  addedAt?: string;
}

function parseBootstrapOAuthIds(): string[] {
  // 未配置时默认把 OAuth 用户 561 作为初始平台管理员
  const raw = process.env.PLATFORM_ADMIN_OAUTH_IDS ?? process.env.SEED_OAUTH_ADMIN ?? '561';
  return raw
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function ensureBootstrapAdmins() {
  const ids = parseBootstrapOAuthIds();
  if (!ids.length) return;

  const now = new Date().toISOString();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO platform_admins (oauth_id, added_by, added_at) VALUES (?, ?, ?)'
  );
  let added = 0;
  for (const oauthId of ids) {
    added += insert.run(oauthId, null, now).changes;
  }
  if (added > 0) {
    console.log('Platform admins ensured:', ids.join(', '));
  }
}

export function isPlatformAdmin(userId: string): boolean {
  const user = getUserById(userId);
  if (!user?.oauthId) return false;
  return Boolean(
    db.prepare('SELECT 1 FROM platform_admins WHERE oauth_id = ?').get(user.oauthId)
  );
}

export function listPlatformAdmins(): PlatformAdminInfo[] {
  const rows = db
    .prepare(
      `SELECT pa.oauth_id, pa.added_by, pa.added_at, u.id as user_id, u.name, u.email
       FROM platform_admins pa
       LEFT JOIN users u ON u.oauth_id = pa.oauth_id
       ORDER BY pa.added_at ASC`
    )
    .all() as Array<{
    oauth_id: string;
    added_by: string | null;
    added_at: string | null;
    user_id: string | null;
    name: string | null;
    email: string | null;
  }>;
  return rows.map((r) => ({
    oauthId: r.oauth_id,
    userId: r.user_id ?? undefined,
    name: r.name ?? undefined,
    email: r.email ?? undefined,
    addedBy: r.added_by ?? undefined,
    addedAt: r.added_at ?? undefined,
  }));
}

export function addPlatformAdminByOAuthId(oauthId: string): PlatformAdminInfo {
  const id = String(oauthId ?? '').trim();
  if (!id) throw new Error('OAuth ID 不能为空');
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO platform_admins (oauth_id, added_by, added_at) VALUES (?, ?, ?)'
  ).run(id, null, now);
  return (
    listPlatformAdmins().find((a) => a.oauthId === id) ?? {
      oauthId: id,
      addedAt: now,
    }
  );
}

export function removePlatformAdmin(oauthId: string) {
  const id = String(oauthId ?? '').trim();
  if (!id) throw new Error('OAuth ID 不能为空');
  db.prepare('DELETE FROM platform_admins WHERE oauth_id = ?').run(id);
}

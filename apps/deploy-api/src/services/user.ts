import { db } from '../db/init.js';
import type { OAuthUserInfo } from './oauth-client.js';
import type { User } from '../types.js';

function rowToUser(row: {
  id: string;
  name: string;
  oauth_id: string | null;
  email: string;
  avatar_url: string;
}): User {
  return {
    id: row.id,
    name: row.name,
    oauthId: row.oauth_id ?? '',
    email: row.email,
    avatarUrl: row.avatar_url,
  };
}

export function listUsers(): User[] {
  const rows = db.prepare('SELECT * FROM users ORDER BY name ASC').all() as Array<{
    id: string;
    name: string;
    oauth_id: string | null;
    email: string;
    avatar_url: string;
  }>;
  return rows.map(rowToUser);
}

export function getUserById(id: string): User | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | {
        id: string;
        name: string;
        oauth_id: string | null;
        email: string;
        avatar_url: string;
      }
    | undefined;
  return row ? rowToUser(row) : null;
}

/** 按名字 / 邮箱 / id 模糊搜用户（项目 owner 添加成员用，只回最小字段） */
export function searchUsers(query: string, limit = 10): Array<{
  id: string;
  name: string;
  email: string;
  avatarUrl: string;
}> {
  const q = query.trim();
  if (!q) return [];
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const rows = db
    .prepare(
      `SELECT id, name, email, avatar_url as avatarUrl FROM users
       WHERE id = ? OR email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'
       ORDER BY name ASC LIMIT ?`
    )
    .all(q, like, like, Math.max(1, Math.min(limit, 50))) as Array<{
    id: string;
    name: string;
    email: string;
    avatarUrl: string;
  }>;
  return rows;
}

export function upsertOAuthUser(info: OAuthUserInfo): User {
  // 优先用 sse_sub（集市 userID）：既有的 user-oauth-<集市ID> 主键、
  // platform_admins 白名单与开发者平台判定全部按它关联，登录体验零迁移。
  const oauthId = info.sseSub || info.sub;
  const avatarUrl = info.avatar_url ?? '';
  const name = info.name || (info.sseSub ? `用户${info.sseSub}` : `用户${info.sub.slice(0, 8)}`);
  const email = info.email ?? '';

  const existing = db.prepare('SELECT id FROM users WHERE oauth_id = ?').get(oauthId) as
    | { id: string }
    | undefined;

  if (existing) {
    db.prepare('UPDATE users SET name = ?, email = ?, avatar_url = ? WHERE oauth_id = ?').run(
      name,
      email,
      avatarUrl,
      oauthId
    );
    return getUserById(existing.id)!;
  }

  const id = `user-oauth-${oauthId}`;
  db.prepare(
    'INSERT INTO users (id, name, oauth_id, email, avatar_url) VALUES (?, ?, ?, ?, ?)'
  ).run(id, name, oauthId, email, avatarUrl);
  return getUserById(id)!;
}

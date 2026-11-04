import { randomBytes } from 'crypto';
import { db } from '../db/init.js';
import { getUserById } from './user.js';
import type { User } from '../types.js';

/**
 * 服务端会话。此前登录直接把用户 id 当 token 用（Bearer user-oauth-xxx），
 * 任何人猜到/拿到 id 即可冒充该用户（含平台管理员），且「谁部署」会记错人。
 * 现在登录签发随机 token，服务端落库并可吊销。
 */
const DEFAULT_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);

function expiry(): string {
  return new Date(Date.now() + DEFAULT_TTL_DAYS * 86_400_000).toISOString();
}

export function createSession(userId: string, isDeveloper = false): { token: string; expiresAt: string } {
  if (!getUserById(userId)) throw new Error('用户不存在');
  const token = `sess-${randomBytes(32).toString('hex')}`;
  const expiresAt = expiry();
  db.prepare(
    'INSERT INTO sessions (token, user_id, is_developer, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(token, userId, isDeveloper ? 1 : 0, new Date().toISOString(), new Date().toISOString(), expiresAt);
  return { token, expiresAt };
}

/** 校验 token；命中则滑动续期。旧式 user-id token 一律不再接受。 */
export function resolveSessionUser(rawToken: string): User | null {
  const token = rawToken.trim();
  if (!token || token.startsWith('user-oauth-')) return null;
  const row = db
    .prepare(
      `SELECT s.user_id as userId, s.expires_at as expiresAt, s.is_developer as isDeveloper
       FROM sessions s WHERE s.token = ?`
    )
    .get(token) as { userId: string; expiresAt: string; isDeveloper: number } | undefined;
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const user = getUserById(row.userId);
  if (!user) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  // 滑动续期：每天最多写一次，避免每次请求都落盘
  const next = new Date(Date.now() + DEFAULT_TTL_DAYS * 86_400_000).toISOString();
  db.prepare(
    `UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token = ? AND last_seen_at < ?`
  ).run(new Date().toISOString(), next, token, new Date(Date.now() - 86_400_000).toISOString());
  return { ...user, isDeveloper: Boolean(row.isDeveloper) };
}

export function revokeSession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** 把某会话标记为开发者（联动真实开发者身份升级）。 */
export function markSessionDeveloper(token: string, isDeveloper: boolean): void {
  db.prepare('UPDATE sessions SET is_developer = ? WHERE token = ?').run(isDeveloper ? 1 : 0, token);
}

export function revokeUserSessions(userId: string): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

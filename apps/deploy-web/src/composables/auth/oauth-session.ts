import { setToken, clearToken, getToken } from '@/services/api';

const USER_KEY = 'deploy-session-user';

export type SessionUser = {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  oauthId?: string;
  isPlatformAdmin?: boolean;
  isDeveloper?: boolean;
};

export function persistAuth(token: string, user: SessionUser) {
  setToken(token);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function loadPersistedUser(): SessionUser | null {
  if (!getToken()) return null;
  const raw = sessionStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function clearPersistedAuth() {
  clearToken();
  sessionStorage.removeItem(USER_KEY);
}

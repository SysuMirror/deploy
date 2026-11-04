import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import { getToken, api, ApiError, NotDeveloperError } from '@/services/api';
import { persistAuth, clearPersistedAuth } from '@/composables/auth/oauth-session';

export type SsoCheck = 'ok' | 'invalid' | 'unavailable' | 'not-developer';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<import('@/composables/auth/oauth-session').SessionUser | null>(null);
  const loading = ref(false);

  const isLoggedIn = computed(() => Boolean(getToken() && user.value));

  async function login(email: string, password: string) {
    loading.value = true;
    try {
      const { token, user: u } = await api.passwordLogin(email, password);
      persistAuth(token, u);
      user.value = u;
      return u;
    } finally {
      loading.value = false;
    }
  }

  // 每次页面加载向 unisso 复核一次共享 SSO Cookie（无论本地有没有会话）：
  // 200 刷新会话；401（Cookie 已被其它平台单点登出）清本地会话；
  // 503/429/网络 保留本地会话，unisso 抖动不误踢已登录用户。
  let ssoChecked = false;
  let ssoInflight: Promise<SsoCheck> | null = null;

  async function revalidateSso(): Promise<SsoCheck> {
    if (ssoInflight) return ssoInflight;
    if (ssoChecked) return getToken() ? 'ok' : 'invalid';
    ssoInflight = (async () => {
      try {
        const { token, user: u } = await api.ssoTry();
        persistAuth(token, u);
        user.value = u;
        return 'ok' as const;
      } catch (e) {
        if (e instanceof NotDeveloperError) return 'not-developer' as const;
        const status = e instanceof ApiError ? e.status : 0;
        if (status === 401) {
          clearPersistedAuth();
          user.value = null;
          return 'invalid' as const;
        }
        return 'unavailable' as const;
      } finally {
        ssoChecked = true;
        ssoInflight = null;
      }
    })();
    return ssoInflight;
  }

  async function restoreSession(): Promise<boolean | 'not-developer'> {
    if (!getToken()) return false;
    // 始终以服务端校验结果为准：本地缓存的用户可能与 token 不一致
    // （共用浏览器时尤其如此，会导致部署记录记错操作人）
    try {
      const { user: u } = await api.getMe();
      user.value = u;
      persistAuth(getToken()!, u);
      return true;
    } catch (e) {
      // 非开发者：保留 token（登录态），引导到开发者门禁页，而不是当作未登录跳回登录页。
      if (e instanceof NotDeveloperError) {
        user.value = null;
        return 'not-developer';
      }
      clearPersistedAuth();
      user.value = null;
      return false;
    }
  }

  async function logout() {
    // 尽力撤销服务端会话（失败不阻塞本地登出）
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    clearPersistedAuth();
    user.value = null;
  }

  return { user, loading, isLoggedIn, login, revalidateSso, restoreSession, logout };
});

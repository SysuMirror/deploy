import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { NotDeveloperError } from '@/services/api';
import { consumeLoginRedirect } from './oauth-redirect';

export function useLoginFlow() {
  const auth = useAuthStore();
  const router = useRouter();
  const error = ref('');
  const loading = ref(false);
  const email = ref('');
  const password = ref('');

  async function submit() {
    loading.value = true;
    error.value = '';
    try {
      await auth.login(email.value.trim(), password.value);
      const redirect = consumeLoginRedirect() ?? '/projects';
      await router.replace(redirect);
    } catch (e) {
      if (e instanceof NotDeveloperError) {
        // 非开发者：签发 token 前已被后端拦截，引导到开发者门禁页
        await router.replace({ name: 'developer-gate' });
        return;
      }
      error.value = e instanceof Error ? e.message : '登录失败';
      loading.value = false;
    }
  }

  return { error, loading, email, password, submit };
}

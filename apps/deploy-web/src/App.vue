<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useDeployStore } from '@/stores/deploy';
import { isPublicPath } from '@/composables/auth/oauth-guard';
import { NotDeveloperError } from '@/services/api';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const deploy = useDeployStore();
const booting = ref(true);

const isPublic = computed(() => isPublicPath(route.path) || route.meta.public);
const isDeveloperGate = computed(() => route.name === 'developer-gate');

onMounted(async () => {
  if (isPublic.value || isDeveloperGate.value) {
    booting.value = false;
    return;
  }
  const ok = await auth.restoreSession();
  if (ok === 'not-developer') {
    // 非开发者：引导到门禁页（保留登录态），不要跳回登录页
    await router.replace({ name: 'developer-gate' });
    booting.value = false;
    return;
  }
  if (!ok) {
    await router.replace({ name: 'login', query: { redirect: route.fullPath } });
    booting.value = false;
    return;
  }
  // 登录成功 / 会话恢复：拉取平台数据。非开发者由后端中间件拦截，
  // request() 会全局重定向到开发者门禁页；此处静默兜底。
  try {
    await deploy.bootstrap();
  } catch (e) {
    if (e instanceof NotDeveloperError) {
      // request() 已跳转门禁，这里不再做跳转，避免重复
      booting.value = false;
      return;
    }
    booting.value = false;
    return;
  }
  booting.value = false;
});
</script>

<template>
  <RouterView v-if="isPublic || !booting" />
  <div v-else class="app-loading">
    <SlSpinner size="lg" />
    <p>加载中…</p>
  </div>
</template>

<style scoped>
.app-loading {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--deploy-fg-secondary);
  font-size: 14px;
}
</style>

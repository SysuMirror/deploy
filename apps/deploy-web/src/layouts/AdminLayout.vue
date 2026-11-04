<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import DeployHeader from '@/components/DeployHeader.vue';
import DeploySidebar from '@/components/DeploySidebar.vue';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();

onMounted(async () => {
  if (!auth.user) await auth.restoreSession().catch(() => false);
  if (!auth.user?.isPlatformAdmin) {
    router.replace('/projects');
  }
});
</script>

<template>
  <div class="admin-app">
    <DeploySidebar variant="admin" />
    <div class="admin-main">
      <DeployHeader workspace="管理台" />
      <main class="admin-content deploy-animate-in">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.admin-app {
  min-height: 100vh;
  display: flex;
  background: #0b1220;
}
.admin-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--deploy-bg);
  border-radius: 0;
}
.admin-content {
  flex: 1;
  padding: 28px 32px 48px;
  max-width: 1280px;
  width: 100%;
}
@media (max-width: 768px) {
  .admin-content {
    padding: 16px 14px 32px;
  }
}
</style>

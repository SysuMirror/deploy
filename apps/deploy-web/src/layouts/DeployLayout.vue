<script setup lang="ts">
import DeployHeader from '@/components/DeployHeader.vue';
import DeploySidebar from '@/components/DeploySidebar.vue';
</script>

<template>
  <div class="console-app">
    <DeploySidebar variant="console" />
    <div class="console-main">
      <DeployHeader workspace="控制台" />
      <main class="console-content deploy-animate-in">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.console-app {
  min-height: 100vh;
  display: flex;
  background: var(--deploy-bg);
}
.console-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.console-content {
  flex: 1;
  padding: 28px 36px 48px;
  width: 100%;
}
@media (max-width: 768px) {
  .console-content {
    padding: 16px 14px 32px;
  }
}
</style>

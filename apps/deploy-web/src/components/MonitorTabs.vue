<script setup lang="ts">
/**
 * 监控中心页内标签栏（访问日志 / 总览图表 / 进程管理）。
 * 三个监控视图共用，路由即标签；侧边栏只保留「监控中心」一个入口。
 */
const tabs = [
  { name: 'monitor-logs', label: '访问日志' },
  { name: 'monitor-overview', label: '总览图表' },
  { name: 'monitor-proc', label: '进程管理' },
];
</script>

<template>
  <nav class="monitor-tabs">
    <router-link
      v-for="t in tabs"
      :key="t.name"
      class="monitor-tab"
      :class="{ 'monitor-tab--active': $route.name === t.name }"
      :to="{ name: t.name }"
    >
      {{ t.label }}
    </router-link>
  </nav>
</template>

<style scoped>
.monitor-tabs {
  display: flex;
  gap: 6px;
}
.monitor-tab {
  display: inline-flex;
  align-items: center;
  padding: 7px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--deploy-fg-secondary);
  text-decoration: none;
  border: 1px solid transparent;
  transition: background 0.15s var(--deploy-ease, ease), color 0.15s var(--deploy-ease, ease);
}
.monitor-tab:hover {
  background: var(--deploy-muted);
  color: var(--deploy-fg);
}
.monitor-tab--active {
  background: var(--deploy-accent-soft);
  color: var(--deploy-primary);
}
</style>

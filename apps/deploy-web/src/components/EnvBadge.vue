<script setup lang="ts">
withDefaults(
  defineProps<{
    env: 'test' | 'prod';
    compact?: boolean;
  }>(),
  { compact: false }
);
</script>

<template>
  <span class="env-badge" :class="`env-badge--${env}`">
    <span class="env-badge__dot" aria-hidden="true" />
    <span v-if="env === 'test'">{{ compact ? '测试' : '测试环境' }}</span>
    <span v-else>{{ compact ? '正式' : '正式环境' }}</span>
  </span>
</template>

<style scoped>
.env-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
}
.env-badge__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.env-badge--test {
  color: #0e7490;
  background: var(--deploy-test-soft);
}
.env-badge--test .env-badge__dot { background: var(--deploy-test); }
.env-badge--prod {
  color: #0369a1;
  background: var(--deploy-prod-soft);
}
.env-badge--prod .env-badge__dot { background: var(--deploy-prod); }
</style>

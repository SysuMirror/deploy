<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, type Deployment } from '@/services/api';
import DeployPipeline from '@/components/DeployPipeline.vue';

const route = useRoute();
const router = useRouter();
const deployment = ref<Deployment | null>(null);
const loading = ref(true);
const error = ref('');
const logEl = ref<HTMLElement | null>(null);
const autoScroll = ref(true);
let pollTimer: ReturnType<typeof setInterval> | null = null;

const statusLabel: Record<string, string> = {
  pending: '待处理',
  unpacking: '准备包',
  cloning: '准备中',
  building: '构建中',
  deploying: '部署中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
};

const TERMINAL = ['success', 'failed', 'cancelled'];

const envLabel: Record<string, string> = {
  test: '测试',
  prod: '正式',
};

const actionLabel: Record<string, string> = {
  deploy: '部署',
  promote: '晋升正式',
  rollback: '回滚',
  migrate: '迁移',
};

const isRunning = computed(() => {
  const s = deployment.value?.status;
  return Boolean(s && !TERMINAL.includes(s));
});

const cancelling = ref(false);

async function load() {
  const id = route.params.deploymentId as string;
  const { deployment: d } = await api.getDeployment(id);
  deployment.value = d;
  if (autoScroll.value) {
    await nextTick();
    scrollToBottom();
  }
  if (TERMINAL.includes(d.status)) {
    stopPoll();
  }
}

async function cancel() {
  if (!deployment.value) return;
  cancelling.value = true;
  try {
    await api.cancelDeployment(deployment.value.id);
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '取消失败';
  } finally {
    cancelling.value = false;
  }
}

function scrollToBottom() {
  if (logEl.value) {
    logEl.value.scrollTop = logEl.value.scrollHeight;
  }
}

function scrollToLogs() {
  logEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => {
    void load().catch(() => stopPoll());
  }, 1500);
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

onMounted(async () => {
  loading.value = true;
  error.value = '';
  try {
    await load();
    if (isRunning.value) startPoll();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
});

onUnmounted(stopPoll);

watch(
  () => route.params.deploymentId,
  async () => {
    stopPoll();
    loading.value = true;
    try {
      await load();
      if (isRunning.value) startPoll();
    } finally {
      loading.value = false;
    }
  }
);

function goBack() {
  const moduleId = route.params.moduleId as string;
  router.push(`/modules/${moduleId}`);
}

function formatTime(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN');
}
</script>

<template>
  <div class="log-page">
    <button type="button" class="page-back" @click="goBack">← 返回模块</button>

    <div v-if="loading && !deployment" class="page-loading"><SlSpinner /></div>
    <SlAlert v-else-if="error" variant="error">{{ error }}</SlAlert>

    <template v-else-if="deployment">
      <header class="log-page__hero">
        <div>
          <p class="page-hero__eyebrow">部署</p>
          <h1 class="log-page__title">流水线</h1>
          <p class="log-page__meta">
            {{ envLabel[deployment.env] }} · {{ actionLabel[deployment.action] || deployment.action }}
            · {{ formatTime(deployment.createdAt) }}
            <template v-if="deployment.operatorName"> · {{ deployment.operatorName }}</template>
          </p>
        </div>
        <div class="log-page__badges">
          <span
            v-if="deployment.fixedByAgent"
            class="agent-badge"
            title="本次部署曾由 Agent 自动修复器介入"
          >
            Agent 已修复 · {{ deployment.fixAttempts ?? 1 }} 次
          </span>
          <span :class="['status-badge', `status-badge--${deployment.status}`]">
            {{ statusLabel[deployment.status] ?? deployment.status }}
            <template v-if="isRunning"> · 实时</template>
          </span>
          <SlButton
            v-if="isRunning"
            variant="danger"
            size="sm"
            :loading="cancelling"
            @click="cancel"
          >
            取消
          </SlButton>
        </div>
      </header>

      <div class="log-layout">
        <aside class="log-layout__side">
          <DeployPipeline :deployment="deployment" @view-logs="scrollToLogs" />
        </aside>
        <section class="log-layout__main">
          <div class="log-page__toolbar">
            <h2 class="log-page__section">编译日志</h2>
            <div class="log-page__toolbar-actions">
              <label class="log-page__autoscroll">
                <input v-model="autoScroll" type="checkbox" />
                自动滚动
              </label>
              <SlButton variant="secondary" size="sm" @click="load">刷新</SlButton>
            </div>
          </div>
          <pre ref="logEl" class="log-page__viewer">{{ deployment.logs || '等待日志…' }}</pre>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.log-page__hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.log-page__title {
  margin: 0 0 4px;
  font-size: 1.5rem;
  font-weight: 750;
  letter-spacing: -0.03em;
}
.log-page__meta {
  margin: 0;
  font-size: 13px;
  color: var(--deploy-fg-secondary);
}
.log-page__badges {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.agent-badge {
  font-size: 12px;
  padding: 3px 9px;
  border-radius: 999px;
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fcd34d;
  white-space: nowrap;
}
.log-layout {
  display: grid;
  grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.log-layout__side :deep(.pipeline) {
  margin-bottom: 0;
  max-height: calc(100vh - 220px);
  overflow: auto;
}
.log-layout__main {
  min-width: 0;
}
.log-page__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 0 8px;
  flex-wrap: wrap;
}
.log-page__section {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}
.log-page__toolbar-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.log-page__autoscroll {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
}
.log-page__viewer {
  margin: 0;
  font-family: var(--deploy-mono);
  font-size: 12px;
  line-height: 1.65;
  background: #0f172a;
  color: #e2e8f0;
  border-radius: 12px;
  padding: 14px 16px;
  min-height: 360px;
  max-height: calc(100vh - 240px);
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  box-shadow: var(--deploy-shadow);
}
@media (max-width: 960px) {
  .log-layout {
    grid-template-columns: 1fr;
  }
  .log-layout__side :deep(.pipeline) {
    max-height: 320px;
  }
  .log-page__viewer {
    max-height: 50vh;
  }
}
</style>

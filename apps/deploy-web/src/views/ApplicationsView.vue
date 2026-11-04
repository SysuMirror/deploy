<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type Application } from '@/services/api';

const loading = ref(true);
const error = ref('');
const applications = ref<Application[]>([]);

const typeLabel: Record<string, string> = {
  create_project: '创建项目',
  join_project: '加入项目',
  create_module: '创建模块',
  join_module: '加入模块',
  minio_bucket: '对象存储',
};

const statusLabel: Record<string, string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已拒绝',
};

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await api.listApplications(true);
    applications.value = res.applications;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="apps-page">
    <header class="page-hero">
      <div>
        <p class="page-hero__eyebrow">控制台</p>
        <h1 class="page-hero__title">我的申请</h1>
        <p class="page-hero__desc">查看你提交的项目 / 模块 / 对象存储申请状态。</p>
      </div>
      <SlButton variant="secondary" size="sm" :disabled="loading" @click="load">
        刷新
      </SlButton>
    </header>

    <SlAlert v-if="error" variant="error" class="mb-3">{{ error }}</SlAlert>

    <div v-if="loading" class="apps-empty">
      <SlSpinner />
    </div>
    <div v-else-if="!applications.length" class="apps-empty deploy-surface">
      <p>暂无申请记录</p>
      <p class="muted">在「项目」里创建或加入项目后，进度会出现在这里。</p>
    </div>
    <div v-else class="deploy-surface apps-table-wrap">
      <table class="deploy-table">
        <thead>
          <tr>
            <th>类型</th>
            <th>说明</th>
            <th>状态</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in applications" :key="a.id">
            <td>{{ typeLabel[a.type] || a.type }}</td>
            <td class="apps-summary">
              {{
                a.projectName ||
                a.moduleName ||
                String(a.payload?.name || a.payload?.reason || a.id)
              }}
            </td>
            <td>
              <span class="status-badge" :class="`status-badge--${a.status}`">
                {{ statusLabel[a.status] || a.status }}
              </span>
            </td>
            <td class="muted">{{ a.createdAt?.slice(0, 16)?.replace('T', ' ') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.page-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}
.page-hero__eyebrow {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--deploy-muted-fg);
}
.page-hero__title {
  margin: 0;
  font-size: 1.75rem;
  font-weight: 750;
  letter-spacing: -0.03em;
}
.page-hero__desc {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--deploy-fg-secondary);
  max-width: 36rem;
  line-height: 1.5;
}
.apps-empty {
  padding: 48px 24px;
  text-align: center;
  color: var(--deploy-fg-secondary);
}
.apps-table-wrap {
  overflow: auto;
}
.apps-summary {
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mb-3 {
  margin-bottom: 12px;
}
.muted {
  color: var(--deploy-muted-fg);
  font-size: 13px;
}
</style>

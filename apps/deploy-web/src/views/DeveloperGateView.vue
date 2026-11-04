<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { NotDeveloperError, api } from '@/services/api';

const router = useRouter();

const joinUrl = ref('https://developer.ssemarket.cn/join');
const platformUrl = ref('https://developer.ssemarket.cn');
const configured = ref(true);
const checking = ref(false);

// 门禁页本身可能因非开发者而来：后端中间件已拦截，bootstrap 拿不到 dev 信息，
// 因此优先从上一跳存的 sessionStorage 读取；否则尝试拉取（开发者通过后即可进入）。
onMounted(() => {
  try {
    const raw = sessionStorage.getItem('deploy-not-dev');
    if (raw) {
      const d = JSON.parse(raw) as { joinUrl?: string; platformUrl?: string };
      if (d.joinUrl) joinUrl.value = d.joinUrl;
      if (d.platformUrl) platformUrl.value = d.platformUrl;
    }
  } catch {
    /* ignore */
  }
});

async function checkDeveloperNow() {
  // 开发者平台已确认开发者身份后：后端中间件放行，bootstrap 成功即进入。
  try {
    const me = await api.getBootstrap();
    void me;
    await router.replace({ name: 'projects' });
  } catch (e) {
    if (e instanceof NotDeveloperError) {
      if (e.joinUrl) joinUrl.value = e.joinUrl;
      if (e.platformUrl) platformUrl.value = e.platformUrl;
    }
    // 仍非开发者，停留在门禁页
  }
}

async function reload() {
  checking.value = true;
  try {
    await checkDeveloperNow();
  } finally {
    checking.value = false;
  }
}
</script>

<template>
  <div class="gate-page">
    <div class="gate-card">
      <div class="gate__icon">
        <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
          <path d="M12 3l7 4v5c0 4.4-3 8.4-7 9-4-.6-7-4.6-7-9V7l7-4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
          <path d="M9.5 12l2 2 3.5-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <h1>仅开发者可使用部署台</h1>
      <p class="gate__desc">你的集市账号还没有开发者身份，需要先申请成为开发者才能使用部署台。</p>
      <div class="gate__steps">
        <span>1 · 打开开发者平台</span>
        <span>2 · 点击「加入开发者」填写申请</span>
        <span>3 · 等待管理员审核通过</span>
      </div>
      <a class="gate__cta" :href="joinUrl" target="_blank" rel="noreferrer">
        去申请成为开发者 ↗
      </a>
      <button class="gate__refresh" :disabled="checking" @click="reload">
        {{ checking ? '校验中…' : '我已申请完成，刷新身份' }}
      </button>
      <p v-if="!configured" class="gate__hint">（开发者平台通路未配置，请联系平台管理员）</p>
      <a class="gate__platform" :href="platformUrl" target="_blank" rel="noreferrer">开发者平台 ↗</a>
    </div>
  </div>
</template>

<style scoped>
.gate-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--deploy-bg);
}
.gate-card {
  max-width: 440px;
  width: 100%;
  background: #fff;
  border: 1px solid var(--deploy-border);
  border-radius: var(--deploy-radius-lg);
  box-shadow: var(--deploy-shadow);
  padding: 36px 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 14px;
}
.gate__icon {
  width: 60px;
  height: 60px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--deploy-accent-soft);
  color: var(--deploy-primary);
}
.gate-card h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 800;
  color: var(--deploy-fg);
}
.gate__desc {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--deploy-fg-secondary);
}
.gate__steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  margin-top: 4px;
}
.gate__steps span {
  font-size: 12.5px;
  color: var(--deploy-fg-secondary);
  background: var(--deploy-muted);
  border-radius: 8px;
  padding: 9px 12px;
  text-align: left;
}
.gate__cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-top: 8px;
  padding: 11px 16px;
  border-radius: 9px;
  background: var(--deploy-primary);
  color: #fff;
  font-weight: 700;
  font-size: 13.5px;
  text-decoration: none;
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.gate__cta:hover {
  opacity: 0.92;
  transform: translateY(-1px);
}
.gate__refresh {
  margin-top: 4px;
  padding: 8px 14px;
  border: 1px solid var(--deploy-border);
  background: #fff;
  color: var(--deploy-fg-secondary);
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s ease;
}
.gate__refresh:hover:not(:disabled) {
  border-color: var(--deploy-primary);
  color: var(--deploy-primary);
}
.gate__refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.gate__hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--deploy-muted-fg);
}
.gate__platform {
  font-size: 12.5px;
  color: var(--deploy-fg-secondary);
  text-decoration: none;
}
.gate__platform:hover {
  color: var(--deploy-primary);
}
</style>

<script setup lang="ts">
/**
 * 脚本部署 —— 应用列表。
 *
 * 这里只负责「找应用」：一张卡片一个应用，点卡片进详情页看命令组、执行、管成员。
 * 早期版本把命令组和执行按钮全铺在卡片上（一个应用 4 个命令组就是 4 个「执行 X」按钮），
 * 卡片又高又挤、手机上更难扫；改成列表 + 详情两层，和「项目」页保持一致的浏览习惯。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { scriptsApi, type ScriptApp } from '@/services/api';
import ScriptAppEditor from '@/components/ScriptAppEditor.vue';

const router = useRouter();

const loading = ref(true);
const error = ref('');
const notice = ref('');
const apps = ref<ScriptApp[]>([]);
const search = ref('');
const editorOpen = ref(false);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return apps.value;
  return apps.value.filter((a) =>
    [a.name, a.description, a.workdir].some((v) => v.toLowerCase().includes(q))
  );
});

const hasSearch = computed(() => search.value.trim().length > 0);

async function load(silent = false) {
  if (!silent) loading.value = true;
  error.value = '';
  try {
    const res = await scriptsApi.list();
    apps.value = res.apps;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

function openApp(app: ScriptApp) {
  router.push(`/scripts/${app.id}`);
}

/** 新建成功后直接进详情页，省得用户再点一次卡片 */
function onCreated(app: ScriptApp | undefined) {
  if (app) {
    router.push(`/scripts/${app.id}`);
    return;
  }
  notice.value = '应用已创建';
  void load(true);
}

/** 卡片右侧的状态标：停用 > 已加入 > 未加入 */
function stateTag(app: ScriptApp): { text: string; cls: string } {
  if (!app.enabled) return { text: '已停用', cls: 'sa-chip--muted' };
  if (app.joined) return { text: '已加入', cls: 'sa-chip--joined' };
  return { text: '未加入', cls: 'sa-chip--open' };
}
</script>

<template>
  <div class="scripts-page">
    <header class="page-hero">
      <div class="page-hero__main">
        <p class="page-hero__eyebrow">控制台</p>
        <h1 class="page-hero__title">脚本部署</h1>
        <p class="page-hero__desc">
          把宿主机上的部署 / 测试脚本注册成「非部署台应用」：一个应用下可建多个命令组，
          加入后即可在网页上填参数下发执行，输出实时回流、可高亮可复制。
        </p>
      </div>
      <div class="page-hero__actions">
        <SlButton variant="secondary" size="sm" :disabled="loading" @click="load()">刷新</SlButton>
        <SlButton size="sm" @click="editorOpen = true">新建应用</SlButton>
      </div>
    </header>

    <SlAlert v-if="error" variant="error" class="mb-3">{{ error }}</SlAlert>
    <SlAlert v-else-if="notice" variant="success" class="mb-3">{{ notice }}</SlAlert>

    <div v-if="loading" class="scripts-state">
      <SlSpinner />
    </div>

    <div v-else-if="!apps.length" class="scripts-state deploy-surface">
      <p class="scripts-state__title">还没有脚本应用</p>
      <p class="scripts-state__desc">
        点右上角「新建应用」，填上根目录，再建一个命令组即可。例如：<br />
        根目录 <code>/root/SSE_Market/iWiki</code>，命令组「部署到测试」，
        命令主体 <code>python3 iwiki.py deploy</code>，参数 <code>--target</code>。
      </p>
      <SlButton size="sm" @click="editorOpen = true">新建应用</SlButton>
    </div>

    <template v-else>
      <div class="list-head">
        <div class="list-head__title">
          <h2>全部应用</h2>
          <span class="count">{{ filtered.length }}</span>
          <span v-if="hasSearch" class="count count--sub">/ {{ apps.length }}</span>
        </div>
        <label class="search-field">
          <SlInput v-model="search" placeholder="搜索应用名 / 说明 / 目录…" autocomplete="off" />
        </label>
      </div>

      <div v-if="hasSearch && !filtered.length" class="list-empty">未找到匹配的应用</div>

      <div v-else class="app-grid">
        <button
          v-for="app in filtered"
          :key="app.id"
          type="button"
          class="app-card"
          @click="openApp(app)"
        >
          <div class="app-card__top">
            <h3 class="app-card__name">{{ app.name }}</h3>
            <span class="sa-chip" :class="stateTag(app).cls">{{ stateTag(app).text }}</span>
          </div>

          <p class="app-card__desc">{{ app.description || '暂无说明' }}</p>

          <p class="app-card__dir" :title="`命令在宿主机的 ${app.workdir} 目录下执行`">
            <span class="app-card__dir-label">宿主机</span>
            <code>{{ app.workdir }}</code>
          </p>

          <div class="app-card__meta">
            <span>{{ app.commands.length }} 命令组</span>
            <span class="dot">·</span>
            <span>{{ app.memberCount }} 成员</span>
            <span v-if="!app.commands.length" class="sa-chip sa-chip--warn">未配置命令</span>
          </div>

          <div class="app-card__foot">
            <span class="app-card__more">查看详情 →</span>
          </div>
        </button>
      </div>
    </template>

    <ScriptAppEditor v-model="editorOpen" @saved="onCreated" />
  </div>
</template>

<style scoped>
.mb-3 {
  margin-bottom: 12px;
}
.scripts-state {
  padding: 56px 24px;
  text-align: center;
  color: var(--deploy-fg-secondary);
  border-radius: var(--deploy-radius-lg);
}
.scripts-state__title {
  margin: 0 0 8px;
  font-weight: 650;
  color: var(--deploy-fg);
}
.scripts-state__desc {
  margin: 0 auto 18px;
  max-width: 36rem;
  font-size: 13px;
  line-height: 1.85;
}
.scripts-state code {
  font-family: var(--deploy-mono);
  font-size: 12px;
  background: var(--deploy-muted);
  padding: 1px 5px;
  border-radius: 5px;
}

/* —— 标题行 + 搜索 —— */
.list-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 20px;
  margin-bottom: 4px;
}
.list-head__title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.list-head__title h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.count {
  font-size: 12px;
  font-weight: 600;
  color: var(--deploy-muted-fg);
  background: var(--deploy-muted);
  border-radius: 999px;
  padding: 1px 8px;
}
.count--sub {
  background: transparent;
  padding: 0;
}
.search-field {
  min-width: 220px;
  flex: 1;
  max-width: 340px;
}
.list-empty {
  margin-top: 16px;
  font-size: 13px;
  color: var(--deploy-fg-secondary);
}

/* —— 应用卡片 —— */
/* 整张卡可点：比在卡里塞一堆按钮更接近「项目」页的浏览方式 */
.app-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  margin-top: 14px;
}
.app-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
  padding: 16px;
  border: 1px solid var(--deploy-border);
  border-radius: 12px;
  background: #fff;
  cursor: pointer;
  font-family: inherit;
  box-shadow: var(--deploy-shadow);
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
.app-card:hover {
  border-color: #93c5fd;
  box-shadow: var(--deploy-shadow-md);
  transform: translateY(-1px);
}
.app-card__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.app-card__name {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.02em;
  min-width: 0;
}
.app-card__desc {
  margin: 0;
  font-size: 13px;
  color: var(--deploy-fg-secondary);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.6em;
}
.app-card__dir {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  min-width: 0;
  font-size: 12px;
}
.app-card__dir-label {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--deploy-muted-fg);
}
.app-card__dir code {
  font-family: var(--deploy-mono);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--deploy-fg-secondary);
}
.app-card__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  font-size: 12px;
  color: var(--deploy-muted-fg);
}
.dot {
  color: var(--deploy-border-strong);
}
.app-card__foot {
  display: flex;
  justify-content: flex-end;
  margin-top: auto;
  padding-top: 9px;
  border-top: 1px solid var(--deploy-border);
}
.app-card__more {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--deploy-primary);
}
.app-card:hover .app-card__more {
  color: var(--deploy-primary-hover);
}

@media (max-width: 640px) {
  .app-grid {
    grid-template-columns: 1fr;
  }
  .page-hero {
    flex-direction: column;
    gap: 12px;
  }
  .page-hero__actions {
    width: 100%;
  }
  .page-hero__actions :deep(.sl-btn) {
    flex: 1 1 auto;
    min-height: 44px;
  }
  .search-field {
    max-width: none;
    min-width: 0;
  }
  /* 整卡可点，但「查看详情」提示在手机上要更明显 */
  .app-card__more {
    display: block;
    padding-top: 4px;
  }
}
</style>

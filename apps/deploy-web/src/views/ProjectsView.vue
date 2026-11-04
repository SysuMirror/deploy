<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useDeployStore } from '@/stores/deploy';
import { useAuthStore } from '@/stores/auth';
import { api, type ProjectListEntry } from '@/services/api';

const deploy = useDeployStore();
const auth = useAuthStore();
const router = useRouter();

const showModal = ref(false);
const creating = ref(false);
const formError = ref('');
const form = ref({ name: '', description: '', visibility: 'private' as 'public' | 'private' });
const submitMsg = ref('');

/** 上栏：我创建的项目 */
const myProjects = ref<ProjectListEntry[]>([]);
/** 下栏：全部项目（我创建的 + 我参与的 + 公开项目） */
const allProjects = ref<ProjectListEntry[]>([]);
const searchQuery = ref('');
const allLoading = ref(false);

const isAdmin = computed(() => Boolean(auth.user?.isPlatformAdmin));
const hasSearch = computed(() => searchQuery.value.trim().length > 0);
const myCreatedCount = computed(() => myProjects.value.length);

let searchTimer: ReturnType<typeof setTimeout> | undefined;

async function loadAll(q = '') {
  allLoading.value = true;
  try {
    const res = await api.listAllProjects(q);
    allProjects.value = res.projects;
  } catch {
    /* ignore */
  } finally {
    allLoading.value = false;
  }
}

watch(searchQuery, (q) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadAll(q), 250);
});

async function loadMine() {
  try {
    const res = await api.listMyCreatedProjects();
    myProjects.value = res.projects;
  } catch {
    myProjects.value = [];
  }
}

onMounted(async () => {
  await Promise.all([loadMine(), loadAll('')]);
});

function roleLabel(role?: string | null): string {
  if (role === 'owner') return '负责人';
  if (role === 'developer') return '开发者';
  if (role === 'viewer') return '访客';
  return '';
}

function visibilityLabel(p: ProjectListEntry): string {
  return p.visibility === 'public' ? '公开' : '私有';
}

function openProject(p: ProjectListEntry) {
  if (p.isMember) {
    router.push(`/projects/${p.id}`);
    return;
  }
  router.push({ path: `/projects/${p.id}`, query: { preview: '1' } });
}

async function openCreate() {
  form.value = { name: '', description: '', visibility: 'private' };
  formError.value = '';
  submitMsg.value = '';
  showModal.value = true;
}

async function submitCreate() {
  if (!form.value.name.trim()) {
    formError.value = '请输入项目名称';
    return;
  }
  creating.value = true;
  formError.value = '';
  submitMsg.value = '';
  try {
    const res = await api.createProject({
      ...form.value,
      direct: isAdmin.value,
    });
    showModal.value = false;
    if (res.project) {
      await deploy.bootstrap();
      await Promise.all([loadMine(), loadAll(searchQuery.value)]);
      router.push(`/projects/${res.project.id}`);
    } else {
      submitMsg.value = res.message || '已提交审批，请等待管理员通过';
    }
  } catch (e) {
    formError.value = e instanceof Error ? e.message : '提交失败';
  } finally {
    creating.value = false;
  }
}

async function applyJoin(id: string) {
  try {
    await api.joinProject(id);
    submitMsg.value = '已提交加入申请，可在「我的申请」查看进度';
  } catch (e) {
    formError.value = e instanceof Error ? e.message : '申请失败';
  }
}
</script>

<template>
  <div class="projects-page">
    <header class="page-hero">
      <div class="page-hero__main">
        <p class="page-hero__eyebrow">控制台</p>
        <h1 class="page-hero__title">项目</h1>
        <p class="page-hero__desc">
          管理你创建的项目，或从全部项目中查找、申请加入。
        </p>
      </div>
      <div class="page-hero__actions">
        <SlButton variant="primary" @click="openCreate">
          {{ isAdmin ? '新建项目' : '申请创建' }}
        </SlButton>
      </div>
    </header>

    <SlAlert v-if="submitMsg" variant="success" class="mb">{{ submitMsg }}</SlAlert>
    <SlAlert v-if="formError && !showModal" variant="error" class="mb">{{ formError }}</SlAlert>

    <!-- 上栏：我创建的项目（强调面板） -->
    <section class="mine-panel">
      <div class="mine-panel__head">
        <div class="mine-panel__heading">
          <h2 class="section-title">我创建的项目</h2>
          <span class="col__count">{{ myCreatedCount }}</span>
        </div>
        <p class="section-desc">你是这些项目的负责人：可管理成员、审批加入申请、配置成员模块权限。</p>
      </div>

      <div v-if="deploy.loading" class="page-loading"><SlSpinner /></div>
      <div v-else-if="!myProjects.length" class="empty-inline mine-panel__empty">
        <p>你还没有创建项目</p>
        <span>点击右上角「{{ isAdmin ? '新建项目' : '申请创建' }}」开始</span>
      </div>
      <div v-else class="card-grid card-grid--single">
        <button
          v-for="p in myProjects"
          :key="p.id"
          type="button"
          class="item-card item-card--mine"
          @click="router.push(`/projects/${p.id}`)"
        >
          <div class="item-card__top">
            <h3>{{ p.name }}</h3>
            <span class="tag" :class="p.visibility === 'public' ? 'tag--public' : 'tag--private'">
              {{ visibilityLabel(p) }}
            </span>
          </div>
          <p class="item-card__desc">{{ p.description || '暂无描述' }}</p>
          <div class="item-card__meta-row">
            <span>{{ p.moduleCount }} 模块</span>
            <span class="dot-sep">·</span>
            <span>{{ p.memberCount }} 成员</span>
            <span class="tag tag--owner">负责人</span>
          </div>
        </button>
      </div>
    </section>

    <!-- 下栏：全部项目 -->
    <section class="all-panel">
      <div class="all-panel__head">
        <div class="mine-panel__heading">
          <h2 class="section-title">全部项目</h2>
          <span class="col__count">{{ allProjects.length }}</span>
        </div>
        <label class="search-label">
          <SlInput
            v-model="searchQuery"
            placeholder="搜索项目名称 / 描述…"
            autocomplete="off"
          />
        </label>
      </div>
      <p class="section-desc">包含我创建的、我参与的以及公开项目；私有项目仅成员可见。</p>

      <div v-if="allLoading" class="search-status"><SlSpinner /></div>
      <div v-else-if="hasSearch && !allProjects.length" class="search-empty">
        未找到匹配的项目
      </div>
      <div v-else class="card-grid">
        <div v-for="p in allProjects" :key="p.id" class="item-card item-card--static">
          <div class="item-card__top">
            <h3>{{ p.name }}</h3>
            <span class="tag" :class="p.visibility === 'public' ? 'tag--public' : 'tag--private'">
              {{ visibilityLabel(p) }}
            </span>
          </div>
          <p class="item-card__desc">{{ p.description || '暂无描述' }}</p>
          <div class="item-card__meta-row">
            <span>{{ p.moduleCount }} 模块</span>
            <span class="dot-sep">·</span>
            <span>{{ p.ownerName || '—' }}</span>
            <span v-if="p.myRole" class="tag" :class="p.isOwner ? 'tag--owner' : 'tag--plain'">
              {{ roleLabel(p.myRole) }}
            </span>
          </div>
          <div class="item-card__go-row item-card__go-row--split">
            <SlButton variant="secondary" size="sm" @click="openProject(p)">
              {{ p.isMember ? '进入项目' : '预览' }}
            </SlButton>
            <SlButton
              v-if="!p.isMember && p.visibility === 'public'"
              variant="primary"
              size="sm"
              @click="applyJoin(p.id)"
            >
              申请加入
            </SlButton>
          </div>
        </div>
      </div>
    </section>

    <SlModal v-model="showModal" :title="isAdmin ? '新建项目' : '申请创建项目'">
      <div class="form-stack">
        <label>
          <span>项目名称</span>
          <SlInput v-model="form.name" placeholder="小组 A" />
        </label>
        <label>
          <span>描述（可选）</span>
          <SlTextarea v-model="form.description" placeholder="一句话说明" rows="3" />
        </label>
        <label>
          <span>可见性</span>
          <select v-model="form.visibility" class="select-input">
            <option value="private">私有 — 仅项目成员可见，成员由负责人邀请/审批</option>
            <option value="public">公开 — 所有人可在「全部项目」中搜到并申请加入</option>
          </select>
        </label>
        <p class="form-hint">
          {{ isAdmin ? '管理员可直接创建。' : '提交后由平台管理员审批。' }}
          可见性之后可在项目设置中修改。
        </p>
        <SlAlert v-if="formError" variant="error">{{ formError }}</SlAlert>
      </div>
      <template #footer>
        <SlButton variant="secondary" @click="showModal = false">取消</SlButton>
        <SlButton variant="primary" :disabled="creating" @click="submitCreate">
          {{ creating ? '提交中…' : isAdmin ? '创建' : '提交申请' }}
        </SlButton>
      </template>
    </SlModal>
  </div>
</template>

<style scoped>
.mb {
  margin-bottom: 12px;
}

/* ---------- 上栏：我创建的（强调面板） ---------- */
.mine-panel {
  position: relative;
  background: linear-gradient(180deg, #f4f9ff 0%, #eef5ff 100%);
  border: 1px solid #cfe3fb;
  border-left: 3px solid var(--deploy-accent);
  border-radius: var(--deploy-radius-xl);
  padding: 18px 20px 20px;
}
.mine-panel__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px 16px;
}
.mine-panel__heading {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mine-panel__empty {
  background: rgba(255, 255, 255, 0.7);
  border-color: #cfe3fb;
}
.item-card--mine {
  background: #fff;
  border-color: #dbeafe;
}
.item-card--mine:hover {
  border-color: #93c5fd;
  box-shadow: var(--deploy-shadow-md);
  transform: translateY(-1px);
}

/* ---------- 下栏：全部项目（中性面板） ---------- */
.all-panel {
  margin-top: 22px;
  background: var(--deploy-card);
  border: 1px solid var(--deploy-border);
  border-radius: var(--deploy-radius-xl);
  padding: 18px 20px 20px;
}
.all-panel__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px 20px;
}

.section-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.section-desc {
  width: 100%;
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--deploy-muted-fg);
}
.col__count {
  font-size: 12px;
  font-weight: 600;
  color: var(--deploy-muted-fg);
  background: var(--deploy-muted);
  border-radius: 999px;
  padding: 1px 8px;
}
.search-label {
  min-width: 240px;
  flex: 1;
  max-width: 380px;
}
.dot-sep {
  color: var(--deploy-border-strong);
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 12px;
  margin-top: 14px;
}
.item-card {
  text-align: left;
  padding: 16px 16px 14px;
  border: 1px solid var(--deploy-border);
  border-radius: 12px;
  background: #fff;
  cursor: pointer;
  font-family: inherit;
  box-shadow: var(--deploy-shadow);
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
.item-card--static {
  cursor: default;
}
.item-card:not(.item-card--static):hover {
  border-color: #93c5fd;
  box-shadow: var(--deploy-shadow-md);
  transform: translateY(-1px);
}
.item-card__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.item-card h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.item-card__desc {
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
.item-card__meta-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--deploy-muted-fg);
}
.item-card__go-row {
  margin-top: 12px;
}
.item-card__go-row--split {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tag {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--deploy-border);
  color: var(--deploy-muted-fg);
  white-space: nowrap;
}
.tag--public {
  color: #047857;
  border-color: #a7f3d0;
  background: #ecfdf5;
}
.tag--private {
  color: #6d28d9;
  border-color: #ddd6fe;
  background: #f5f3ff;
}
.tag--owner {
  color: #b45309;
  border-color: #fde68a;
  background: #fffbeb;
}
.tag--plain {
  color: #1d4ed8;
  border-color: #bfdbfe;
  background: #eff6ff;
}
.search-status,
.search-empty {
  margin-top: 14px;
  font-size: 13px;
  color: var(--deploy-fg-secondary);
}
.select-input {
  width: 100%;
  padding: 9px 10px;
  border: 1px solid var(--deploy-border);
  border-radius: 8px;
  font-family: inherit;
  font-size: 14px;
  background: #fff;
  color: inherit;
}
.form-hint {
  margin: 0;
  font-size: 12px;
  color: var(--deploy-muted-fg);
}
@media (max-width: 640px) {
  .card-grid {
    grid-template-columns: 1fr;
  }
  .mine-panel,
  .all-panel {
    padding: 14px 14px 16px;
  }
}
</style>

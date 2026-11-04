<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, type Module, type Project, type ProjectMember } from '@/services/api';
import { useDeployStore } from '@/stores/deploy';

const route = useRoute();
const router = useRouter();
const deploy = useDeployStore();
const project = ref<Project | null>(null);
const modules = ref<Module[]>([]);
const members = ref<ProjectMember[]>([]);
const baseDomain = ref('');
const loading = ref(true);
const showModal = ref(false);
const creating = ref(false);
const formError = ref('');
const form = ref({ name: '', pathMode: '' });
const base = computed(() => deploy.baseDomain || 'ssemarket.cn');

const showLinks = ref(false);
const linksModule = ref<Module | null>(null);

const canDelete = ref(false);
const canManageMembers = ref(false);
const showDelete = ref(false);
const deleting = ref(false);
const deleteError = ref('');

const showRename = ref(false);
const renaming = ref(false);
const renameError = ref('');
const renameForm = ref({ name: '', description: '', visibility: 'private' as 'public' | 'private' });
const showProjectMore = ref(false);
const readOnly = ref(false);
const canJoin = ref(false);
const joinMsg = ref('');
const joinError = ref('');

const isPreview = computed(() => route.query.preview === '1' || readOnly.value);

async function load() {
  loading.value = true;
  joinError.value = '';
  try {
    const previewMode = route.query.preview === '1';
    if (previewMode) {
      const data = await api.getProjectPreview(route.params.projectId as string);
      project.value = data.project;
      modules.value = data.modules.map((m) => ({
        id: m.id,
        projectId: data.project.id,
        name: m.name,
        repoUrl: '',
        buildCommand: '',
        appType: '',
        defaultBranch: '',
        priority: 'normal' as const,
        test: { url: m.testDeployed ? '1' : undefined },
        prod: { url: m.prodDeployed ? '1' : undefined },
        createdAt: '',
      }));
      readOnly.value = true;
      canJoin.value = data.canJoin;
      members.value = [];
      canDelete.value = false;
      canManageMembers.value = false;
      return;
    }
    const data = await api.getProject(route.params.projectId as string);
    project.value = data.project;
    modules.value = data.modules;
    members.value = data.members ?? [];
    baseDomain.value = data.baseDomain;
    if (data.publicBasePath) deploy.publicBasePath = data.publicBasePath;
    if (data.rootMode != null) deploy.rootMode = data.rootMode;
    canDelete.value = Boolean(data.canDelete);
    canManageMembers.value = Boolean(data.canManageMembers);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

const testDeployed = computed(
  () => modules.value.filter((m) => Boolean(m.test.url)).length
);
const prodDeployed = computed(
  () => modules.value.filter((m) => Boolean(m.prod.url)).length
);

function urlOf(m: Module, env: 'test' | 'prod', kind: 'web' | 'api') {
  return deploy.moduleUrl(m.name, env, kind, m.pathMode);
}

function openCreate() {
  form.value = { name: '', pathMode: '' };
  formError.value = '';
  showModal.value = true;
}

function openRename() {
  if (!project.value) return;
  renameForm.value = {
    name: project.value.name,
    description: project.value.description || '',
    visibility: project.value.visibility === 'public' ? 'public' : 'private',
  };
  renameError.value = '';
  showRename.value = true;
}

async function submitRename() {
  if (!project.value) return;
  if (!renameForm.value.name.trim()) {
    renameError.value = '请输入项目名称';
    return;
  }
  renaming.value = true;
  renameError.value = '';
  try {
    const res = await api.updateProject(project.value.id, {
      name: renameForm.value.name.trim(),
      description: renameForm.value.description,
      visibility: renameForm.value.visibility,
    });
    project.value = res.project;
    showRename.value = false;
  } catch (e) {
    renameError.value = e instanceof Error ? e.message : '保存失败';
  } finally {
    renaming.value = false;
  }
}

async function submitCreate() {
  if (!form.value.name.trim()) {
    formError.value = '请填写模块名';
    return;
  }
  creating.value = true;
  formError.value = '';
  try {
    const res = await api.createModule(route.params.projectId as string, {
      name: form.value.name.trim(),
      direct: canManageMembers.value,
      pathMode: form.value.pathMode,
    });
    showModal.value = false;
    if (res.module) {
      await load();
      router.push(`/modules/${res.module.id}`);
    } else {
      formError.value = '';
      alert(res.message || '已提交创建模块申请，等待负责人审批');
      await load();
    }
  } catch (e) {
    formError.value = e instanceof Error ? e.message : '提交失败';
  } finally {
    creating.value = false;
  }
}

function goBack() {
  router.push('/projects');
}

function openModule(id: string) {
  if (isPreview.value) return;
  router.push(`/modules/${id}`);
}

function openLinks(m: Module, e?: Event) {
  e?.stopPropagation();
  linksModule.value = m;
  showLinks.value = true;
}

function openUrl(url?: string) {
  if (url) window.open(url, '_blank');
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}

async function confirmDeleteProject() {
  if (!project.value) return;
  deleting.value = true;
  deleteError.value = '';
  try {
    await api.deleteProject(project.value.id);
    showDelete.value = false;
    await deploy.bootstrap();
    router.replace('/projects');
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : '删除失败';
  } finally {
    deleting.value = false;
  }
}

async function applyJoin() {
  if (!project.value) return;
  joinError.value = '';
  try {
    await api.joinProject(project.value.id);
    joinMsg.value = '已提交加入申请，可在「我的申请」查看进度';
  } catch (e) {
    joinError.value = e instanceof Error ? e.message : '申请失败';
  }
}
</script>

<template>
  <div v-if="loading" class="page-loading"><SlSpinner /></div>

  <div v-else-if="project">
    <button type="button" class="page-back" @click="goBack">← 返回项目列表</button>

    <SlAlert v-if="isPreview" variant="info" class="preview-banner">
      只读预览：你尚未加入该项目，无法上传包或创建模块。加入后可进行部署操作。
    </SlAlert>
    <SlAlert v-if="joinMsg" variant="success" class="preview-banner">{{ joinMsg }}</SlAlert>
    <SlAlert v-if="joinError" variant="error" class="preview-banner">{{ joinError }}</SlAlert>

    <header class="page-hero">
      <div class="page-hero__main">
        <p class="page-hero__eyebrow">项目</p>
        <h1 class="page-hero__title">
          {{ project.name }}
          <span
            class="vis-badge"
            :class="project.visibility === 'public' ? 'vis-badge--public' : 'vis-badge--private'"
          >
            {{ project.visibility === 'public' ? '公开' : '私有' }}
          </span>
        </h1>
        <p class="page-hero__desc">
          {{ project.description || `共 ${modules.length} 个模块` }}
          <template v-if="!isPreview">
            · 测试已部署 {{ testDeployed }} · 正式 {{ prodDeployed }}
          </template>
        </p>
      </div>
      <div class="page-hero__actions">
        <template v-if="isPreview && canJoin">
          <SlButton variant="primary" @click="applyJoin">申请加入项目</SlButton>
        </template>
        <template v-else-if="!isPreview">
          <SlButton variant="primary" @click="openCreate">
            {{ canManageMembers ? '创建模块' : '申请创建模块' }}
          </SlButton>
          <div v-if="canManageMembers || canDelete" class="more-wrap">
            <SlButton variant="secondary" @click="showProjectMore = !showProjectMore">
              更多 {{ showProjectMore ? '▴' : '▾' }}
            </SlButton>
            <div v-if="showProjectMore" class="more-menu deploy-surface" @click.stop>
              <button
                v-if="canManageMembers"
                type="button"
                class="more-menu__item"
                @click="openRename(); showProjectMore = false"
              >
                修改名称
              </button>
              <button
                v-if="canDelete"
                type="button"
                class="more-menu__item more-menu__item--danger"
                @click="showDelete = true; showProjectMore = false"
              >
                删除项目
              </button>
            </div>
          </div>
        </template>
      </div>
    </header>

    <div v-if="!isPreview && members.length" class="members-panel list-panel mb-members">
      <div class="list-panel__toolbar">
        <h2 class="list-panel__toolbar-title">成员 · {{ members.length }}</h2>
        <SlButton
          v-if="canManageMembers"
          size="sm"
          variant="secondary"
          @click="router.push(`/projects/${project.id}/members`)"
        >
          成员与权限管理 →
        </SlButton>
      </div>
      <p class="muted members-hint">
        角色与每个成员可操作的模块范围，在「成员与权限管理」页配置。
      </p>
      <ul class="member-list">
        <li v-for="m in members" :key="m.userId">
          <span>
            {{ m.name }}
            <small class="muted">
              {{ m.role === 'owner' ? '负责人' : m.role === 'developer' ? '开发者' : '访客' }}
              · {{ m.moduleScope === null || m.moduleScope === undefined ? '全部模块' : `${m.moduleScope.length} 个模块` }}
            </small>
          </span>
        </li>
      </ul>
    </div>

    <div v-if="!modules.length" class="empty-inline deploy-surface">
      <p>暂无模块</p>
      <span v-if="isPreview">加入项目后可创建模块并部署</span>
      <span v-else>创建后可上传包或配置 Git 部署</span>
      <div v-if="!isPreview" style="margin-top: 12px">
        <SlButton variant="primary" size="sm" @click="openCreate">新建模块</SlButton>
      </div>
    </div>

    <div v-else class="card-grid">
      <article
        v-for="m in modules"
        :key="m.id"
        class="item-card"
        :class="{ 'item-card--static': isPreview }"
        @click="openModule(m.id)"
      >
        <div class="item-card__top">
          <h3>{{ m.name }}</h3>
          <span
            :class="[
              'status-pill',
              m.prod.url || m.test.url ? 'status-pill--on' : 'status-pill--off',
            ]"
          >
            {{ m.prod.url ? '正式已上线' : m.test.url ? '测试已上线' : '未部署' }}
          </span>
        </div>
        <p class="item-card__desc">
          <template v-if="isPreview">仅展示模块名称与部署状态</template>
          <template v-else>
            {{ m.packageFileName || (m.repoUrl ? 'Git 仓库已配置' : '尚未上传包 / 配置 Git') }}
          </template>
        </p>
        <div class="item-card__status">
          <span>测试 {{ m.test.url ? '✓' : '—' }}</span>
          <span>正式 {{ m.prod.url ? '✓' : '—' }}</span>
          <button
            v-if="!isPreview"
            type="button"
            class="link-btn"
            @click="openLinks(m, $event)"
          >
            链接
          </button>
        </div>
      </article>
    </div>

    <SlModal v-model="showModal" :title="canManageMembers ? '创建模块' : '申请创建模块'">
      <div class="form-stack">
        <label>
          <span>模块名 <small>（小写，全局唯一）</small></span>
          <SlInput v-model="form.name" placeholder="my-app" />
        </label>
        <label>
          <span>访问方式 <small>（决定公网地址形式）</small></span>
          <select v-model="form.pathMode" class="path-select">
            <option value="">
              跟随平台默认（{{ deploy.rootMode ? '根路径' : deploy.publicBasePath }})
            </option>
            <option value="root">路径访问 · 根路径（{{ base }}/名称、{{ base }}/test/名称）</option>
            <option value="subpath">路径访问 · /sdpy 前缀（/sdpy/名称）</option>
            <option value="domain">仅子域名（名称.{{ base }}、test.名称.{{ base }}）</option>
          </select>
        </label>
        <p v-if="form.pathMode === 'domain'" class="form-hint">
          仅子域名模式不会生成 /名称 路径地址；平台会自动登记
          <code>{{ (form.name || '模块名') }}.{{ base }}</code> 与
          <code>test.{{ (form.name || '模块名') }}.{{ base }}</code>，
          多级测试域名会自动签发独立证书。
        </p>
        <p class="form-hint">
          {{
            canManageMembers
              ? '负责人可直接创建；也可在管理台审批他人申请。'
              : '提交后由项目负责人审批通过才会创建。'
          }}
        </p>
        <SlAlert v-if="formError" variant="error">{{ formError }}</SlAlert>
      </div>
      <template #footer>
        <SlButton variant="secondary" @click="showModal = false">取消</SlButton>
        <SlButton variant="primary" :disabled="creating" @click="submitCreate">
          {{ creating ? '提交中…' : canManageMembers ? '创建' : '提交申请' }}
        </SlButton>
      </template>
    </SlModal>

    <SlModal v-model="showRename" title="修改项目信息">
      <label class="form-field">
        <span>项目名称</span>
        <SlInput v-model="renameForm.name" placeholder="显示名称" />
      </label>
      <label class="form-field">
        <span>简介（可选）</span>
        <SlInput v-model="renameForm.description" placeholder="一句话说明" />
      </label>
      <label class="form-field">
        <span>可见性</span>
        <select v-model="renameForm.visibility" class="path-select">
          <option value="private">私有 — 仅项目成员可见，成员由负责人邀请/审批</option>
          <option value="public">公开 — 所有人可在「全部项目」中搜到并申请加入</option>
        </select>
      </label>
      <SlAlert v-if="renameError" variant="error">{{ renameError }}</SlAlert>
      <template #footer>
        <SlButton variant="secondary" @click="showRename = false">取消</SlButton>
        <SlButton variant="primary" :disabled="renaming" @click="submitRename">
          {{ renaming ? '保存中…' : '保存' }}
        </SlButton>
      </template>
    </SlModal>

    <SlModal v-model="showDelete" title="删除项目">
      <p class="danger-hint">
        仅项目创建人可删除。将删除项目下全部模块、停止所有测试/正式容器、清除上传包与部署记录，且不可恢复。
        确认删除「{{ project.name }}」？
      </p>
      <SlAlert v-if="deleteError" variant="error">{{ deleteError }}</SlAlert>
      <template #footer>
        <SlButton variant="secondary" @click="showDelete = false">取消</SlButton>
        <SlButton variant="primary" class="danger-btn" :disabled="deleting" @click="confirmDeleteProject">
          {{ deleting ? '删除中…' : '确认删除' }}
        </SlButton>
      </template>
    </SlModal>

    <SlModal
      v-model="showLinks"
      :title="linksModule ? `访问链接 · ${linksModule.name}` : '访问链接'"
    >
      <div v-if="linksModule" class="links-modal">
        <p class="links-modal__label">测试环境</p>
        <table class="deploy-table deploy-table--dashed">
          <tbody>
            <tr>
              <td class="col-type">前端</td>
              <td class="url-cell">{{ linksModule.test.url || urlOf(linksModule,'test', 'web') }}</td>
              <td class="col-act">
                <button
                  type="button"
                  class="link-btn"
                  @click="copyText(linksModule.test.url || urlOf(linksModule,'test', 'web'))"
                >
                  复制
                </button>
              </td>
            </tr>
            <tr>
              <td class="col-type">后端 API</td>
              <td class="url-cell">{{ linksModule.test.apiUrl || urlOf(linksModule,'test', 'api') }}</td>
              <td class="col-act">
                <button
                  type="button"
                  class="link-btn"
                  @click="copyText(linksModule.test.apiUrl || urlOf(linksModule,'test', 'api'))"
                >
                  复制
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <p class="links-modal__label">正式环境</p>
        <table class="deploy-table deploy-table--dashed">
          <tbody>
            <tr>
              <td class="col-type">前端</td>
              <td class="url-cell">{{ linksModule.prod.url || urlOf(linksModule,'prod', 'web') }}</td>
              <td class="col-act">
                <button
                  type="button"
                  class="link-btn"
                  @click="copyText(linksModule.prod.url || urlOf(linksModule,'prod', 'web'))"
                >
                  复制
                </button>
                <button
                  v-if="linksModule.prod.url"
                  type="button"
                  class="link-btn"
                  @click="openUrl(linksModule.prod.url)"
                >
                  打开
                </button>
              </td>
            </tr>
            <tr>
              <td class="col-type">后端 API</td>
              <td class="url-cell">{{ linksModule.prod.apiUrl || urlOf(linksModule,'prod', 'api') }}</td>
              <td class="col-act">
                <button
                  type="button"
                  class="link-btn"
                  @click="copyText(linksModule.prod.apiUrl || urlOf(linksModule,'prod', 'api'))"
                >
                  复制
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <template #footer>
        <SlButton variant="secondary" @click="showLinks = false">关闭</SlButton>
        <SlButton
          v-if="linksModule"
          variant="primary"
          @click="openModule(linksModule.id)"
        >
          进入模块
        </SlButton>
      </template>
    </SlModal>
  </div>
</template>

<style scoped>
.preview-banner {
  margin-bottom: 12px;
}
.vis-badge {
  display: inline-flex;
  align-items: center;
  vertical-align: 2px;
  margin-left: 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  padding: 2px 10px;
  border-radius: 999px;
}
.vis-badge--private {
  color: #6d28d9;
  border: 1px solid #ddd6fe;
  background: #f5f3ff;
}
.vis-badge--public {
  color: #047857;
  border: 1px solid #a7f3d0;
  background: #ecfdf5;
}
.form-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--deploy-fg-secondary);
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}
.item-card {
  padding: 16px 18px;
  border: 1px solid var(--deploy-border);
  border-radius: var(--deploy-radius-lg);
  background: #fff;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.item-card--static {
  cursor: default;
}
.item-card--static:hover {
  border-color: var(--deploy-border);
  background: #fff;
}
.item-card:not(.item-card--static):hover {
  border-color: #7dd3fc;
  background: #f0f9ff;
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
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--deploy-fg-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-card__status {
  display: flex;
  gap: 14px;
  align-items: center;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
  margin-top: 4px;
}
.item-card__status .link-btn {
  margin-left: auto;
}
.item-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.more-wrap {
  position: relative;
}
.more-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  min-width: 160px;
  padding: 6px;
  display: flex;
  flex-direction: column;
}
.more-menu__item {
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
  font-family: inherit;
  color: var(--deploy-fg);
  cursor: pointer;
}
.more-menu__item:hover {
  background: var(--deploy-muted);
}
.more-menu__item--danger {
  color: #b91c1c;
}

.links-modal__label {
  margin: 14px 0 6px;
  font-size: 12px;
  font-weight: 650;
  color: var(--deploy-fg-secondary);
}
.links-modal__label:first-child { margin-top: 0; }
.col-type {
  width: 72px;
  color: var(--deploy-fg-secondary);
  white-space: nowrap;
}
.col-act {
  width: 96px;
  text-align: right;
  white-space: nowrap;
}
.col-act .link-btn + .link-btn { margin-left: 8px; }
.danger-hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: #b91c1c;
  line-height: 1.55;
}
.danger-outline { color: #b91c1c !important; }
.danger-btn {
  --sl-primary-500: #dc2626;
  --sl-primary-600: #b91c1c;
}
.mb-members { margin-bottom: 16px; }
.member-add {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  flex-wrap: wrap;
}
.member-list {
  list-style: none;
  margin: 0;
  padding: 0 14px 12px;
}
.member-list li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid var(--deploy-border);
  font-size: 13px;
}
.muted { color: var(--deploy-muted-fg); font-size: 12px; }
.path-select {
  width: 100%;
  padding: 9px 11px;
  font-size: 13px;
  font-family: inherit;
  color: var(--deploy-fg);
  background: #fff;
  border: 1px solid var(--deploy-border);
  border-radius: var(--deploy-radius);
}
.path-select:focus-visible {
  outline: 2px solid var(--deploy-accent);
  outline-offset: 1px;
  border-color: var(--deploy-primary);
}

@media (max-width: 640px) {
  .page-hero { flex-direction: column; align-items: stretch; }
  .page-hero__actions { flex-wrap: wrap; }
  .stats-row { grid-template-columns: 1fr; }
  .stats-row__item { border-right: none; border-bottom: 1px solid var(--deploy-border); }
  .stats-row__item:last-child { border-bottom: none; }
  .card-grid { grid-template-columns: 1fr; }
}
</style>

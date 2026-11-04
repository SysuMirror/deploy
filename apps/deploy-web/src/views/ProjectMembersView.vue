<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, type Application, type Module, type ProjectMember } from '@/services/api';

const route = useRoute();
const router = useRouter();

const projectId = String(route.params.projectId);

const projectName = ref('');
const projectVisibility = ref<'public' | 'private'>('private');
const modules = ref<Module[]>([]);
const members = ref<ProjectMember[]>([]);
const loading = ref(true);
const canManage = ref(false);
const isOwner = ref(false);

const error = ref('');
const notice = ref('');

/** 添加成员 */
const showAdd = ref(false);
const userQuery = ref('');
const addRole = ref<'developer' | 'viewer'>('developer');
const addResults = ref<Array<{ id: string; name: string; email: string; avatarUrl?: string }>>([]);
const addPicking = ref<{ id: string; name: string; email: string } | null>(null);
const adding = ref(false);

/** 成员模块权限编辑 */
const scopeEditing = ref<string | null>(null);
const scopeDraft = ref<string[]>([]);

/** 待审申请 */
const applications = ref<Application[]>([]);
const reviewing = ref<string | null>(null);

/** 项目设置 */
const showSettings = ref(false);
const settingsForm = ref({ name: '', description: '', visibility: 'private' as 'public' | 'private' });
const savingSettings = ref(false);

const meId = ref('');

const pendingApps = computed(() => applications.value.filter((a) => a.status === 'pending'));

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await api.getProject(projectId);
    projectName.value = res.project.name;
    projectVisibility.value = (res.project.visibility as 'public' | 'private') ?? 'private';
    modules.value = res.modules ?? [];
    members.value = res.members ?? [];
    canManage.value = Boolean(res.canManageMembers);
    isOwner.value = Boolean(res.isOwner);
    settingsForm.value = {
      name: res.project.name,
      description: res.project.description ?? '',
      visibility: (res.project.visibility as 'public' | 'private') ?? 'private',
    };
    try {
      const me = await api.getMe();
      meId.value = me.user.id;
    } catch {
      /* ignore */
    }
    // 本项目相关的待审申请（负责人视角）
    try {
      const apps = await api.listApplications(false);
      applications.value = (apps.applications ?? []).filter(
        (a) => a.projectId === projectId && a.status === 'pending'
      );
    } catch {
      applications.value = [];
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function moduleById(id: string): Module | undefined {
  return modules.value.find((m) => m.id === id);
}

function scopeText(m: ProjectMember): string {
  if (m.role === 'owner') return '全部模块（负责人）';
  if (!m.moduleScope) return '全部模块';
  if (!m.moduleScope.length) return '未授权任何模块';
  const names = m.moduleScope
    .map((id) => moduleById(id)?.name ?? id)
    .filter(Boolean)
    .join('、');
  return names || `${m.moduleScope.length} 个模块`;
}

function startScopeEdit(m: ProjectMember) {
  scopeEditing.value = m.userId;
  scopeDraft.value = [...(m.moduleScope ?? [])];
}

function toggleScopeModule(id: string) {
  const i = scopeDraft.value.indexOf(id);
  if (i >= 0) scopeDraft.value.splice(i, 1);
  else scopeDraft.value.push(id);
}

async function saveScope(m: ProjectMember, value: string[] | null) {
  error.value = '';
  try {
    const res = await api.setProjectMemberModules(projectId, m.userId, value);
    members.value = res.members;
    notice.value = `已更新 ${m.name} 的模块权限`;
    scopeEditing.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败';
  }
}

async function changeRole(m: ProjectMember, role: 'developer' | 'viewer') {
  error.value = '';
  try {
    const res = await api.setProjectMemberRole(projectId, m.userId, role);
    members.value = res.members;
    notice.value = `已将 ${m.name} 设为${role === 'developer' ? '开发者' : '访客'}`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '更新失败';
  }
}

async function removeMember(m: ProjectMember) {
  if (!window.confirm(`确定移除成员「${m.name}」？`)) return;
  error.value = '';
  try {
    const res = await api.removeProjectMember(projectId, m.userId);
    members.value = res.members;
    notice.value = `已移除 ${m.name}`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '移除失败';
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;

watch(userQuery, (q) => {
  clearTimeout(searchTimer);
  if (!q.trim() || addPicking.value) {
    addResults.value = [];
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const res = await api.searchPlatformUsers(q);
      addResults.value = res.users.filter((u) => !members.value.some((m) => m.userId === u.id));
    } catch {
      addResults.value = [];
    }
  }, 250);
});

function pickUser(u: { id: string; name: string; email: string }) {
  addPicking.value = u;
  userQuery.value = u.name;
  addResults.value = [];
}

async function submitAdd() {
  const target = addPicking.value ?? { id: userQuery.value.trim(), name: userQuery.value.trim(), email: '' };
  if (!target.id) {
    error.value = '请输入并选择用户';
    return;
  }
  adding.value = true;
  error.value = '';
  try {
    const res = await api.addProjectMember(projectId, {
      userQuery: target.id,
      role: addRole.value,
    });
    members.value = res.members;
    notice.value = `已添加 ${target.name}`;
    showAdd.value = false;
    userQuery.value = '';
    addPicking.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '添加失败';
  } finally {
    adding.value = false;
  }
}

async function review(app: Application, decision: 'approved' | 'rejected') {
  reviewing.value = app.id;
  error.value = '';
  try {
    await api.reviewApplication(app.id, decision);
    notice.value = decision === 'approved' ? '已通过申请' : '已拒绝申请';
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败';
  } finally {
    reviewing.value = null;
  }
}

function appTypeLabel(t: string): string {
  const map: Record<string, string> = {
    join_project: '申请加入项目',
    create_module: '申请创建模块',
    join_module: '申请加入模块',
    create_project: '申请创建项目',
    minio_bucket: '申请 MinIO 桶',
  };
  return map[t] ?? t;
}

async function saveSettings() {
  savingSettings.value = true;
  error.value = '';
  try {
    await api.updateProject(projectId, {
      name: settingsForm.value.name,
      description: settingsForm.value.description,
      visibility: settingsForm.value.visibility,
    });
    projectVisibility.value = settingsForm.value.visibility;
    projectName.value = settingsForm.value.name;
    notice.value = '项目设置已保存';
    showSettings.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败';
  } finally {
    savingSettings.value = false;
  }
}

function goBack() {
  router.push(`/projects/${projectId}`);
}
</script>

<template>
  <div class="members-page">
    <header class="page-hero">
      <div class="page-hero__main">
        <p class="page-hero__eyebrow">
          <button type="button" class="link-btn" @click="goBack">{{ projectName || '项目' }}</button>
          / 权限管理
        </p>
        <h1 class="page-hero__title">成员与权限</h1>
        <p class="page-hero__desc">
          添加成员、审批加入申请，并为每个成员配置可操作的模块范围。
          <span class="vis-tag" :class="projectVisibility === 'public' ? 'vis-tag--public' : 'vis-tag--private'">
            {{ projectVisibility === 'public' ? '公开项目' : '私有项目' }}
          </span>
        </p>
      </div>
      <div class="page-hero__actions" v-if="canManage">
        <SlButton variant="secondary" @click="showSettings = true">项目设置</SlButton>
        <SlButton variant="primary" @click="showAdd = true">添加成员</SlButton>
      </div>
    </header>

    <div v-if="loading" class="page-loading"><SlSpinner /></div>

    <template v-else>
      <SlAlert v-if="notice" variant="success" class="mb">{{ notice }}</SlAlert>
      <SlAlert v-if="error" variant="error" class="mb">{{ error }}</SlAlert>

      <!-- 待审申请 -->
      <section v-if="canManage" class="deploy-surface block">
        <div class="block__head">
          <h2 class="section-title">待处理申请</h2>
          <span class="pill">{{ pendingApps.length }}</span>
        </div>
        <p class="section-desc">加入项目 / 创建模块的申请在此审批。</p>
        <div v-if="!pendingApps.length" class="empty-inline">
          <p>暂无待处理申请</p>
        </div>
        <div v-else class="app-list">
          <div v-for="a in pendingApps" :key="a.id" class="app-row">
            <div class="app-row__main">
              <strong>{{ a.applicantName || a.applicantId }}</strong>
              <span class="app-row__type">{{ appTypeLabel(a.type) }}</span>
              <span v-if="a.moduleName" class="app-row__meta">模块：{{ a.moduleName }}</span>
              <span class="app-row__time">{{ new Date(a.createdAt).toLocaleString() }}</span>
            </div>
            <div class="app-row__actions">
              <SlButton
                size="sm"
                variant="primary"
                :disabled="reviewing === a.id"
                @click="review(a, 'approved')"
              >
                通过
              </SlButton>
              <SlButton
                size="sm"
                variant="secondary"
                :disabled="reviewing === a.id"
                @click="review(a, 'rejected')"
              >
                拒绝
              </SlButton>
            </div>
          </div>
        </div>
      </section>

      <!-- 成员列表 -->
      <section class="deploy-surface block">
        <div class="block__head">
          <h2 class="section-title">项目成员</h2>
          <span class="pill">{{ members.length }}</span>
        </div>
        <div class="member-table">
          <div class="member-row member-row--head">
            <span>成员</span>
            <span>角色</span>
            <span>可操作模块</span>
            <span></span>
          </div>
          <div v-for="m in members" :key="m.userId" class="member-row">
            <div class="member-cell member-cell--user">
              <img v-if="m.avatarUrl" :src="m.avatarUrl" alt="" class="avatar" />
              <span v-else class="avatar avatar--fallback">{{ m.name.slice(0, 1) }}</span>
              <div>
                <strong>
                  {{ m.name }}
                  <span v-if="m.userId === meId" class="self-tag">我</span>
                </strong>
                <small>{{ m.email || m.userId }}</small>
              </div>
            </div>

            <div class="member-cell">
              <select
                v-if="canManage && m.role !== 'owner'"
                class="select-input select-input--sm"
                :value="m.role"
                @change="changeRole(m, ($event.target as HTMLSelectElement).value as 'developer' | 'viewer')"
              >
                <option value="developer">开发者（可部署被授权的模块）</option>
                <option value="viewer">访客（只读）</option>
              </select>
              <span v-else class="role-static">
                {{ m.role === 'owner' ? '负责人' : m.role === 'developer' ? '开发者' : '访客' }}
              </span>
            </div>

            <div class="member-cell member-cell--scope">
              <template v-if="scopeEditing === m.userId">
                <div class="scope-editor">
                  <label class="scope-option">
                    <input
                      type="radio"
                      :checked="scopeDraft.length === 0"
                      @change="scopeDraft = []"
                    />
                    全部模块
                  </label>
                  <label
                    v-for="mod in modules"
                    :key="mod.id"
                    class="scope-option"
                  >
                    <input type="checkbox" :checked="scopeDraft.includes(mod.id)" @change="toggleScopeModule(mod.id)" />
                    {{ mod.name }}
                  </label>
                  <div class="scope-actions">
                    <SlButton size="sm" variant="primary" @click="saveScope(m, scopeDraft.length ? [...scopeDraft] : null)">
                      保存
                    </SlButton>
                    <SlButton size="sm" variant="secondary" @click="scopeEditing = null">取消</SlButton>
                  </div>
                  <p class="scope-hint">勾选模块 = 仅这些模块可操作；选「全部模块」= 项目内所有模块。</p>
                </div>
              </template>
              <template v-else>
                <span class="scope-text">{{ scopeText(m) }}</span>
                <button
                  v-if="canManage && m.role !== 'owner' && modules.length"
                  type="button"
                  class="link-btn"
                  @click="startScopeEdit(m)"
                >
                  修改
                </button>
              </template>
            </div>

            <div class="member-cell member-cell--actions">
              <button
                v-if="canManage && m.role !== 'owner' && m.userId !== meId"
                type="button"
                class="link-btn link-btn--danger"
                @click="removeMember(m)"
              >
                移除
              </button>
            </div>
          </div>
        </div>
      </section>
    </template>

    <!-- 添加成员 -->
    <SlModal v-model="showAdd" title="添加成员">
      <div class="form-stack">
        <label>
          <span>搜索用户（姓名 / 邮箱 / ID）</span>
          <SlInput v-model="userQuery" placeholder="输入对方登录过本平台的姓名或邮箱" />
        </label>
        <div v-if="addResults.length" class="user-results">
          <button
            v-for="u in addResults"
            :key="u.id"
            type="button"
            class="user-result"
            @click="pickUser(u)"
          >
            <strong>{{ u.name }}</strong>
            <small>{{ u.email || u.id }}</small>
          </button>
        </div>
        <p v-else-if="userQuery.trim() && !addPicking" class="form-hint">
          没有匹配的用户，对方需先登录过本平台；也可直接粘贴其用户 ID。
        </p>
        <p v-if="addPicking" class="form-hint">已选择：{{ addPicking.name }}（{{ addPicking.email || addPicking.id }}）</p>
        <label>
          <span>角色</span>
          <select v-model="addRole" class="select-input">
            <option value="developer">开发者 — 可部署被授权的模块</option>
            <option value="viewer">访客 — 只读</option>
          </select>
        </label>
        <p class="form-hint">添加后可在成员列表里为该成员勾选可操作的模块。</p>
        <SlAlert v-if="error" variant="error">{{ error }}</SlAlert>
      </div>
      <template #footer>
        <SlButton variant="secondary" @click="showAdd = false">取消</SlButton>
        <SlButton variant="primary" :disabled="adding" @click="submitAdd">
          {{ adding ? '添加中…' : '添加' }}
        </SlButton>
      </template>
    </SlModal>

    <!-- 项目设置 -->
    <SlModal v-model="showSettings" title="项目设置">
      <div class="form-stack">
        <label>
          <span>项目名称</span>
          <SlInput v-model="settingsForm.name" />
        </label>
        <label>
          <span>描述</span>
          <SlTextarea v-model="settingsForm.description" rows="3" />
        </label>
        <label>
          <span>可见性</span>
          <select v-model="settingsForm.visibility" class="select-input">
            <option value="private">私有 — 仅项目成员可见</option>
            <option value="public">公开 — 所有人可搜索并申请加入</option>
          </select>
        </label>
        <p class="form-hint">
          「私有」：别人看不到项目，成员只能由你在本页添加。
          「公开」：所有人都能在首页「全部项目」里搜到、预览模块列表并提交加入申请（由你审批）。
        </p>
      </div>
      <template #footer>
        <SlButton variant="secondary" @click="showSettings = false">取消</SlButton>
        <SlButton variant="primary" :disabled="savingSettings" @click="saveSettings">
          {{ savingSettings ? '保存中…' : '保存' }}
        </SlButton>
      </template>
    </SlModal>
  </div>
</template>

<style scoped>
.mb {
  margin-bottom: 12px;
}
.link-btn {
  background: none;
  border: none;
  padding: 0;
  color: #1d4ed8;
  font: inherit;
  cursor: pointer;
}
.link-btn--danger {
  color: #b91c1c;
}
.vis-tag {
  display: inline-flex;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--deploy-border);
  vertical-align: middle;
}
.vis-tag--public {
  color: #047857;
  border-color: #a7f3d0;
  background: #ecfdf5;
}
.vis-tag--private {
  color: #6d28d9;
  border-color: #ddd6fe;
  background: #f5f3ff;
}
.block {
  padding: 16px 18px;
  border-radius: 12px;
  margin-bottom: 18px;
}
.block__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pill {
  font-size: 12px;
  color: var(--deploy-muted-fg);
  background: var(--deploy-bg, #f1f5f9);
  border: 1px solid var(--deploy-border);
  border-radius: 999px;
  padding: 1px 8px;
}
.section-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.section-desc {
  margin: 4px 0 14px;
  font-size: 13px;
  color: var(--deploy-muted-fg);
}
.empty-inline {
  padding: 14px;
  color: var(--deploy-muted-fg);
  font-size: 13px;
}
.app-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.app-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  border: 1px solid var(--deploy-border);
  border-radius: 10px;
  padding: 10px 12px;
}
.app-row__main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.app-row__type {
  color: #1d4ed8;
  font-weight: 600;
}
.app-row__meta,
.app-row__time {
  color: var(--deploy-muted-fg);
  font-size: 12px;
}
.app-row__actions {
  display: flex;
  gap: 8px;
}
.member-table {
  display: flex;
  flex-direction: column;
}
.member-row {
  display: grid;
  grid-template-columns: minmax(180px, 1.4fr) minmax(160px, 1fr) minmax(220px, 2fr) 80px;
  gap: 12px;
  align-items: start;
  padding: 12px 0;
  border-top: 1px solid var(--deploy-border);
}
.member-row--head {
  border-top: none;
  font-size: 12px;
  font-weight: 600;
  color: var(--deploy-muted-fg);
}
.member-cell--user {
  display: flex;
  align-items: center;
  gap: 10px;
}
.member-cell--user strong {
  font-size: 14px;
}
.member-cell--user small {
  display: block;
  color: var(--deploy-muted-fg);
  font-size: 12px;
}
.avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  object-fit: cover;
  flex: none;
}
.avatar--fallback {
  display: grid;
  place-items: center;
  background: #eff6ff;
  color: #1d4ed8;
  font-weight: 700;
}
.self-tag {
  font-size: 11px;
  color: #1d4ed8;
  background: #eff6ff;
  border-radius: 999px;
  padding: 0 6px;
  margin-left: 4px;
}
.role-static {
  font-size: 13px;
  color: var(--deploy-fg-secondary);
}
.select-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--deploy-border);
  border-radius: 8px;
  font-family: inherit;
  font-size: 13px;
  background: #fff;
  color: inherit;
}
.select-input--sm {
  max-width: 230px;
}
.member-cell--scope .scope-text {
  font-size: 13px;
  color: var(--deploy-fg-secondary);
  margin-right: 8px;
}
.scope-editor {
  border: 1px dashed var(--deploy-border);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.scope-option {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.scope-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.scope-hint {
  margin: 0;
  font-size: 12px;
  color: var(--deploy-muted-fg);
}
.member-cell--actions {
  text-align: right;
}
.user-results {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.user-result {
  text-align: left;
  border: 1px solid var(--deploy-border);
  border-radius: 8px;
  padding: 8px 10px;
  background: #fff;
  cursor: pointer;
  font-family: inherit;
}
.user-result:hover {
  border-color: #93c5fd;
}
.user-result small {
  display: block;
  color: var(--deploy-muted-fg);
}
.form-hint {
  margin: 0;
  font-size: 12px;
  color: var(--deploy-muted-fg);
}
@media (max-width: 900px) {
  .member-row {
    grid-template-columns: 1fr;
  }
}
</style>

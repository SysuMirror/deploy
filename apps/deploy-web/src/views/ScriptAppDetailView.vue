<script setup lang="ts">
/**
 * 脚本应用详情页（/scripts/:appId）。
 *
 * 把「应用级」的信息和操作收在这一页：
 *   - 是什么：说明、根目录（在哪台机器哪个目录执行）
 *   - 能做什么：命令组列表，点「执行」开运行抽屉填参数
 *   - 谁能用：成员列表、加入 / 退出
 *   - 管理：编辑、停用、删除（仅创建者 / 平台管理员）
 *
 * 运行抽屉和执行历史都收在 ScriptRunnerDrawer 里，这里只负责挑选命令组。
 */
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { scriptsApi, type ScriptApp, type ScriptAppMember } from '@/services/api';
import ScriptAppEditor from '@/components/ScriptAppEditor.vue';
import ScriptRunnerDrawer from '@/components/ScriptRunnerDrawer.vue';

const route = useRoute();
const router = useRouter();

const appId = String(route.params.appId ?? '');

const loading = ref(true);
const app = ref<ScriptApp | null>(null);
const error = ref('');
const notice = ref('');
const busy = ref(false);

const editorOpen = ref(false);
const runnerOpen = ref(false);
const activeCommandId = ref('');

const membersOpen = ref(false);
const members = ref<ScriptAppMember[]>([]);
const membersLoading = ref(false);

async function load(silent = false) {
  if (!silent) loading.value = true;
  error.value = '';
  try {
    const res = await scriptsApi.get(appId);
    app.value = res.app;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

function goBack() {
  router.push('/scripts');
}

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */

function runCommand(commandId: string) {
  if (!app.value?.canRun) return;
  activeCommandId.value = commandId;
  runnerOpen.value = true;
}

/* ------------------------------------------------------------------ *
 * 成员
 * ------------------------------------------------------------------ */

async function openMembers() {
  if (!app.value) return;
  membersOpen.value = true;
  membersLoading.value = true;
  try {
    const res = await scriptsApi.members(app.value.id);
    members.value = res.members;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取成员失败';
  } finally {
    membersLoading.value = false;
  }
}

async function kickMember(m: ScriptAppMember) {
  if (!app.value) return;
  if (!window.confirm(`将「${m.name}」移出应用？`)) return;
  try {
    const res = await scriptsApi.removeMember(app.value.id, m.userId);
    members.value = res.members;
    await load(true);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '移除失败';
  }
}

/* ------------------------------------------------------------------ *
 * 加入 / 退出 / 启停 / 删除
 * ------------------------------------------------------------------ */

async function joinApp() {
  if (!app.value) return;
  busy.value = true;
  error.value = '';
  try {
    await scriptsApi.join(app.value.id);
    notice.value = `已加入「${app.value.name}」，现在可以执行它的命令`;
    await load(true);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加入失败';
  } finally {
    busy.value = false;
  }
}

async function leaveApp() {
  if (!app.value) return;
  if (!window.confirm(`退出「${app.value.name}」后将无法执行它的命令，确定退出？`)) return;
  busy.value = true;
  try {
    await scriptsApi.leave(app.value.id);
    notice.value = `已退出「${app.value.name}」`;
    await load(true);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '退出失败';
  } finally {
    busy.value = false;
  }
}

async function toggleEnabled() {
  if (!app.value) return;
  busy.value = true;
  try {
    await scriptsApi.update(app.value.id, {
      name: app.value.name,
      description: app.value.description,
      workdir: app.value.workdir,
      enabled: !app.value.enabled,
      // 不传 commands：后端按整组替换语义，省略即保持原定义
    });
    await load(true);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败';
  } finally {
    busy.value = false;
  }
}

async function removeApp() {
  if (!app.value) return;
  if (!window.confirm(`确定删除应用「${app.value.name}」？其命令组会一并删除，执行记录会保留。`)) {
    return;
  }
  busy.value = true;
  try {
    await scriptsApi.remove(app.value.id);
    router.push('/scripts');
  } catch (e) {
    error.value = e instanceof Error ? e.message : '删除失败';
    busy.value = false;
  }
}

async function onSaved() {
  notice.value = '已保存';
  await load(true);
  if (membersOpen.value) void openMembers();
}
</script>

<template>
  <div class="app-detail">
    <button type="button" class="page-back" @click="goBack">← 返回脚本部署</button>

    <div v-if="loading" class="detail-state">
      <SlSpinner />
    </div>

    <div v-else-if="!app" class="detail-state deploy-surface">
      <p class="detail-state__title">应用不存在或无权查看</p>
      <p class="detail-state__desc">{{ error || '它可能已被删除。' }}</p>
      <SlButton size="sm" @click="goBack">返回列表</SlButton>
    </div>

    <template v-else>
      <SlAlert v-if="error" variant="error" class="mb-3">{{ error }}</SlAlert>
      <SlAlert v-else-if="notice" variant="success" class="mb-3">{{ notice }}</SlAlert>

      <header class="page-hero">
        <div class="page-hero__main">
          <p class="page-hero__eyebrow">脚本应用</p>
          <h1 class="page-hero__title">
            {{ app.name }}
            <span v-if="!app.enabled" class="sa-chip sa-chip--muted">已停用</span>
            <span v-else-if="app.joined" class="sa-chip sa-chip--joined">已加入</span>
            <span v-else class="sa-chip sa-chip--open">未加入</span>
          </h1>
          <p v-if="app.description" class="page-hero__desc">{{ app.description }}</p>

          <!-- 在哪执行：这个功能最容易踩坑的点，放在标题下面第一眼能看到的位置 -->
          <div class="exec-where">
            <span class="exec-where__host">宿主机</span>
            <code>{{ app.workdir }}</code>
          </div>
        </div>

        <div class="page-hero__actions">
          <template v-if="app.canRun">
            <SlButton
              v-if="app.commands.length"
              size="sm"
              :disabled="!app.enabled"
              @click="runCommand(app.commands[0].id)"
            >
              执行命令
            </SlButton>
          </template>
          <SlButton
            v-else
            size="sm"
            :loading="busy"
            :disabled="!app.enabled"
            @click="joinApp"
          >
            加入应用
          </SlButton>
          <SlButton variant="secondary" size="sm" @click="openMembers">成员 {{ app.memberCount }}</SlButton>
          <template v-if="app.canManage">
            <SlButton variant="secondary" size="sm" @click="editorOpen = true">编辑</SlButton>
            <SlButton variant="secondary" size="sm" :disabled="busy" @click="toggleEnabled">
              {{ app.enabled ? '停用' : '启用' }}
            </SlButton>
            <SlButton variant="secondary" size="sm" :disabled="busy" @click="removeApp">删除</SlButton>
          </template>
          <SlButton v-else-if="app.joined" variant="secondary" size="sm" :disabled="busy" @click="leaveApp">
            退出应用
          </SlButton>
        </div>
      </header>

      <SlAlert v-if="!app.enabled" variant="info" class="mb-3">
        该应用已被停用，停用期间不能执行任何命令组。
      </SlAlert>
      <SlAlert v-else-if="!app.canRun" variant="info" class="mb-3">
        你尚未加入该应用。命令组只有成员可以执行 —— 点右上角「加入应用」即可自助加入。
      </SlAlert>

      <!-- 命令组 -->
      <section class="sa-panel">
        <div class="cmd-head">
          <h2>命令组</h2>
          <span class="count">{{ app.commands.length }}</span>
        </div>
        <p class="cmd-head__desc">
          点「执行」开运行面板：填参数 → 核对完整命令 → 下发，输出实时回流。
        </p>

        <p v-if="!app.commands.length" class="sa-cmd-empty">该应用还没有配置命令组。</p>

        <ul v-else class="cmd-list">
          <li v-for="cmd in app.commands" :key="cmd.id" class="cmd-item">
            <div class="cmd-item__main">
              <h3 class="cmd-item__name">{{ cmd.name }}</h3>
              <p v-if="cmd.description" class="cmd-item__desc">{{ cmd.description }}</p>
              <code class="cmd-item__text">{{ cmd.mainCommand }}</code>
              <p v-if="cmd.params.length" class="cmd-item__params">
                参数：
                <code v-for="p in cmd.params" :key="p.id" class="cmd-item__flag">{{ p.flag }}</code>
              </p>
              <p v-else class="cmd-item__params">无参数</p>
            </div>
            <div class="cmd-item__side">
              <SlButton
                size="sm"
                :disabled="!app.canRun || !app.enabled"
                @click="runCommand(cmd.id)"
              >
                执行
              </SlButton>
              <span v-if="!app.canRun" class="cmd-item__hint">加入后可执行</span>
              <span v-else-if="!app.enabled" class="cmd-item__hint">已停用</span>
            </div>
          </li>
        </ul>
      </section>
    </template>

    <!-- 成员弹窗 -->
    <SlModal v-model="membersOpen" :title="`成员 · ${app?.name ?? ''}`" width="520px">
      <div v-if="membersLoading" class="members-state"><SlSpinner /></div>
      <ul v-else class="member-list">
        <li v-for="m in members" :key="m.userId" class="member-item">
          <div class="member-item__main">
            <span class="member-item__name">
              {{ m.name || m.userId }}
              <span v-if="m.isSelf" class="member-item__self">你</span>
            </span>
            <span class="member-item__email">{{ m.email || '—' }}</span>
          </div>
          <span class="sa-chip" :class="m.role === 'owner' ? 'sa-chip--owner' : 'sa-chip--muted'">
            {{ m.role === 'owner' ? '创建者' : '成员' }}
          </span>
          <button
            v-if="m.role !== 'owner' && app?.canManage"
            type="button"
            class="sa-link sa-link--danger"
            @click="kickMember(m)"
          >
            移除
          </button>
        </li>
      </ul>
      <p class="members-tip">命令只有成员可以执行。其他开发者可以在详情页自助加入。</p>
    </SlModal>

    <ScriptAppEditor v-model="editorOpen" :app="app" @saved="onSaved" />

    <ScriptRunnerDrawer v-model="runnerOpen" :app="app" :command-id="activeCommandId" />
  </div>
</template>

<style scoped>
.mb-3 {
  margin-bottom: 12px;
}
.detail-state {
  padding: 56px 24px;
  text-align: center;
  color: var(--deploy-fg-secondary);
  border-radius: var(--deploy-radius-lg);
}
.detail-state__title {
  margin: 0 0 8px;
  font-weight: 650;
  color: var(--deploy-fg);
}
.detail-state__desc {
  margin: 0 auto 18px;
  max-width: 36rem;
  font-size: 13px;
}

/* 标题里的状态标不该撑成一行标题那么大 */
.page-hero__title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.page-hero__title .sa-chip {
  font-size: 12px;
  padding: 3px 10px;
}

/* —— 在哪执行 —— */
.exec-where {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  min-width: 0;
}
.exec-where__host {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 650;
  background: #e0f2fe;
  color: #0369a1;
}
.exec-where code {
  font-family: var(--deploy-mono);
  font-size: 12.5px;
  color: var(--deploy-fg-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* —— 命令组 —— */
.cmd-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cmd-head h2 {
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
.cmd-head__desc {
  margin: 4px 0 14px;
  font-size: 13px;
  color: var(--deploy-muted-fg);
}
.cmd-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cmd-item {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 13px 14px;
  border: 1px solid var(--deploy-border);
  border-radius: var(--deploy-radius-lg);
  background: var(--deploy-muted);
}
.cmd-item__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.cmd-item__name {
  margin: 0;
  font-size: 14px;
  font-weight: 680;
  letter-spacing: -0.01em;
}
.cmd-item__desc {
  margin: 0;
  font-size: 12.5px;
  color: var(--deploy-fg-secondary);
  line-height: 1.5;
}
.cmd-item__text {
  font-family: var(--deploy-mono);
  font-size: 12.5px;
  color: var(--deploy-fg);
  background: var(--deploy-card);
  border: 1px solid var(--deploy-border);
  border-radius: var(--deploy-radius);
  padding: 6px 9px;
  word-break: break-all;
}
.cmd-item__params {
  margin: 0;
  font-size: 11.5px;
  color: var(--deploy-muted-fg);
}
.cmd-item__flag {
  font-family: var(--deploy-mono);
  font-size: 11.5px;
  background: var(--deploy-card);
  border: 1px solid var(--deploy-border);
  border-radius: 999px;
  padding: 1px 7px;
  margin-right: 5px;
  color: var(--deploy-fg-secondary);
}
.cmd-item__side {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.cmd-item__hint {
  font-size: 11px;
  color: var(--deploy-muted-fg);
}

/* —— 成员 —— */
.members-state {
  padding: 28px;
  text-align: center;
}
.member-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.member-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: var(--deploy-radius);
  background: var(--deploy-muted);
}
.member-item__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.member-item__name {
  font-size: 13.5px;
  font-weight: 620;
  display: flex;
  align-items: center;
  gap: 6px;
}
.member-item__self {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--deploy-accent-soft);
  color: var(--deploy-primary);
  font-weight: 650;
}
.member-item__email {
  font-size: 11.5px;
  color: var(--deploy-muted-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.members-tip {
  margin: 12px 0 0;
  font-size: 11.5px;
  color: var(--deploy-muted-fg);
}

@media (max-width: 720px) {
  /* 返回按钮在全站是 31px 高的小链接，手机上抬手点容易点空 */
  .page-back {
    min-height: 44px;
    padding: 0 0 10px;
  }
  .page-hero {
    flex-direction: column;
    gap: 14px;
  }
  .page-hero__actions {
    width: 100%;
  }
  .page-hero__actions :deep(.sl-btn) {
    flex: 1 1 auto;
    min-height: 44px;
  }
  /* 目录在手机上折行显示，别截成省略号（这是最需要看清的信息） */
  .exec-where {
    align-items: flex-start;
  }
  .exec-where code {
    white-space: normal;
    word-break: break-all;
  }
  /* 命令组：执行按钮从右侧竖排挪到下面通栏，避免把命令主体挤成一列 */
  .cmd-item {
    flex-direction: column;
    gap: 10px;
  }
  .cmd-item__side {
    width: 100%;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
  .cmd-item__side :deep(.sl-btn) {
    min-height: 44px;
    flex: 1 1 auto;
  }
  .member-item {
    flex-wrap: wrap;
  }
  .member-item__main {
    flex: 1 1 100%;
  }
}
</style>

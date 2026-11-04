<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  devApi,
  NotDeveloperError,
  type DevIdentity,
  type OaListEntry,
} from '@/services/api';

const loading = ref(true);
const identity = ref<DevIdentity | null>(null);
const notDev = ref<{ joinUrl: string; platformUrl: string } | null>(null);
const error = ref('');
const items = ref<OaListEntry[]>([]);

const showForm = ref(false);
const title = ref('');
const content = ref('');
const submitting = ref(false);
const actionMsg = ref('');
const actionOk = ref(false);
const expanded = ref<string | null>(null);

const STATUS_LABEL: Record<string, string> = {
  pending: '审批中',
  approved: '已通过',
  rejected: '已驳回',
};

const ACTION_LABEL: Record<string, string> = {
  submit: '提交',
  approve: '通过',
  reject: '驳回',
  revoke: '撤回',
  comment: '备注',
};

const pendingCount = computed(() => items.value.filter((x) => x.item?.status === 'pending').length);
const approvedCount = computed(() => items.value.filter((x) => x.item?.status === 'approved').length);
const rejectedCount = computed(() => items.value.filter((x) => x.item?.status === 'rejected').length);

async function load() {
  error.value = '';
  try {
    const me = await devApi.me();
    identity.value = me;
    if (me.configured && me.checked && !me.effective) {
      notDev.value = { joinUrl: me.joinUrl, platformUrl: me.platformUrl };
      loading.value = false;
      return;
    }
    notDev.value = null;
    const res = await devApi.oaList();
    items.value = res.items;
  } catch (e) {
    if (e instanceof NotDeveloperError) {
      notDev.value = { joinUrl: e.joinUrl, platformUrl: e.platformUrl };
    } else {
      error.value = e instanceof Error ? e.message : '加载失败';
    }
  } finally {
    loading.value = false;
  }
}

async function submit() {
  const t = title.value.trim();
  if (!t) {
    actionOk.value = false;
    actionMsg.value = '请填写审批单标题';
    return;
  }
  submitting.value = true;
  actionMsg.value = '';
  try {
    const r = await devApi.oaSubmit({ title: t, content: content.value.trim() });
    actionOk.value = true;
    actionMsg.value = `已提交（${r.item.oaid}），等待平台管理员审批`;
    title.value = '';
    content.value = '';
    showForm.value = false;
    await load();
  } catch (e) {
    actionOk.value = false;
    actionMsg.value = e instanceof Error ? e.message : '提交失败';
  } finally {
    submitting.value = false;
  }
}

function toggle(oaid: string) {
  expanded.value = expanded.value === oaid ? null : oaid;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function statusClass(s: string | undefined): string {
  return s === 'approved' ? 'is-ok' : s === 'rejected' ? 'is-bad' : 'is-wait';
}

onMounted(() => void load());
</script>

<template>
  <div class="oa-page">
    <header class="page-hero">
      <div>
        <p class="page-hero__eyebrow">开发者中心</p>
        <h1 class="page-hero__title">OA 审批</h1>
        <p class="page-hero__desc">
          审批单经集市开发者平台统一流转，平台管理员处理；
          提交后可在此跟踪<span v-if="identity?.name">，当前身份：{{ identity.name }}</span>。
        </p>
      </div>
      <div class="page-hero__actions">
        <a class="ghost-link" :href="identity?.platformUrl || 'https://developer.ssemarket.cn'" target="_blank" rel="noreferrer">
          开发者平台 ↗
        </a>
        <SlButton size="sm" :disabled="!identity?.effective" @click="showForm = !showForm">
          {{ showForm ? '收起表单' : '提交审批' }}
        </SlButton>
      </div>
    </header>

    <!-- 非开发者门禁 -->
    <section v-if="notDev" class="gate deploy-surface">
      <div class="gate__icon">
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          <path d="M12 3l7 4v5c0 4.4-3 8.4-7 9-4-.6-7-4.6-7-9V7l7-4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
          <path d="M9.5 12l2 2 3.5-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <div class="gate__body">
        <h2>仅开发者可使用 OA 审批</h2>
        <p>
          你的集市账号还没有开发者身份。前往
          <a :href="notDev.joinUrl" target="_blank" rel="noreferrer">开发者平台 → 加入开发者</a>
          提交申请（填写申请理由），管理员通过后回到本页即可使用。
        </p>
        <div class="gate__steps">
          <span>1 · 打开开发者平台</span>
          <span>2 · 点击「加入开发者」填写申请</span>
          <span>3 · 等待管理员审核通过</span>
        </div>
      </div>
      <a class="gate__cta" :href="notDev.joinUrl" target="_blank" rel="noreferrer">去申请成为开发者 ↗</a>
    </section>

    <template v-else>
      <SlAlert v-if="error" variant="error" class="mb">{{ error }}</SlAlert>
      <SlAlert v-if="actionMsg" :variant="actionOk ? 'success' : 'error'" class="mb">{{ actionMsg }}</SlAlert>
      <div v-if="loading" class="page-loading"><SlSpinner /></div>

      <template v-else>
        <!-- 提交表单 -->
        <section v-if="showForm" class="form-card deploy-surface">
          <div class="field">
            <label>审批标题 <i>*</i></label>
            <input v-model="title" maxlength="200" placeholder="例如：上线审批：ai-platform v1.3" />
          </div>
          <div class="field">
            <label>变更说明</label>
            <textarea v-model="content" rows="3" maxlength="5000" placeholder="变更内容 / 风险说明（可选）" />
          </div>
          <div class="form-foot">
            <span class="muted">提交后进入平台管理员待办，处理结果在本页与开发者平台均可查询。</span>
            <SlButton size="sm" :disabled="submitting" @click="submit">{{ submitting ? '提交中…' : '提交审批单' }}</SlButton>
          </div>
        </section>

        <!-- KPI -->
        <section class="kpi-row">
          <div class="kpi deploy-surface">
            <span class="kpi__num">{{ items.length }}</span>
            <span class="kpi__label">累计提交</span>
          </div>
          <div class="kpi deploy-surface">
            <span class="kpi__num is-wait">{{ pendingCount }}</span>
            <span class="kpi__label">审批中</span>
          </div>
          <div class="kpi deploy-surface">
            <span class="kpi__num is-ok">{{ approvedCount }}</span>
            <span class="kpi__label">已通过</span>
          </div>
          <div class="kpi deploy-surface">
            <span class="kpi__num is-bad">{{ rejectedCount }}</span>
            <span class="kpi__label">已驳回</span>
          </div>
        </section>

        <!-- 列表 -->
        <div class="list-panel deploy-surface">
          <div class="list-panel__head">
            <span class="muted">我的审批单（{{ items.length }}）</span>
            <button class="refresh-btn" :disabled="loading" @click="load">刷新</button>
          </div>
          <div class="table-wrap">
            <table v-if="items.length" class="oa-table">
              <thead>
                <tr>
                  <th class="col-oaid">单号</th>
                  <th>标题</th>
                  <th class="col-status">状态</th>
                  <th class="col-time">提交时间</th>
                  <th class="col-act">操作</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="x in items" :key="x.oaid">
                  <tr class="row-main" @click="toggle(x.oaid)">
                    <td class="col-oaid mono">{{ x.oaid }}</td>
                    <td class="title-cell">
                      <span class="title-text">{{ x.item?.title || x.localTitle }}</span>
                      <span v-if="!x.online" class="offline-tag">平台离线</span>
                    </td>
                    <td class="col-status">
                      <span v-if="x.item" class="status-pill" :class="statusClass(x.item.status)">
                        {{ STATUS_LABEL[x.item.status] || x.item.status }}
                      </span>
                      <span v-else class="status-pill">未知</span>
                    </td>
                    <td class="col-time muted">{{ fmtTime(x.item?.submitAt || x.createdAt) }}</td>
                    <td class="col-act">
                      <button class="act-btn" @click.stop="toggle(x.oaid)">{{ expanded === x.oaid ? '收起' : '详情' }}</button>
                    </td>
                  </tr>
                  <tr v-if="expanded === x.oaid" class="row-detail">
                    <td colspan="5">
                      <div v-if="x.item" class="detail">
                        <div class="detail__grid">
                          <div><i>说明</i><p>{{ x.item.content || '（无）' }}</p></div>
                          <div><i>当前节点</i><p>{{ x.item.currentNode === 'admin' ? '平台管理员' : x.item.currentNode || '—' }}</p></div>
                          <div><i>最近更新</i><p>{{ fmtTime(x.item.updatedAt) }}</p></div>
                          <div><i>完成时间</i><p>{{ fmtTime(x.item.finishedAt) }}</p></div>
                        </div>
                        <h4>流转记录</h4>
                        <ol class="timeline">
                          <li v-for="(t, i) in x.item.timeline" :key="i">
                            <span class="tl-action" :class="statusClass(t.action === 'approve' ? 'approved' : t.action === 'reject' ? 'rejected' : 'pending')">
                              {{ ACTION_LABEL[t.action] || t.action }}
                            </span>
                            <span class="tl-note">{{ t.note || (t.viaModule ? `经 ${t.viaModule}` : '') }}</span>
                            <span class="tl-by" v-if="t.by">· {{ t.by }}</span>
                            <span class="tl-at muted">{{ fmtTime(t.at) }}</span>
                          </li>
                        </ol>
                      </div>
                      <div v-else class="detail detail--offline">开发者平台暂不可达，仅显示本地标题。</div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
            <div v-else class="empty-inline">
              还没有审批单，点右上角「提交审批」发起第一单。
            </div>
          </div>

          <!-- 移动端：卡片布局 -->
          <div v-if="items.length" class="oa-cards">
            <div v-for="x in items" :key="`m-${x.oaid}`" class="oa-card">
              <button class="oa-card__main" @click="toggle(x.oaid)">
                <div class="oa-card__top">
                  <span class="oa-card__oaid mono">{{ x.oaid }}</span>
                  <span v-if="x.item" class="status-pill" :class="statusClass(x.item.status)">
                    {{ STATUS_LABEL[x.item.status] || x.item.status }}
                  </span>
                  <span v-else class="status-pill">未知</span>
                </div>
                <div class="oa-card__title">
                  {{ x.item?.title || x.localTitle }}
                  <span v-if="!x.online" class="offline-tag">平台离线</span>
                </div>
                <div class="oa-card__meta muted">
                  <span>{{ fmtTime(x.item?.submitAt || x.createdAt) }}</span>
                  <span class="oa-card__more">{{ expanded === x.oaid ? '收起 ▴' : '详情 ▾' }}</span>
                </div>
              </button>
              <div v-if="expanded === x.oaid" class="oa-card__detail">
                <div v-if="x.item" class="detail">
                  <div class="detail__grid">
                    <div><i>说明</i><p>{{ x.item.content || '（无）' }}</p></div>
                    <div><i>当前节点</i><p>{{ x.item.currentNode === 'admin' ? '平台管理员' : x.item.currentNode || '—' }}</p></div>
                    <div><i>最近更新</i><p>{{ fmtTime(x.item.updatedAt) }}</p></div>
                    <div><i>完成时间</i><p>{{ fmtTime(x.item.finishedAt) }}</p></div>
                  </div>
                  <h4>流转记录</h4>
                  <ol class="timeline">
                    <li v-for="(t, i) in x.item.timeline" :key="i">
                      <span class="tl-action" :class="statusClass(t.action === 'approve' ? 'approved' : t.action === 'reject' ? 'rejected' : 'pending')">
                        {{ ACTION_LABEL[t.action] || t.action }}
                      </span>
                      <span class="tl-note">{{ t.note || (t.viaModule ? `经 ${t.viaModule}` : '') }}</span>
                      <span class="tl-by" v-if="t.by">· {{ t.by }}</span>
                      <span class="tl-at muted">{{ fmtTime(t.at) }}</span>
                    </li>
                  </ol>
                </div>
                <div v-else class="detail detail--offline">开发者平台暂不可达，仅显示本地标题。</div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.oa-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page-hero__actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ghost-link {
  font-size: 13px;
  font-weight: 600;
  color: var(--deploy-primary);
  text-decoration: none;
  padding: 7px 12px;
  border-radius: 8px;
  transition: background 0.15s ease;
}
.ghost-link:hover {
  background: var(--deploy-accent-soft);
}

/* —— 非开发者门禁 —— */
.gate {
  display: flex;
  align-items: flex-start;
  gap: 18px;
  padding: 26px 28px;
}
.gate__icon {
  flex: none;
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  background: var(--deploy-accent-soft);
  color: var(--deploy-primary);
}
.gate__body {
  flex: 1;
  min-width: 0;
}
.gate__body h2 {
  margin: 0 0 8px;
  font-size: 17px;
  letter-spacing: -0.01em;
}
.gate__body p {
  margin: 0 0 14px;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--deploy-fg-secondary);
}
.gate__body a {
  color: var(--deploy-primary);
  font-weight: 600;
  text-decoration: none;
}
.gate__body a:hover {
  text-decoration: underline;
}
.gate__steps {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.gate__steps span {
  font-size: 12px;
  font-weight: 600;
  color: var(--deploy-fg-secondary);
  background: var(--deploy-muted);
  padding: 5px 12px;
  border-radius: 999px;
}
.gate__cta {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 10px 18px;
  border-radius: 999px;
  background: var(--deploy-primary);
  color: #fff;
  font-size: 13.5px;
  font-weight: 700;
  text-decoration: none;
  transition: background 0.15s ease, transform 0.15s ease;
}
.gate__cta:hover {
  background: var(--deploy-primary-hover);
}
.gate__cta:active {
  transform: scale(0.98);
}

/* —— 表单 —— */
.form-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field label {
  font-size: 13px;
  font-weight: 600;
  color: var(--deploy-fg-secondary);
}
.field label i {
  color: #dc2626;
  font-style: normal;
}
.field input,
.field textarea {
  border: 1px solid var(--deploy-border);
  border-radius: 9px;
  padding: 9px 12px;
  font-family: inherit;
  font-size: 13.5px;
  color: var(--deploy-fg);
  background: #fff;
  outline: none;
  resize: vertical;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.field input:focus,
.field textarea:focus {
  border-color: var(--deploy-primary);
  box-shadow: 0 0 0 3px var(--deploy-accent-soft);
}
.form-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* —— KPI —— */
.kpi-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.kpi {
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kpi__num {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.kpi__num.is-wait { color: #d97706; }
.kpi__num.is-ok { color: #079455; }
.kpi__num.is-bad { color: #dc2626; }
.kpi__label {
  font-size: 12px;
  color: var(--deploy-muted-fg);
}

/* —— 列表头 —— */
.list-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--deploy-border);
  font-size: 12.5px;
}
.refresh-btn {
  border: 1px solid var(--deploy-border);
  background: #fff;
  color: var(--deploy-fg-secondary);
  font-size: 12px;
  font-weight: 600;
  padding: 5px 12px;
  border-radius: 7px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s ease;
}
.refresh-btn:hover:not(:disabled) {
  border-color: var(--deploy-primary);
  color: var(--deploy-primary);
}
.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 表格容器：横向滚动兜底 + 卡片内边距（表格不贴边） */
.table-wrap {
  width: 100%;
  overflow-x: auto;
  padding: 4px 16px 12px;
}
.oa-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 13px;
}
.oa-table th,
.oa-table td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--deploy-border);
  vertical-align: middle;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.oa-table th {
  font-weight: 600;
  color: var(--deploy-fg-secondary);
  background: #fafbfc;
  font-size: 12px;
  letter-spacing: 0.02em;
}
.oa-table tbody tr:last-child td {
  border-bottom: none;
}
.row-main {
  cursor: pointer;
}
.row-main:hover td {
  background: #f8fafc;
}
.col-oaid { width: 170px; }
.col-status { width: 110px; }
.col-time { width: 170px; }
.col-act { width: 90px; }
.mono {
  font-family: var(--deploy-mono);
  font-size: 12px;
}
.muted {
  color: var(--deploy-muted-fg);
  font-size: 12.5px;
}
.title-cell {
  max-width: 380px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.title-text {
  font-weight: 600;
}
.offline-tag {
  margin-left: 8px;
  padding: 1px 7px;
  border-radius: 5px;
  background: #fef3c7;
  color: #b45309;
  font-size: 10.5px;
  font-weight: 700;
}
.status-pill {
  display: inline-block;
  min-width: 56px;
  text-align: center;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  background: #f1f5f9;
  color: #475569;
}
.status-pill.is-wait { background: #fef3c7; color: #b45309; }
.status-pill.is-ok { background: #dcfce7; color: #15803d; }
.status-pill.is-bad { background: #fee2e2; color: #b91c1c; }
.act-btn {
  border: 1px solid var(--deploy-border);
  background: #fff;
  color: var(--deploy-fg-secondary);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: 7px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.act-btn:hover {
  border-color: var(--deploy-primary);
  color: var(--deploy-primary);
}

/* —— 详情行 —— */
.row-detail td {
  background: #f8fafc;
  white-space: normal;
}
.detail {
  padding: 6px 4px;
}
.detail--offline {
  color: var(--deploy-muted-fg);
  font-size: 12.5px;
}
.detail__grid {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr;
  gap: 14px;
  margin-bottom: 12px;
}
.detail__grid i {
  display: block;
  font-style: normal;
  font-size: 11.5px;
  color: var(--deploy-muted-fg);
  margin-bottom: 3px;
}
.detail__grid p {
  margin: 0;
  font-size: 13px;
}
.detail h4 {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: var(--deploy-fg-secondary);
}
.timeline {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.timeline li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}
.tl-action {
  flex: none;
  padding: 1px 9px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 700;
  background: #f1f5f9;
  color: #475569;
}
.tl-action.is-ok { background: #dcfce7; color: #15803d; }
.tl-action.is-bad { background: #fee2e2; color: #b91c1c; }
.tl-note { color: var(--deploy-fg); }
.tl-by { color: var(--deploy-fg-secondary); }

.empty-inline {
  padding: 40px;
  text-align: center;
  color: var(--deploy-muted-fg);
  font-size: 13px;
}

@media (max-width: 900px) {
  .kpi-row { grid-template-columns: repeat(2, 1fr); }
  .detail__grid { grid-template-columns: 1fr 1fr; }
  .gate { flex-direction: column; }
}

/* —— 移动端：表格 → 卡片 —— */
.oa-cards {
  display: none;
}
.oa-card {
  border-bottom: 1px solid var(--deploy-border);
}
.oa-card:last-child {
  border-bottom: none;
}
.oa-card__main {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  font-family: inherit;
  padding: 12px 14px;
  cursor: pointer;
}
.oa-card__top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.oa-card__oaid {
  flex: 1;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
}
.oa-card__title {
  margin-top: 6px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--deploy-fg);
  word-break: break-all;
  line-height: 1.5;
}
.oa-card__meta {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.oa-card__more {
  margin-left: auto;
  color: var(--deploy-primary);
  font-weight: 600;
}
.oa-card__detail {
  padding: 0 14px 12px;
  background: #fafbfc;
}
@media (max-width: 640px) {
  .table-wrap {
    display: none;
  }
  .oa-cards {
    display: flex;
    flex-direction: column;
    padding: 4px 10px 10px;
  }
  .oa-card__detail {
    margin: 0 4px;
  }
  .detail__grid {
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .timeline li {
    flex-wrap: wrap;
    row-gap: 2px;
  }
  .page-hero {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
}
</style>

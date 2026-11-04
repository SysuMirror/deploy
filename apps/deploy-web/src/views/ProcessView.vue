<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { monitorApi, type ProcessListResponse } from '@/services/api';
import MonitorTabs from '@/components/MonitorTabs.vue';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const loading = ref(true);
const error = ref('');
const data = ref<ProcessListResponse | null>(null);
const keyword = ref('');
const autoRefresh = ref(true);
const killing = ref<number | null>(null);
const actionMsg = ref('');
const actionOk = ref(false);
const sortBy = ref<'cpu' | 'mem' | 'pid'>('cpu');
let timer: ReturnType<typeof setInterval> | null = null;

const canManage = ref(false);

async function load() {
  error.value = '';
  try {
    data.value = await monitorApi.listProcesses(keyword.value || undefined, sortBy.value);
    canManage.value = data.value.canManage ?? auth.user?.isPlatformAdmin ?? false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

watch(keyword, () => void load());
watch(sortBy, () => void load());

/** —— 行内操作下拉（Teleport 到 body，避免被表格 overflow 裁剪）+ 确认弹窗 —— */
type ProcRow = { pid: number; command: string; cmdline: string };
type PendingAction = { pid: number; command: string; cmdline: string; force: boolean } | null;
const menu = ref<{ proc: ProcRow; x: number; y: number } | null>(null);
const pending = ref<PendingAction>(null);
const confirmBusy = ref(false);

function openMenu(p: ProcRow, e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  // 菜单宽约 190px，右对齐按钮；贴右边缘时收进来
  const x = Math.max(8, Math.min(r.right - 190, window.innerWidth - 200));
  menu.value = { proc: p, x, y: r.bottom + 6 };
}
function askKill(p: ProcRow, force: boolean) {
  menu.value = null;
  pending.value = { ...p, force };
}
async function confirmKill() {
  if (!pending.value || confirmBusy.value) return;
  confirmBusy.value = true;
  const { pid, force } = pending.value;
  actionMsg.value = '';
  try {
    const r = await monitorApi.killProcess(pid, force);
    actionOk.value = r.ok;
    actionMsg.value = r.message;
    pending.value = null;
    await load();
  } catch (e) {
    actionOk.value = false;
    actionMsg.value = e instanceof Error ? e.message : '操作失败';
  } finally {
    confirmBusy.value = false;
  }
}
function closeMenus() {
  menu.value = null;
}

async function mailTest() {
  if (!window.confirm('向管理员发送一封 SMTP 测试邮件？')) return;
  actionMsg.value = '';
  try {
    const r = await monitorApi.mailTest();
    actionOk.value = r.ok;
    actionMsg.value = r.ok
      ? `测试邮件已发送至：${r.recipients.join('、')}`
      : `发送失败：${r.error || '未知错误'}`;
  } catch (e) {
    actionOk.value = false;
    actionMsg.value = e instanceof Error ? e.message : '发送失败';
  }
}

function fmtTime(iso: string) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function fmtUptime(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 时`;
}

function level(v: number) {
  return v >= 90 ? 'is-hot' : v >= 50 ? 'is-warm' : '';
}

function barClass(v: number) {
  return v >= 80 ? 'is-hot' : v >= 50 ? 'is-warm' : '';
}

onMounted(() => {
  void load();
  timer = setInterval(() => {
    if (autoRefresh.value && !loading.value && killing.value === null && !pending.value) void load();
  }, 3_000);
  document.addEventListener('click', closeMenus);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
  document.removeEventListener('click', closeMenus);
});
</script>

<template>
  <div class="monitor-page">
    <header class="page-hero">
      <div>
        <p class="page-hero__eyebrow">监控中心</p>
        <h1 class="page-hero__title">进程管理</h1>
        <p class="page-hero__desc">
          实时进程 CPU / 内存占用{{ canManage ? '，支持安全终止；' : '；' }}
          内存 ≥ {{ data?.daemon.memWarnThreshold ?? 85 }}% 自动邮件告警，内存 ≥
          {{ data?.daemon.killThreshold ?? 95 }}% 自动强制终止内存最大的进程。
        </p>
      </div>
      <div class="page-hero__actions">
        <label class="switch">
          <input v-model="autoRefresh" type="checkbox" />
          <span>3s 自动刷新</span>
        </label>
        <SlButton v-if="canManage" size="sm" variant="secondary" @click="mailTest">发送测试邮件</SlButton>
      </div>
    </header>

    <MonitorTabs />

    <SlAlert v-if="error" variant="error" class="mb">{{ error }}</SlAlert>
    <SlAlert v-if="actionMsg" :variant="actionOk ? 'success' : 'error'" class="mb">{{ actionMsg }}</SlAlert>
    <div v-if="loading" class="page-loading"><SlSpinner /></div>

    <template v-else-if="data">
      <!-- 守护状态条：CPU + 内存 -->
      <section class="daemon-bar">
        <div class="gauge">
          <div class="gauge__head">
            <span class="gauge__label">CPU 使用率</span>
            <b class="gauge__value" :class="level(data.daemon.lastCpu)">{{ data.daemon.lastCpu }}%</b>
          </div>
          <div class="gauge__bar">
            <div class="gauge__fill" :class="barClass(data.daemon.lastCpu)" :style="{ width: Math.min(100, data.daemon.lastCpu) + '%' }" />
          </div>
          <div class="gauge__meta">
            <span class="daemon-sub">整机使用率</span>
          </div>
        </div>
        <div class="gauge">
          <div class="gauge__head">
            <span class="gauge__label">内存使用率</span>
            <b class="gauge__value" :class="level(data.daemon.lastMemPercent ?? 0)">{{ data.daemon.lastMemPercent ?? 0 }}%</b>
          </div>
          <div class="gauge__bar">
            <div class="gauge__fill gauge__fill--mem" :class="barClass(data.daemon.lastMemPercent ?? 0)" :style="{ width: Math.min(100, data.daemon.lastMemPercent ?? 0) + '%' }" />
          </div>
          <div class="gauge__meta">
            告警 {{ data.daemon.memWarnThreshold ?? 85 }}% · 强杀 {{ data.daemon.killThreshold ?? 95 }}%
            <span class="daemon-sub">已用 {{ data.daemon.memUsedMb ?? 0 }} MB / 共 {{ data.daemon.memTotalMb ?? 0 }} MB · {{ data.daemon.killStreak }}/6 轮</span>
          </div>
        </div>
        <span v-if="data.daemon.lastKillInfo" class="daemon-item daemon-item--wide" title="最近自动终止">
          最近自动终止：<b>{{ data.daemon.lastKillInfo }}</b>
        </span>
      </section>

      <div class="list-panel">
        <div class="list-panel__head">
          <span class="muted">共 {{ data.total }} 个进程{{ keyword ? `（筛选：${keyword}）` : '' }}，显示 {{ data.processes.length }}</span>
          <span class="head-controls">
            排序
            <select v-model="sortBy" class="mini-select">
              <option value="cpu">按 CPU</option>
              <option value="mem">按内存</option>
              <option value="pid">按 PID（新→旧）</option>
            </select>
            <input v-model="keyword" class="mini-input" placeholder="筛选命令名，如 node" />
          </span>
        </div>
        <div class="table-wrap">
          <table v-if="data.processes.length" class="log-table">
            <thead>
              <tr>
                <th class="col-pid">PID</th>
                <th class="col-user">用户</th>
                <th class="col-num">CPU</th>
                <th class="col-num">内存</th>
                <th class="col-num">RSS</th>
                <th>命令</th>
                <th class="col-time">启动时间</th>
                <th v-if="canManage" class="col-act">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in data.processes" :key="p.pid">
                <td class="col-pid mono">{{ p.pid }}</td>
                <td class="col-user">{{ p.user }}</td>
                <td class="col-num">
                  <span class="cpu-chip" :class="level(p.cpuPercent)">{{ p.cpuPercent }}%</span>
                </td>
                <td class="col-num">
                  <span class="cpu-chip" :class="level(p.memPercent)">{{ p.memPercent }}%</span>
                </td>
                <td class="col-num mono">{{ p.rssMb }} MB</td>
                <td class="cmd-cell" :title="p.cmdline">
                  <code>{{ p.cmdline }}</code>
                  <span v-if="p.protected" class="prot-tag">系统</span>
                </td>
                <td class="col-time muted" :title="fmtTime(p.startedAt)">{{ fmtUptime(p.startedAt) }}</td>
                <td v-if="canManage" class="col-act" @click.stop>
                  <div v-if="p.pid <= 2 || p.pid === 1" class="muted">—</div>
                  <button
                    v-else
                    class="act-trigger"
                    :disabled="killing === p.pid"
                    @click="openMenu(p, $event)"
                  >
                    操作
                    <svg viewBox="0 0 10 6" width="9" height="6" aria-hidden="true">
                      <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty-inline">无匹配进程</div>
        </div>

        <!-- 移动端：卡片布局 -->
        <div v-if="data.processes.length" class="proc-cards">
          <div v-for="p in data.processes" :key="`m-${p.pid}`" class="proc-card">
            <div class="proc-card__top">
              <span class="cpu-chip" :class="level(p.cpuPercent)">{{ p.cpuPercent }}%</span>
              <span class="cpu-chip" :class="level(p.memPercent)">{{ p.memPercent }}%</span>
              <span class="proc-card__rss mono">{{ p.rssMb }} MB</span>
              <button
                v-if="canManage && p.pid > 2"
                class="act-trigger"
                :disabled="killing === p.pid"
                @click="openMenu(p, $event)"
              >
                操作
                <svg viewBox="0 0 10 6" width="9" height="6" aria-hidden="true">
                  <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
            <code class="proc-card__cmd" :title="p.cmdline">{{ p.cmdline }}</code>
            <div class="proc-card__meta">
              <span class="mono">PID {{ p.pid }}</span>
              <span>{{ p.user }}</span>
              <span class="muted">{{ fmtUptime(p.startedAt) }}</span>
              <span v-if="p.protected" class="prot-tag">系统</span>
            </div>
          </div>
        </div>
        <div v-if="!data.processes.length" class="empty-inline mobile-empty">无匹配进程</div>
      </div>
      <p v-if="!canManage" class="muted perm-note">查看权限已开放；终止进程操作仅平台管理员可用。</p>

      <!-- 操作二次确认弹窗 -->
      <SlModal :model-value="pending !== null" title="确认执行操作" width="440px" @update:model-value="pending = null">
        <div v-if="pending" class="confirm-body">
          <p class="confirm-line">
            确认对进程
            <b>PID {{ pending.pid }}（{{ pending.command }}）</b>
            {{ pending.force ? '执行 SIGKILL 强制终止？' : '发送 SIGTERM 优雅终止？' }}
          </p>
          <code class="confirm-cmd">{{ pending.cmdline }}</code>
          <p v-if="pending.force" class="confirm-warn">强制终止（SIGKILL）不给进程清理现场的机会，可能丢失数据，仅在进程无响应时使用。</p>
        </div>
        <template #footer>
          <SlButton size="sm" variant="secondary" @click="pending = null">取消</SlButton>
          <SlButton
            size="sm"
            :variant="pending?.force ? 'primary' : 'primary'"
            :class="{ 'confirm-btn--danger': pending?.force }"
            :disabled="confirmBusy"
            @click="confirmKill"
          >
            {{ confirmBusy ? '执行中…' : pending?.force ? '确认强制终止' : '确认终止' }}
          </SlButton>
        </template>
      </SlModal>
    </template>

    <!-- 下拉菜单：Teleport 到 body，不受表格 overflow 裁剪 -->
    <Teleport to="body">
      <Transition name="menu-fade">
        <div
          v-if="menu"
          class="menu-pop"
          :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
          @click.stop
        >
          <div class="menu-pop__head">{{ menu.proc.pid }} · {{ menu.proc.command }}</div>
          <button class="menu-pop__item" @click="askKill(menu.proc, false)">终止进程（SIGTERM）</button>
          <button class="menu-pop__item menu-pop__item--danger" @click="askKill(menu.proc, true)">
            强制终止（SIGKILL）
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.monitor-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page-hero__actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--deploy-fg-secondary);
  cursor: pointer;
  user-select: none;
}
.switch input {
  accent-color: var(--deploy-primary);
  width: 15px;
  height: 15px;
  cursor: pointer;
}

/* 守护状态条：双仪表 */
.daemon-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 14px 28px;
  align-items: center;
  background: #fff;
  border: 1px solid var(--deploy-border);
  border-radius: var(--deploy-radius-lg);
  box-shadow: var(--deploy-shadow);
  padding: 14px 20px;
}
.gauge {
  min-width: 230px;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.gauge__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.gauge__label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--deploy-fg-secondary);
}
.gauge__value {
  font-size: 17px;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}
.gauge__value.is-hot { color: #dc2626; }
.gauge__value.is-warm { color: #d97706; }
.gauge__bar {
  height: 7px;
  border-radius: 999px;
  background: var(--deploy-muted);
  overflow: hidden;
}
.gauge__fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #34d399, #10b981);
  transition: width 0.5s var(--deploy-ease, ease);
}
.gauge__fill--mem {
  background: linear-gradient(90deg, #60a5fa, #3b82f6);
}
.gauge__fill.is-warm {
  background: linear-gradient(90deg, #fbbf24, #f59e0b);
}
.gauge__fill.is-hot {
  background: linear-gradient(90deg, #f87171, #dc2626);
}
.gauge__meta {
  font-size: 11.5px;
  color: var(--deploy-muted-fg);
}
.daemon-sub {
  margin-left: 8px;
}
.daemon-item--wide {
  flex-basis: 100%;
  font-size: 12.5px;
  color: var(--deploy-fg-secondary);
}
.daemon-item--wide b {
  color: var(--deploy-fg);
}

.head-controls {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--deploy-muted-fg);
}
.mini-select,
.mini-input {
  padding: 6px 10px;
  border: 1px solid var(--deploy-border);
  border-radius: 8px;
  font-family: inherit;
  font-size: 12.5px;
  background: #fff;
  color: var(--deploy-fg);
}
.mini-input {
  width: 180px;
}
.mini-input:focus,
.mini-select:focus {
  outline: none;
  border-color: var(--deploy-primary);
  box-shadow: 0 0 0 3px var(--deploy-accent-soft);
}

/* 表格：自适应容器宽度（table-layout:fixed，无横向滚动）；内部滚动看全部行，表头吸顶 */
.table-wrap {
  padding: 4px 16px 12px;
  width: 100%;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  max-height: calc(100vh - 380px);
  min-height: 320px;
}
.log-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 13px;
}
.log-table th,
.log-table td {
  padding: 10px 10px;
  text-align: left;
  border-bottom: 1px solid var(--deploy-border);
  vertical-align: middle;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.log-table th:first-child,
.log-table td:first-child {
  padding-left: 14px;
}
.log-table th:last-child,
.log-table td:last-child {
  padding-right: 14px;
}
.log-table th {
  font-weight: 600;
  color: var(--deploy-fg-secondary);
  background: #fafbfc;
  font-size: 12px;
  letter-spacing: 0.02em;
  position: sticky;
  top: 0;
  z-index: 1;
  box-shadow: 0 1px 0 var(--deploy-border);
  overflow: visible;
}
.log-table th:first-child {
  border-top-left-radius: 8px;
}
.log-table th:last-child {
  border-top-right-radius: 8px;
}
.log-table tbody tr:last-child td {
  border-bottom: none;
}
.log-table tbody tr:hover td {
  background: #f8fafc;
}
/* 百分比列宽：自适应任意屏宽；「命令」列吃掉剩余全部空间 */
.col-pid { width: 6%; }
.col-user { width: 6%; }
.col-num {
  width: 7%;
  font-variant-numeric: tabular-nums;
}
.col-time { width: 7%; }
.col-act {
  width: 9%;
  white-space: nowrap;
  overflow: visible;
}
.col-act .act-btn {
  overflow: visible;
}
.mono {
  font-family: var(--deploy-mono);
  font-size: 12px;
}
.muted {
  color: var(--deploy-muted-fg);
  font-size: 12.5px;
}
.perm-note {
  margin: -4px 4px 0;
}
.cmd-cell code {
  font-family: var(--deploy-mono);
  font-size: 12px;
  color: var(--deploy-fg);
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmd-cell .prot-tag {
  position: relative;
  top: -1px;
}
.prot-tag {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 7px;
  border-radius: 5px;
  background: #f1f5f9;
  color: #64748b;
  font-size: 10.5px;
  font-weight: 700;
}
.cpu-chip {
  display: inline-block;
  min-width: 52px;
  text-align: center;
  padding: 2px 8px;
  border-radius: 6px;
  background: #f1f5f9;
  color: #334155;
  font-weight: 700;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.cpu-chip.is-warm {
  background: #fef3c7;
  color: #b45309;
}
.cpu-chip.is-hot {
  background: #fee2e2;
  color: #b91c1c;
}
.act-btn {
  border: 1px solid var(--deploy-border);
  background: #fff;
  color: var(--deploy-fg-secondary);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 7px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.act-btn + .act-btn {
  margin-left: 6px;
}
.act-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 行内「操作 ▾」触发按钮 */
.act-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--deploy-border);
  background: #fff;
  color: var(--deploy-fg-secondary);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.act-trigger:hover:not(:disabled) {
  border-color: var(--deploy-primary);
  color: var(--deploy-primary);
  background: var(--deploy-accent-soft);
}
.act-trigger:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 下拉菜单（Teleport 到 body，position: fixed 定位） */
.menu-pop {
  position: fixed;
  z-index: 1100;
  min-width: 190px;
  background: #fff;
  border: 1px solid var(--deploy-border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.16);
  padding: 5px;
  display: flex;
  flex-direction: column;
}
.menu-pop__head {
  font-size: 11px;
  font-weight: 650;
  font-family: var(--deploy-mono);
  color: var(--deploy-muted-fg);
  padding: 6px 10px 4px;
  border-bottom: 1px solid var(--deploy-border);
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.menu-pop__item {
  border: none;
  background: transparent;
  text-align: left;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 550;
  color: var(--deploy-fg);
  padding: 8px 10px;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
}
.menu-pop__item:hover {
  background: var(--deploy-muted);
}
.menu-pop__item--danger {
  color: #dc2626;
}
.menu-pop__item--danger:hover {
  background: #fef2f2;
}
.menu-fade-enter-active,
.menu-fade-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.menu-fade-enter-from,
.menu-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 确认弹窗内容 */
.confirm-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.confirm-line {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--deploy-fg);
}
.confirm-cmd {
  display: block;
  font-family: var(--deploy-mono);
  font-size: 12px;
  color: var(--deploy-fg-secondary);
  background: var(--deploy-muted);
  border-radius: 8px;
  padding: 8px 10px;
  word-break: break-all;
  white-space: normal;
  max-height: 88px;
  overflow-y: auto;
}
.confirm-warn {
  margin: 0;
  font-size: 12.5px;
  color: #b45309;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
  padding: 8px 10px;
}
.confirm-btn--danger {
  background: #dc2626 !important;
  border-color: #dc2626 !important;
}
.confirm-btn--danger:hover {
  background: #b91c1c !important;
}
.empty-inline {
  padding: 32px;
  text-align: center;
  color: var(--deploy-muted-fg);
  font-size: 13px;
}

/* —— 移动端：表格 → 卡片 —— */
.proc-cards {
  display: none;
}
.proc-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--deploy-border);
}
.proc-card:last-child {
  border-bottom: none;
}
.proc-card__top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.proc-card__rss {
  flex: 1;
  text-align: right;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
}
.proc-card__cmd {
  display: block;
  font-family: var(--deploy-mono);
  font-size: 12px;
  color: var(--deploy-fg);
  word-break: break-all;
  line-height: 1.5;
  background: var(--deploy-muted);
  border-radius: 7px;
  padding: 7px 9px;
}
.proc-card__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
}
.mobile-empty {
  display: none;
}
@media (max-width: 640px) {
  .table-wrap {
    display: none;
  }
  .proc-cards {
    display: flex;
    flex-direction: column;
    padding: 4px 10px 10px;
  }
  .mobile-empty {
    display: block;
  }
  .table-wrap + .proc-cards,
  .table-wrap + .proc-cards + .mobile-empty {
    /* table 隐藏后这些由 v-if 控制，无需额外处理 */
  }
  .mini-input {
    width: 128px;
  }
  .daemon-bar {
    gap: 12px;
    padding: 12px 14px;
  }
  .list-panel__head {
    flex-wrap: wrap;
    gap: 8px;
  }
}
</style>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import MonitorSelect from '@/components/MonitorSelect.vue';
import MonitorTabs from '@/components/MonitorTabs.vue';
import { monitorApi, type AggregatedApiEntry, type AccessLogEntry, type MonitorModule } from '@/services/api';


const loading = ref(true);
const error = ref('');
const modules = ref<MonitorModule[]>([]);
const moduleId = ref('');
const aggregate = ref(true);
const logs = ref<AccessLogEntry[]>([]);
const groups = ref<AggregatedApiEntry[]>([]);
const total = ref(0);
const page = ref(0);
const pageSize = 100;

// —— 筛选 ——
const apiFilter = ref('');
const methodFilter = ref('');
const statusFilter = ref('');
const hostFilter = ref('');
const keyword = ref('');
const timeRange = ref<'15m' | '1h' | '6h' | '24h' | '7d' | 'all'>('1h');
const facets = ref<{ apis: string[]; methods: string[]; hosts: string[] }>({ apis: [], methods: [], hosts: [] });

// 自动刷新
const autoRefresh = ref(true);
let timer: ReturnType<typeof setInterval> | null = null;

const statusClassOf = (s: number) =>
  s >= 500 ? '5xx' : s >= 400 ? '4xx' : s >= 300 ? '3xx' : s >= 200 ? '2xx' : '1xx';

function timeCutoff(): string {
  const now = Date.now();
  const map: Record<string, number> = {
    '15m': 15 * 60_000,
    '1h': 60 * 60_000,
    '6h': 6 * 3_600_000,
    '24h': 24 * 3_600_000,
    '7d': 7 * 86_400_000,
    all: 0,
  };
  const ms = map[timeRange.value];
  if (!ms) return '';
  return new Date(now - ms).toISOString();
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const params = {
      moduleId: moduleId.value || undefined,
      api: apiFilter.value || undefined,
      method: methodFilter.value || undefined,
      statusClass: statusFilter.value || undefined,
      host: hostFilter.value || undefined,
      q: keyword.value || undefined,
      from: timeCutoff() || undefined,
      limit: pageSize,
      offset: page.value * pageSize,
      aggregate: aggregate.value,
    };
    const res = await monitorApi.listLogs(params);
    total.value = res.total;
    if (aggregate.value) {
      groups.value = res.groups ?? [];
      logs.value = [];
    } else {
      logs.value = res.logs ?? [];
      groups.value = [];
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function loadFacets() {
  try {
    facets.value = await monitorApi.listFacets({ moduleId: moduleId.value || undefined });
  } catch {
    facets.value = { apis: [], methods: [], hosts: [] };
  }
}

const facetMethods = computed(() => facets.value.methods);

const moduleOptions = computed(() => [
  { value: '', label: '全部模块' },
  ...modules.value.map((m) => ({
    value: m.id,
    label: m.name,
    hint: m.projectName || undefined,
  })),
]);
const methodOptions = computed(() => [
  { value: '', label: '全部' },
  ...facetMethods.value.map((m) => ({ value: m, label: m })),
]);
const hostOptions = computed(() => [
  { value: '', label: '全部子域名' },
  ...facets.value.hosts.map((h) => ({ value: h, label: h })),
]);
const statusOptions = [
  { value: '', label: '全部' },
  { value: '1xx', label: '升级/1xx（WebSocket）' },
  { value: '2xx', label: '成功（2xx）' },
  { value: '3xx', label: '重定向（3xx）' },
  { value: '4xx', label: '客户端错误（4xx）' },
  { value: '5xx', label: '服务器错误（5xx）' },
];
const timeRangeOptions = [
  { value: '15m', label: '近 15 分钟' },
  { value: '1h', label: '近 1 小时' },
  { value: '6h', label: '近 6 小时' },
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 天' },
  { value: 'all', label: '全部' },
];

function resetAndLoad() {
  page.value = 0;
  void load();
  void loadFacets();
}

watch([moduleId, aggregate, apiFilter, methodFilter, statusFilter, hostFilter, timeRange], resetAndLoad);
watch(keyword, (v, ov) => {
  // 关键词防抖 400ms
  if (debounce) clearTimeout(debounce);
  if (v === ov) return;
  debounce = setTimeout(resetAndLoad, 400);
});
let debounce: ReturnType<typeof setTimeout> | null = null;

function fmtTime(iso: string) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function fmtBytes(n: number) {
  if (!n) return '0';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

const statusChip = (s: number) => `st st--${statusClassOf(s)}`;

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
void totalPages;

onMounted(async () => {
  try {
    const res = await monitorApi.listModules();
    modules.value = res.modules;
  } catch {
    modules.value = [];
  }
  await load();
  await loadFacets();
  timer = setInterval(() => {
    if (autoRefresh.value && !loading.value) void load();
  }, 10_000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="monitor-page">
    <header class="page-hero">
      <div>
        <p class="page-hero__eyebrow">监控中心</p>
        <h1 class="page-hero__title">访问日志</h1>
        <p class="page-hero__desc">网关 nginx 实时访问日志 · 支持按模块 / API / 方法 / 状态码 / 时间筛选与聚合。</p>
      </div>
      <div class="page-hero__actions">
        <label class="switch">
          <input v-model="autoRefresh" type="checkbox" />
          <span>10s 自动刷新</span>
        </label>
      </div>
    </header>

    <MonitorTabs />

    <SlAlert v-if="error" variant="error" class="mb">{{ error }}</SlAlert>

    <div class="filter-bar">
      <div class="filter-bar__row">
        <label class="filter-field filter-field--grow">
          <span>模块</span>
          <MonitorSelect
            v-model="moduleId"
            :options="moduleOptions"
            placeholder="全部模块"
            searchable
          />
        </label>
        <label class="filter-field">
          <span>API</span>
          <input v-model="apiFilter" list="api-suggestions" class="filter-input" placeholder="全部（可输入）" />
          <datalist id="api-suggestions">
            <option v-for="a in facets.apis" :key="a" :value="a" />
          </datalist>
        </label>
        <label class="filter-field filter-field--sm">
          <span>方法</span>
          <MonitorSelect v-model="methodFilter" :options="methodOptions" />
        </label>
        <label class="filter-field filter-field--sm">
          <span>状态码</span>
          <MonitorSelect v-model="statusFilter" :options="statusOptions" />
        </label>
        <label class="filter-field">
          <span>子域名</span>
          <MonitorSelect
            v-model="hostFilter"
            :options="hostOptions"
            placeholder="全部子域名"
            searchable
          />
        </label>
        <label class="filter-field">
          <span>时间范围</span>
          <MonitorSelect v-model="timeRange" :options="timeRangeOptions" />
        </label>
      </div>
      <div class="filter-bar__row filter-bar__row--aux">
        <label class="filter-field filter-field--grow">
          <span>路径关键词</span>
          <input v-model="keyword" class="filter-input" placeholder="模糊搜索路径，如 /login" />
        </label>
        <label class="switch switch--inline">
          <input v-model="aggregate" type="checkbox" />
          <span>聚合相同 API</span>
        </label>
        <SlButton size="sm" variant="secondary" :disabled="loading" @click="resetAndLoad">查询</SlButton>
      </div>
    </div>

    <div class="list-panel" :class="{ 'list-panel--loading': loading }">
      <div v-if="loading" class="list-panel__overlay">
        <SlSpinner size="lg" />
        <span class="overlay-text">正在加载…</span>
      </div>
      <div class="list-panel__head">
          <span class="muted">{{ total }} 条记录{{ aggregate ? '（聚合）' : '' }}</span>
          <span v-if="totalPages > 1" class="muted">
            第 {{ page + 1 }} / {{ totalPages }} 页
            <button class="pager" :disabled="page === 0" @click="page--; void load()">←</button>
            <button class="pager" :disabled="page + 1 >= totalPages" @click="page++; void load()">→</button>
          </span>
        </div>

        <div v-if="aggregate" class="table-wrap">
          <table v-if="groups.length" class="log-table">
            <thead>
              <tr>
                <th>API</th>
                <th class="col-host">子域名</th>
                <th class="col-method">方法</th>
                <th class="col-num">调用次数</th>
                <th class="col-num">服务器错误</th>
                <th class="col-num">平均耗时</th>
                <th class="col-status">最近状态</th>
                <th class="col-time">最近访问</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in groups" :key="`${g.host} ${g.method} ${g.api}`">
                <td>
                  <router-link
                    class="api-link"
                    :to="{ name: 'monitor-overview', query: { api: g.api, module: g.moduleId || undefined, host: g.host || undefined } }"
                    :title="`在总览图表中查看 ${g.api} 的折线图`"
                  >
                    <code class="api-name">{{ g.api }}</code>
                    <span class="api-link__cta">折线图</span>
                  </router-link>
                </td>
                <td class="col-host"><code class="api-name muted">{{ g.host || '—' }}</code></td>
                <td class="col-method"><span class="method-tag">{{ g.method || '—' }}</span></td>
                <td class="col-num"><strong>{{ g.count }}</strong></td>
                <td class="col-num">
                  <span :class="g.errCount ? 'err-text' : 'muted'">{{ g.errCount || 0 }}</span>
                </td>
                <td class="col-num">{{ g.avgTimeMs }} ms</td>
                <td class="col-status"><span :class="statusChip(g.lastStatus)">{{ g.lastStatus || '—' }}</span></td>
                <td class="col-time muted">{{ fmtTime(g.lastTs) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty-inline">暂无匹配的访问记录</div>
        </div>
        <div v-if="aggregate && groups.length" class="log-cards">
          <div v-for="g in groups" :key="`m-${g.host}-${g.method}-${g.api}`" class="log-card">
            <div class="log-card__top">
              <span class="method-tag">{{ g.method || '—' }}</span>
              <span class="log-card__stat muted mono-sm">{{ g.host || '—' }}</span>
              <router-link
                class="api-link"
                :to="{ name: 'monitor-overview', query: { api: g.api, module: g.moduleId || undefined } }"
              >
                <code class="log-card__api">{{ g.api }}</code>
                <span class="api-link__cta">折线图</span>
              </router-link>
            </div>
            <div class="log-card__stats">
              <span class="log-card__stat"><b>{{ g.count }}</b>次</span>
              <span class="log-card__stat" :class="{ 'is-bad': g.errCount }">错 <b>{{ g.errCount || 0 }}</b></span>
              <span class="log-card__stat">{{ g.avgTimeMs }} ms</span>
              <span :class="statusChip(g.lastStatus)">{{ g.lastStatus || '—' }}</span>
            </div>
            <div class="log-card__meta muted">{{ fmtTime(g.lastTs) }}</div>
          </div>
        </div>

        <div v-else class="table-wrap">
          <table v-if="logs.length" class="log-table">
            <thead>
              <tr>
                <th class="col-time">时间</th>
                <th class="col-method">方法</th>
                <th>API / 路径</th>
                <th class="col-status">状态码</th>
                <th class="col-num">耗时</th>
                <th class="col-num">流量</th>
                <th class="col-num">来源 IP</th>
                <th class="col-time">子域名</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in logs" :key="l.id">
                <td class="col-time muted">{{ fmtTime(l.ts) }}</td>
                <td class="col-method"><span class="method-tag">{{ l.method || '—' }}</span></td>
                <td><code class="api-name">{{ l.api }}</code></td>
                <td class="col-status"><span :class="statusChip(l.status)">{{ l.status }}</span></td>
                <td class="col-num">{{ l.requestTimeMs }} ms</td>
                <td class="col-num muted">{{ fmtBytes(l.bytes) }}</td>
                <td class="col-num muted">{{ l.remoteAddr || '—' }}</td>
                <td class="col-time muted">{{ l.host || '—' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty-inline">暂无匹配的访问记录</div>
        </div>
        <div v-if="!aggregate && logs.length" class="log-cards">
          <div v-for="l in logs" :key="`m-${l.id}`" class="log-card">
            <div class="log-card__top">
              <span class="method-tag">{{ l.method || '—' }}</span>
              <span :class="statusChip(l.status)">{{ l.status }}</span>
              <span class="log-card__stat log-card__stat--time muted">{{ fmtTime(l.ts) }}</span>
            </div>
            <code class="log-card__api">{{ l.api }}</code>
            <div class="log-card__stats">
              <span class="log-card__stat">{{ l.requestTimeMs }} ms</span>
              <span class="log-card__stat muted">{{ fmtBytes(l.bytes) }}</span>
              <span class="log-card__stat muted mono-sm">{{ l.remoteAddr || '—' }}</span>
              <span class="log-card__stat muted mono-sm">{{ l.host || '—' }}</span>
            </div>
          </div>
        </div>
      </div>
  </div>
</template>

<style scoped>
.monitor-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.filter-bar {
  background: #fff;
  border: 1px solid var(--deploy-border);
  border-radius: var(--deploy-radius-lg);
  box-shadow: var(--deploy-shadow);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.filter-bar__row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.filter-bar__row--aux {
  align-items: flex-end;
}
.filter-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 130px;
}
.filter-field--grow {
  flex: 1;
  min-width: 180px;
}
.filter-field--sm {
  min-width: 96px;
}
.filter-field > span {
  font-size: 11px;
  font-weight: 600;
  color: var(--deploy-muted-fg);
  letter-spacing: 0.03em;
}
.filter-input {
  padding: 7px 10px;
  border: 1px solid var(--deploy-border);
  border-radius: 8px;
  font-family: inherit;
  font-size: 13px;
  background: #fff;
  color: var(--deploy-fg);
}
.filter-input:focus {
  outline: none;
  border-color: var(--deploy-primary);
  box-shadow: 0 0 0 3px var(--deploy-accent-soft);
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
.switch--inline {
  padding-bottom: 7px;
}
.switch input {
  accent-color: var(--deploy-primary);
  width: 15px;
  height: 15px;
  cursor: pointer;
}
.list-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--deploy-border);
  font-size: 12.5px;
}
/* 表格：自适应容器宽度（table-layout:fixed），长路径自动截断省略 */
.table-wrap {
  width: 100%;
  overflow-y: auto;
  max-height: calc(100vh - 320px);
  padding: 4px 16px 12px;
  -webkit-overflow-scrolling: touch;
}
/* 自有表格样式：不依赖全局/其他页面的 scoped 类 */
.log-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 13px;
}
.log-table th,
.log-table td {
  padding: 11px 12px;
  text-align: left;
  border-bottom: 1px solid var(--deploy-border);
  vertical-align: middle;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.log-table th {
  font-weight: 600;
  color: var(--deploy-fg-secondary);
  background: #fafbfc;
  font-size: 12px;
  letter-spacing: 0.02em;
  position: sticky;
  top: 0;
}
.log-table tbody tr:last-child td {
  border-bottom: none;
}
.log-table tbody tr {
  transition: background 0.12s ease;
}
.log-table tbody tr:hover td {
  background: #f8fafc;
}
.api-name {
  font-family: var(--deploy-mono);
  font-size: 12px;
  color: var(--deploy-fg);
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 接口名 → 总览折线图的下钻入口 */
.api-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  text-decoration: none;
  border-radius: 6px;
  padding: 2px 4px;
  margin: -2px -4px;
  transition: background 0.15s ease;
}
.api-link:hover {
  background: var(--deploy-accent-soft, #eef4ff);
}
.api-link__cta {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--deploy-border);
  background: #fff;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--deploy-primary);
  opacity: 0;
  transition: opacity 0.15s ease;
}
.api-link:hover .api-link__cta,
.api-link:focus-visible .api-link__cta {
  opacity: 1;
}
.col-host {
  width: 16%;
}
.col-method {
  width: 7%;
}
.col-num {
  width: 8%;
  font-variant-numeric: tabular-nums;
}
.col-status {
  width: 8%;
}
.col-time {
  width: 12%;
}
.pager {
  border: 1px solid var(--deploy-border);
  background: #fff;
  border-radius: 6px;
  padding: 2px 8px;
  margin-left: 4px;
  cursor: pointer;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
}
.pager:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.method-tag {
  display: inline-block;
  font-family: var(--deploy-mono);
  font-size: 11px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 6px;
  background: #eef2f7;
  color: #334155;
  letter-spacing: 0.04em;
}
.st {
  display: inline-block;
  font-family: var(--deploy-mono);
  font-size: 11.5px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 6px;
}
.st--2xx { background: #dcfce7; color: #15803d; }
.st--3xx { background: #dbeafe; color: #1d4ed8; }
.st--4xx { background: #fef3c7; color: #b45309; }
.st--5xx { background: #fee2e2; color: #b91c1c; }
.st--0 { background: #f1f5f9; color: #64748b; }
.err-text {
  color: #b91c1c;
  font-weight: 700;
}
.nowrap {
  white-space: nowrap;
}

/* —— 移动端：表格 → 卡片 —— */
.log-cards {
  display: none;
}
.log-card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--deploy-border);
}
.log-card:last-child {
  border-bottom: none;
}
.log-card__top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.log-card__api {
  flex: 1;
  min-width: 0;
  font-family: var(--deploy-mono);
  font-size: 12px;
  color: var(--deploy-fg);
  word-break: break-all;
  line-height: 1.5;
  background: var(--deploy-muted);
  border-radius: 7px;
  padding: 7px 9px;
}
.log-card__stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
}
.log-card__stat b {
  color: var(--deploy-fg);
}
.log-card__stat.is-bad b {
  color: #b91c1c;
}
.log-card__stat--time {
  margin-left: auto;
}
.mono-sm {
  font-family: var(--deploy-mono);
  font-size: 11px;
}
@media (max-width: 640px) {
  .table-wrap {
    display: none;
  }
  .log-cards {
    display: flex;
    flex-direction: column;
    padding: 4px 10px 10px;
  }
  .filter-bar {
    flex-wrap: wrap;
  }
  .monitor-select {
    flex: 1 1 130px;
    min-width: 0;
  }
}

/* 列表加载遮罩：切换筛选/时间范围时保留旧数据并叠加加载动画，避免整块闪烁 */
.list-panel {
  position: relative;
}
.list-panel--loading .list-panel__head {
  opacity: 0.5;
}
.list-panel__overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(1px);
  border-radius: var(--deploy-radius-lg);
}
.list-panel__overlay .overlay-text {
  font-size: 12.5px;
  color: var(--deploy-fg-secondary);
}
</style>

<script setup lang="ts">
/**
 * 监控总览：全站流量趋势 + Top API 时序 + 接口详情 + 机器运行状态。
 *
 * 时间范围两种模式：
 * - 预设窗口（15min / 1h / 6h / 24h）：自动刷新；
 * - 自定义 from/to（跨度上限 24h）：不自动刷新（避免长时间空转），提供手动刷新。
 *
 * 后端按跨度自动分桶（目标 ≤180 点）并回传完整时间轴，前端只负责等距铺 x 轴，
 * 因此自定义长区间也不会出现「空白时段被压缩、横轴对不上」的问题。
 *
 * 注意：ingest 的 minute/ts 都是 UTC，展示前必须转本地时区（见 fmt* 系列）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MonitorSelect from '@/components/MonitorSelect.vue';
import MonitorTabs from '@/components/MonitorTabs.vue';
import { useAuthStore } from '@/stores/auth';
import {
  monitorApi,
  type ApiDetail,
  type MachineStatus,
  type MonitorModule,
  type MonitorRange,
  type OverviewKpi,
  type OverviewSeries,
  type TopApiEntry,
} from '@/services/api';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

type PresetKey = '15' | '60' | '360' | '1440' | 'custom';
const PRESETS: Array<{ value: PresetKey; label: string }> = [
  { value: '15', label: '近 15 分钟' },
  { value: '60', label: '近 1 小时' },
  { value: '360', label: '近 6 小时' },
  { value: '1440', label: '近 24 小时' },
  { value: 'custom', label: '自定义区间…' },
];
/** 与后端 MAX_RANGE_MINUTES 保持一致 */
const MAX_SPAN_MINUTES = 1440;
const REFRESH_MS = 15_000;

const loading = ref(true);
const refreshing = ref(false);
const error = ref('');

const modules = ref<MonitorModule[]>([]);
const moduleId = ref('');
/** 目标子域名（Host）：为空表示全站；与访问日志页的筛选项同口径 */
const hostFilter = ref('');
const hosts = ref<string[]>([]);

const preset = ref<PresetKey>('60');
const customFrom = ref('');
const customTo = ref('');
/** 已「应用」的自定义区间（UTC ISO）；未应用时不参与查询 */
const appliedCustom = ref<{ from: string; to: string } | null>(null);

const kpi = ref<OverviewKpi | null>(null);
const seriesData = ref<OverviewSeries['series']>([]);
const globalLinesRaw = ref<OverviewSeries['global']>([]);
const topApisRaw = ref<OverviewSeries['topApis']>([]);
const serverRange = ref<MonitorRange | null>(null);
const serverTimeline = ref<string[]>([]);
const apiTotal = ref(0);

const apiList = ref<TopApiEntry[]>([]);

const machine = ref<MachineStatus | null>(null);

const selectedApi = ref('');
const detail = ref<ApiDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref('');
const detailEl = ref<HTMLElement | null>(null);

const globalSvg = ref<SVGSVGElement | null>(null);
const detailSvg = ref<SVGSVGElement | null>(null);
const hoverGlobal = ref<number | null>(null);
const hoverDetail = ref<number | null>(null);

let timer: ReturnType<typeof setInterval> | null = null;
let machineTimer: ReturnType<typeof setInterval> | null = null;

/* ────────────────────────────── 时区与格式化 ────────────────────────────── */

const pad2 = (n: number) => String(n).padStart(2, '0');

/** ingest 的 minute 是「无时区的 UTC 分钟串」，补 Z 再转本地，否则图表会整体偏 8 小时 */
function minuteToDate(minute: string): Date {
  return new Date(`${minute}:00Z`);
}
function fmtClock(minute: string): string {
  const d = minuteToDate(minute);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtDayClock(minute: string): string {
  const d = minuteToDate(minute);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtFull(minute: string): string {
  const d = minuteToDate(minute);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** 完整 ISO（含 Z）→ 本地完整时间，用于明细类展示 */
function fmtIsoLocal(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
/** Date → datetime-local 输入值（本地时区） */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
function fmtMs(n: number) {
  if (!n) return '0 ms';
  if (n >= 1000) return `${(n / 1000).toFixed(2)} s`;
  return `${Math.round(n * 10) / 10} ms`;
}
function fmtMb(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
function fmtUptime(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} 天 ${h} 时` : h ? `${h} 时 ${m} 分` : `${m} 分`;
}
function pct(a: number, b: number) {
  return b ? Math.round((a / b) * 100) : 0;
}

const STATUS_COLORS: Record<string, string> = {
  // 1xx 实际几乎全是 WebSocket 101 升级：紫色单独区分，避免混进「成功」里看不清
  '1xx': '#8b5cf6',
  '2xx': '#10b981',
  '3xx': '#3b82f6',
  '4xx': '#f59e0b',
  '5xx': '#ef4444',
};
const STATUS_LABELS: Record<string, string> = {
  '1xx': '升级/1xx',
  '2xx': '成功',
  '3xx': '重定向',
  '4xx': '客户端错误',
  '5xx': '服务器错误',
};
/**
 * 平均耗时叠加线（右轴）的颜色。
 * 必须与所有状态类颜色都不同 —— 尤其不能和 1xx 的紫色撞车，否则两条线看着是同一条。
 */
const LATENCY_COLOR = '#0891b2';

const STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx'] as const;

/** 从分桶里取某个状态类的计数（替代满屏三元表达式） */
function statusCount(b: Record<string, unknown>, cls: string): number {
  const v = b[`s${cls}`];
  return typeof v === 'number' ? v : 0;
}

/* ────────────────────────────── 时间范围 ────────────────────────────── */

/** 查询参数：自定义区间优先，否则用预设窗口 */
function rangeParams(): { minutes?: number; from?: string; to?: string } {
  if (preset.value === 'custom' && appliedCustom.value) {
    return { from: appliedCustom.value.from, to: appliedCustom.value.to };
  }
  const m = Number(preset.value);
  return { minutes: Number.isFinite(m) && m > 0 ? m : 60 };
}

const presetModel = computed({
  get: () => preset.value,
  set: (v: string) => onPresetChange(v),
});

function onPresetChange(v: string) {
  if (v === 'custom') {
    // 以当前已加载区间为初值，避免输入框空着让人无从下手
    const r = serverRange.value;
    if (r) {
      customFrom.value = toLocalInput(minuteToDate(r.from));
      customTo.value = toLocalInput(minuteToDate(r.to));
    } else {
      const now = new Date();
      customTo.value = toLocalInput(now);
      customFrom.value = toLocalInput(new Date(now.getTime() - 60 * 60_000));
    }
    appliedCustom.value = null;
    preset.value = 'custom';
    return;
  }
  appliedCustom.value = null;
  preset.value = v as PresetKey;
}

const customParsed = computed(() => {
  const f = customFrom.value ? new Date(customFrom.value) : null;
  const t = customTo.value ? new Date(customTo.value) : null;
  if (!f || !t || !Number.isFinite(f.getTime()) || !Number.isFinite(t.getTime())) {
    return { ok: false, msg: '请选择完整的开始与结束时间', span: 0 };
  }
  const span = (t.getTime() - f.getTime()) / 60_000;
  if (span <= 0) return { ok: false, msg: '结束时间需晚于开始时间', span: 0 };
  if (span > MAX_SPAN_MINUTES) {
    return { ok: false, msg: `跨度最多 24 小时（当前 ${(span / 60).toFixed(1)} 小时）`, span };
  }
  return { ok: true, msg: '', span };
});

const customSpanLabel = computed(() => {
  const s = customParsed.value.span;
  if (!s) return '';
  return s < 60 ? `${Math.round(s)} 分钟` : `${(s / 60).toFixed(1)} 小时`;
});

function applyCustom() {
  const p = customParsed.value;
  if (!p.ok) return;
  const f = new Date(customFrom.value);
  const t = new Date(customTo.value);
  appliedCustom.value = { from: f.toISOString(), to: t.toISOString() };
}

function backToPreset() {
  appliedCustom.value = null;
  preset.value = '60';
}

const QUICK_PICKS: Array<{ key: 'today' | '3h' | '12h'; label: string }> = [
  { key: 'today', label: '今天 0 点至今' },
  { key: '3h', label: '最近 3 小时' },
  { key: '12h', label: '最近 12 小时' },
];

function applyQuick(key: 'today' | '3h' | '12h') {
  const now = new Date();
  let from: Date;
  if (key === 'today') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else {
    from = new Date(now.getTime() - (key === '3h' ? 3 : 12) * 60 * 60_000);
  }
  // 「今天 0 点至今」在临近午夜时会超过 24h，这里收紧到上限，避免直接报错
  if (now.getTime() - from.getTime() > MAX_SPAN_MINUTES * 60_000) {
    from = new Date(now.getTime() - MAX_SPAN_MINUTES * 60_000);
  }
  customFrom.value = toLocalInput(from);
  customTo.value = toLocalInput(now);
  applyCustom();
}

const rangeLabel = computed(() => {
  const r = serverRange.value;
  if (!r) return '—';
  return `${fmtFull(r.from)} ~ ${fmtClock(r.to)}`;
});
const spanLabel = computed(() => {
  const m = serverRange.value?.spanMinutes;
  if (!m) return '';
  if (m < 60) return `${Math.round(m)} 分钟`;
  const h = m / 60;
  return Number.isInteger(h) ? `${h} 小时` : `${h.toFixed(1)} 小时`;
});
const bucketLabel = computed(() => {
  const b = serverRange.value?.bucketMinutes ?? 1;
  if (b < 60) return `${b} 分钟`;
  return `${b / 60} 小时`;
});
/** 小图上的「最近」读数单位：桶粒度 >1 分钟时必须换单位，否则会被误读成每分钟 */
const reqUnit = computed(() => {
  const b = serverRange.value?.bucketMinutes ?? 1;
  return b === 1 ? 'req/min' : `req/${b}min`;
});
const isCustomRange = computed(() => preset.value === 'custom' && !!appliedCustom.value);

/* ────────────────────────────── 数据加载 ────────────────────────────── */

async function load(silent = false) {
  if (!silent) refreshing.value = true;
  error.value = '';
  try {
    const res = await monitorApi.overview({
      moduleId: moduleId.value || undefined,
      host: hostFilter.value || undefined,
      ...rangeParams(),
    });
    kpi.value = res.kpi;
    seriesData.value = Array.isArray(res.series) ? res.series : [];
    globalLinesRaw.value = Array.isArray(res.global) ? res.global : [];
    topApisRaw.value = Array.isArray(res.topApis) ? res.topApis : [];
    serverRange.value = res.range ?? null;
    serverTimeline.value = Array.isArray(res.timeline) ? res.timeline : [];
    apiTotal.value = res.apiTotal ?? 0;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    if (!silent) refreshing.value = false;
  }
}

async function loadApiList() {
  try {
    const res = await monitorApi.listApis({
      moduleId: moduleId.value || undefined,
      host: hostFilter.value || undefined,
      ...rangeParams(),
    });
    apiList.value = Array.isArray(res.apis) ? res.apis : [];
  } catch {
    apiList.value = [];
  }
}

async function loadHostFacets() {
  try {
    const res = await monitorApi.listFacets({ moduleId: moduleId.value || undefined });
    hosts.value = Array.isArray(res.hosts) ? res.hosts : [];
  } catch {
    hosts.value = [];
  }
}

async function loadDetail(silent = false) {
  if (!selectedApi.value) {
    detail.value = null;
    return;
  }
  if (!silent) detailLoading.value = true;
  detailError.value = '';
  try {
    detail.value = await monitorApi.apiDetail({
      api: selectedApi.value,
      moduleId: moduleId.value || undefined,
      host: hostFilter.value || undefined,
      ...rangeParams(),
    });
  } catch (e) {
    detailError.value = e instanceof Error ? e.message : '加载失败';
    detail.value = null;
  } finally {
    if (!silent) detailLoading.value = false;
  }
}

async function loadMachine() {
  try {
    machine.value = await monitorApi.machine(30);
  } catch {
    /* 机器指标失败不打断页面 */
  }
}

/** 手动刷新：连同详情一起拉 */
async function refreshAll() {
  await load();
  await Promise.all([loadApiList(), loadDetail(true)]);
}

/* ────────────────────────────── 交互 ────────────────────────────── */

function syncQuery() {
  const q: Record<string, string> = {};
  if (moduleId.value) q.module = moduleId.value;
  if (hostFilter.value) q.host = hostFilter.value;
  if (selectedApi.value) q.api = selectedApi.value;
  if (isCustomRange.value && appliedCustom.value) {
    q.from = appliedCustom.value.from;
    q.to = appliedCustom.value.to;
  } else {
    q.minutes = preset.value === 'custom' ? '60' : preset.value;
  }
  // replace：保持可分享 / 可刷新，但不污染浏览器历史
  void router.replace({ name: 'monitor-overview', query: q });
}

async function openDetail(api: string) {
  if (selectedApi.value === api) {
    selectedApi.value = '';
    detail.value = null;
    syncQuery();
    return;
  }
  selectedApi.value = api;
  syncQuery();
  await loadDetail();
  await nextTick();
  detailEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeDetail() {
  selectedApi.value = '';
  detail.value = null;
  syncQuery();
}

function initFromQuery() {
  const q = route.query;
  if (typeof q.module === 'string' && q.module) moduleId.value = q.module;
  if (typeof q.host === 'string' && q.host) hostFilter.value = q.host;
  if (typeof q.from === 'string' && typeof q.to === 'string' && q.from && q.to) {
    preset.value = 'custom';
    appliedCustom.value = { from: q.from, to: q.to };
    const f = new Date(q.from);
    const t = new Date(q.to);
    if (Number.isFinite(f.getTime()) && Number.isFinite(t.getTime())) {
      customFrom.value = toLocalInput(f);
      customTo.value = toLocalInput(t);
    }
  } else if (typeof q.minutes === 'string' && ['15', '60', '360', '1440'].includes(q.minutes)) {
    preset.value = q.minutes as PresetKey;
  }
  if (typeof q.api === 'string' && q.api) selectedApi.value = q.api;
}

watch(
  [moduleId, hostFilter, preset, () => appliedCustom.value?.from, () => appliedCustom.value?.to],
  () => {
    // 首次挂载期间由 onMounted 统一加载；这里跳过，否则 initFromQuery 赋值会触发一次重复请求
    if (loading.value) return;
    syncQuery();
    void loadHostFacets();
    void load().then(() => Promise.all([loadApiList(), loadDetail(true)]));
  }
);

onMounted(async () => {
  initFromQuery();
  try {
    const res = await monitorApi.listModules();
    modules.value = res.modules;
  } catch {
    modules.value = [];
  }
  // 非管理员的 /overview 必须带 moduleId（否则后端 403）。自动选中第一个可读模块，
  // 避免普通开发者一进页面就看到「请选择你的模块查看总览」的报错。
  if (!moduleId.value && modules.value.length && !auth.user?.isPlatformAdmin) {
    moduleId.value = modules.value[0].id;
  }
  await loadHostFacets();
  await load();
  await Promise.all([loadApiList(), loadMachine()]);
  if (selectedApi.value) await loadDetail();
  loading.value = false;
  timer = setInterval(() => {
    // 标签页隐藏时不打后端；自定义区间不自动刷新（窗口固定，刷新只是空转）
    if (document.hidden || isCustomRange.value) return;
    void load(true);
    if (selectedApi.value) void loadDetail(true);
  }, REFRESH_MS);
  machineTimer = setInterval(() => {
    if (!document.hidden) void loadMachine();
  }, 10_000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
  if (machineTimer) clearInterval(machineTimer);
});

/* ────────────────────────────── 时序整形 ────────────────────────────── */

/** x 轴：优先用后端给的完整时间轴（保证区间两端不缺格） */
const timeline = computed(() => {
  if (serverTimeline.value.length) return serverTimeline.value;
  const set = new Set<string>();
  for (const s of seriesData.value) for (const p of s.points) set.add(p.minute);
  return [...set].sort();
});

const timelinePos = computed(() => {
  const m = new Map<string, number>();
  timeline.value.forEach((t, i) => m.set(t, i));
  return m;
});

/** api → statusClass → { bucket → count }（一次成型，避免逐点线性查找） */
const seriesByApi = computed(() => {
  const out = new Map<string, Map<string, Map<string, number>>>();
  for (const s of seriesData.value) {
    let byStatus = out.get(s.api);
    if (!byStatus) {
      byStatus = new Map();
      out.set(s.api, byStatus);
    }
    let pts = byStatus.get(s.statusClass);
    if (!pts) {
      pts = new Map();
      byStatus.set(s.statusClass, pts);
    }
    for (const p of s.points) pts.set(p.minute, (pts.get(p.minute) || 0) + p.count);
  }
  return out;
});

const emptyValues = (n: number) => new Array<number>(n).fill(0);

/** 全站：优先用后端算好的 global（已对齐时间轴），无则用 series 兜底 */
const globalLines = computed(() => {
  const n = timeline.value.length;
  const raw = globalLinesRaw.value ?? [];
  if (raw.length) {
    return STATUS_CLASSES.filter((cls) => raw.some((l) => l.statusClass === cls)).map((cls) => {
      const hit = raw.find((l) => l.statusClass === cls);
      const values = hit && hit.values.length === n ? hit.values : emptyValues(n);
      return { statusClass: cls, total: hit?.total ?? 0, values };
    });
  }
  const acc = new Map<string, number[]>();
  const pos = timelinePos.value;
  for (const s of seriesData.value) {
    let arr = acc.get(s.statusClass);
    if (!arr) {
      arr = emptyValues(n);
      acc.set(s.statusClass, arr);
    }
    for (const p of s.points) {
      const i = pos.get(p.minute);
      if (i !== undefined) arr[i] += p.count;
    }
  }
  return [...acc.entries()]
    .map(([statusClass, values]) => ({ statusClass, total: values.reduce((a, b) => a + b, 0), values }))
    .sort((a, b) => a.statusClass.localeCompare(b.statusClass));
});

const globalMax = computed(() => {
  let m = 10;
  for (const line of globalLines.value) for (const v of line.values) if (v > m) m = v;
  return m;
});

const TOP_N = 8;
const topApis = computed(() => {
  if (topApisRaw.value?.length) return topApisRaw.value.slice(0, TOP_N);
  // 兜底：后端未给榜单时按 series 汇总
  const totals = new Map<string, number>();
  for (const s of seriesData.value) {
    totals.set(s.api, (totals.get(s.api) || 0) + s.points.reduce((a, p) => a + p.count, 0));
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([api, total]) => ({ api, total, errTotal: 0 }));
});

const apiCards = computed(() => {
  const n = timeline.value.length;
  const pos = timelinePos.value;
  return topApis.value.map(({ api, total }) => {
    const byStatus = seriesByApi.value.get(api) ?? new Map<string, Map<string, number>>();
    let peak = 10;
    const lines = STATUS_CLASSES.map((statusClass) => {
      const values = emptyValues(n);
      const pts = byStatus.get(statusClass);
      if (pts) {
        for (const [minute, c] of pts) {
          const i = pos.get(minute);
          if (i !== undefined) values[i] = c;
        }
      }
      for (const v of values) if (v > peak) peak = v;
      return { statusClass, values };
    });
    const totals = emptyValues(n);
    for (const l of lines) for (let i = 0; i < n; i += 1) totals[i] += l.values[i];
    const last = totals[n - 1] ?? 0;
    const prev = totals[n - 2] ?? 0;
    const errTotal = lines
      .filter((l) => l.statusClass === '4xx' || l.statusClass === '5xx')
      .reduce((a, l) => a + l.values.reduce((x, y) => x + y, 0), 0);
    return { api, total, peak, last, prev, trendUp: last >= prev, errTotal, lines };
  });
});

const topApisHint = computed(() => {
  if (!apiTotal.value) return '';
  if (apiTotal.value <= TOP_N) return `区间内共 ${apiTotal.value} 个接口`;
  return `点击任意卡片查看单接口折线图 · 区间内共 ${apiTotal.value} 个接口`;
});

/* ────────────────────────────── SVG 绘图 ────────────────────────────── */

type Pad = { l: number; r: number; t: number; b: number };

const GW = 900;
const GH = 240;
const GPAD: Pad = { l: 46, r: 14, t: 14, b: 26 };

/** 详情图右侧留白更大：可选叠加「平均耗时」右轴 */
const DW = 980;
const DH = 300;
const DPAD: Pad = { l: 52, r: 54, t: 16, b: 30 };

const SW = 260;
const SH = 64;

function xAt(i: number, n: number, w: number, p: Pad): number {
  if (n <= 1) return p.l + (w - p.l - p.r) / 2;
  return p.l + (i / (n - 1)) * (w - p.l - p.r);
}
function yAt(v: number, max: number, h: number, p: Pad): number {
  const inner = h - p.t - p.b;
  return p.t + inner - (max ? (v / max) * inner : 0);
}
function polyline(values: number[], max: number, w: number, h: number, p: Pad): string {
  const n = values.length;
  if (!n) return '';
  if (n === 1) {
    const y = yAt(values[0], max, h, p).toFixed(1);
    return `M${xAt(0, 1, w, p).toFixed(1)},${y} L${(w - p.r).toFixed(1)},${y}`;
  }
  return values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i, n, w, p).toFixed(1)},${yAt(v, max, h, p).toFixed(1)}`)
    .join(' ');
}
function areaOf(values: number[], max: number, w: number, h: number, p: Pad): string {
  if (!values.length) return '';
  const line = polyline(values, max, w, h, p);
  const n = values.length;
  const xLast = xAt(n - 1, n, w, p).toFixed(1);
  const xFirst = xAt(0, n, w, p).toFixed(1);
  const yBase = yAt(0, max, h, p).toFixed(1);
  return `${line} L${xLast},${yBase} L${xFirst},${yBase} Z`;
}
function niceTicks(max: number, count = 4): number[] {
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.01; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}
function tickIdxFor(n: number, want = 8): number[] {
  if (!n) return [];
  const stride = Math.max(1, Math.ceil(n / want));
  const out: number[] = [];
  for (let i = 0; i < n; i += stride) out.push(i);
  const last = out[out.length - 1];
  if (n > 1 && last !== n - 1 && n - 1 - last >= Math.ceil(stride / 2)) out.push(n - 1);
  return out;
}

const globalTicks = computed(() => niceTicks(globalMax.value));
const globalXIdx = computed(() => tickIdxFor(timeline.value.length));

/** 跨度超过 12h 时 x 轴带日期，否则只显示时分 */
const axisWithDate = computed(() => (serverRange.value?.spanMinutes ?? 60) > 720);
function axisLabel(minute: string): string {
  return axisWithDate.value ? fmtDayClock(minute) : fmtClock(minute);
}
function axisTipLabel(minute: string): string {
  return axisWithDate.value ? fmtDayClock(minute) : fmtFull(minute);
}

/** 小图：无坐标轴，仅趋势线 */
function sparkPath(values: number[], max: number): string {
  const n = values.length;
  if (!n) return '';
  if (n === 1) {
    const y = SH - 4 - (max ? (values[0] / max) * (SH - 8) : 0);
    return `M0,${y.toFixed(1)} L${SW},${y.toFixed(1)}`;
  }
  return values
    .map((v, i) => {
      const x = (i / (n - 1)) * SW;
      const y = SH - 4 - (max ? (v / max) * (SH - 8) : 0);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/* ────────────────────────────── 悬停十字准星 ────────────────────────────── */

function idxFromEvent(
  e: MouseEvent,
  el: SVGSVGElement | null,
  n: number,
  w: number,
  p: Pad
): number | null {
  if (!el || n <= 0) return null;
  const rect = el.getBoundingClientRect();
  if (!rect.width) return null;
  const xInVb = ((e.clientX - rect.left) / rect.width) * w;
  const inner = w - p.l - p.r;
  if (inner <= 0) return null;
  const raw = ((xInVb - p.l) / inner) * (n - 1);
  return Math.min(Math.max(Math.round(raw), 0), n - 1);
}

function onGlobalMove(e: MouseEvent) {
  hoverGlobal.value = idxFromEvent(e, globalSvg.value, timeline.value.length, GW, GPAD);
}
function onDetailMove(e: MouseEvent) {
  hoverDetail.value = idxFromEvent(e, detailSvg.value, detailBuckets.value.length, DW, DPAD);
}

function leftPctAt(i: number, n: number, w: number, p: Pad): number {
  if (n <= 0) return 0;
  return (xAt(i, n, w, p) / w) * 100;
}
const tipFlipAt = 70;

const globalTip = computed(() => {
  const i = hoverGlobal.value;
  const n = timeline.value.length;
  if (i === null || !n || i >= n) return null;
  const rows = globalLines.value.map((l) => ({
    label: STATUS_LABELS[l.statusClass] ?? l.statusClass,
    value: l.values[i] ?? 0,
    color: STATUS_COLORS[l.statusClass] ?? '#94a3b8',
  }));
  return {
    minute: timeline.value[i],
    rows,
    total: rows.reduce((a, r) => a + r.value, 0),
    left: leftPctAt(i, n, GW, GPAD),
    x: xAt(i, n, GW, GPAD),
    values: globalLines.value.map((l) => l.values[i] ?? 0),
  };
});

/* ────────────────────────────── 接口详情 ────────────────────────────── */

const detailBuckets = computed(() => detail.value?.buckets ?? []);

const detailLines = computed(() =>
  STATUS_CLASSES.map((statusClass) => {
    const values = detailBuckets.value.map((b) => statusCount(b, statusClass));
    return { statusClass, values, total: values.reduce((a, b) => a + b, 0) };
  }).filter((l) => l.total > 0 || !detail.value)
);

const detailMax = computed(() => {
  let m = 10;
  for (const l of detailLines.value) for (const v of l.values) if (v > m) m = v;
  return m;
});
const detailTicks = computed(() => niceTicks(detailMax.value));
const detailXIdx = computed(() => tickIdxFor(detailBuckets.value.length));

const showLatency = ref(false);
const latencyValues = computed(() => detailBuckets.value.map((b) => b.avgTimeMs));
const latencyMax = computed(() => {
  let m = 10;
  for (const v of latencyValues.value) if (v > m) m = v;
  // 顶部留白 15%，避免峰值贴在边框上
  return Math.ceil((m * 1.15) / 10) * 10;
});

const detailTip = computed(() => {
  const i = hoverDetail.value;
  const n = detailBuckets.value.length;
  if (i === null || !n || i >= n || !detail.value) return null;
  const b = detailBuckets.value[i];
  const rows = STATUS_CLASSES.map((cls) => ({
    label: STATUS_LABELS[cls],
    value: statusCount(b, cls),
    color: STATUS_COLORS[cls],
  })).filter((r) => r.value > 0);
  return {
    minute: b.minute,
    rows,
    total: b.total,
    avgTimeMs: b.avgTimeMs,
    left: leftPctAt(i, n, DW, DPAD),
    values: STATUS_CLASSES.map((cls) => statusCount(b, cls)),
  };
});

const detailBarMax = computed(() => {
  const d = detail.value;
  if (!d) return 1;
  return Math.max(1, ...d.statusCodes.map((s) => s.count), ...d.methods.map((s) => s.count), ...d.topPaths.map((s) => s.count), ...d.hosts.map((s) => s.count));
});
function barPct(v: number) {
  return detailBarMax.value ? Math.max(2, Math.round((v / detailBarMax.value) * 100)) : 0;
}
function statusColorOf(code: number): string {
  const cls = `${Math.floor(code / 100)}xx`;
  return STATUS_COLORS[cls] ?? '#94a3b8';
}

const apiOptions = computed(() =>
  apiList.value.map((a) => ({
    value: a.api,
    label: a.api,
    hint: `${fmtNum(a.count)} 次${a.errCount ? ` · ${fmtNum(a.errCount)} 错误` : ''}`,
  }))
);
const apiPickerModel = computed({
  get: () => selectedApi.value,
  set: (v: string) => {
    if (v) void openDetail(v);
    else closeDetail();
  },
});

function apiShort(api: string): string {
  if (api.length <= 34) return api;
  return `${api.slice(0, 31)}…`;
}

/* ────────────────────────────── 图例过滤 ────────────────────────────── */

const activeStatus = ref('');
function toggleStatus(cls: string) {
  activeStatus.value = activeStatus.value === cls ? '' : cls;
}
function isDimmed(cls: string): boolean {
  return !!activeStatus.value && activeStatus.value !== cls;
}

/* ────────────────────────────── 机器状态 ────────────────────────────── */

const machineHistoryPath = computed(() => {
  const hist = machine.value?.history ?? [];
  if (hist.length < 2) return { cpu: '', mem: '', cpuArea: '', memArea: '' };
  const w = 300;
  const h = 64;
  const xs = (i: number) => (i / (hist.length - 1)) * w;
  const cpuY = (v: number) => h - 3 - (v / 100) * (h - 8);
  const maxMem = Math.max(machine.value?.current.memTotalMb ?? 1, 1);
  const memY = (v: number) => h - 3 - (v / maxMem) * (h - 8);
  const cpu = hist.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${cpuY(p.cpuPercent).toFixed(1)}`).join(' ');
  const mem = hist.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${memY(p.memUsedMb).toFixed(1)}`).join(' ');
  const cpuArea = `${cpu} L${w},${h} L0,${h} Z`;
  const memArea = `${mem} L${w},${h} L0,${h} Z`;
  return { cpu, mem, cpuArea, memArea };
});

const moduleOptions = computed(() => [
  { value: '', label: '全部模块' },
  ...modules.value.map((m) => ({
    value: m.id,
    label: m.name,
    hint: m.projectName || undefined,
  })),
]);
const hostOptions = computed(() => {
  // 从日志页带过来的 host 可能不在最近 24h 的 facets 里，补进去避免下拉显示空值
  const set = new Set(hosts.value);
  if (hostFilter.value) set.add(hostFilter.value);
  return [
    { value: '', label: '全部子域名' },
    ...[...set].sort().map((h) => ({ value: h, label: h })),
  ];
});
</script>

<template>
  <div class="monitor-page">
    <header class="page-hero">
      <div>
        <p class="page-hero__eyebrow">监控中心</p>
        <h1 class="page-hero__title">总览图表</h1>
        <p class="page-hero__desc">
          全站流量趋势、Top API 时序与机器运行状态。点击任意接口卡片可下钻查看该接口的折线图。
        </p>
      </div>
      <div class="page-hero__actions">
        <MonitorSelect
          v-model="moduleId"
          class="hero-select"
          :options="moduleOptions"
          placeholder="全部模块"
          searchable
        />
        <MonitorSelect
          v-model="hostFilter"
          class="hero-select"
          :options="hostOptions"
          placeholder="全部子域名"
          searchable
        />
        <MonitorSelect v-model="presetModel" class="hero-select hero-select--sm" :options="PRESETS" />
      </div>
    </header>

    <MonitorTabs />

    <!-- 时间范围：预设模式显示自动刷新；自定义模式展开区间编辑器 -->
    <section class="deploy-surface range-panel">
      <div class="range-panel__head">
        <span class="range-panel__label">时间范围</span>
        <span class="range-panel__value">{{ rangeLabel }}</span>
        <span v-if="spanLabel" class="range-chip">跨度 {{ spanLabel }}</span>
        <span v-if="serverRange" class="range-chip range-chip--muted">粒度 {{ bucketLabel }}</span>
        <span v-if="isCustomRange" class="range-chip range-chip--custom">自定义</span>
        <span class="range-panel__spacer" />
        <span v-if="!isCustomRange" class="live-dot"><i />每 15 秒自动刷新</span>
        <button type="button" class="ghost-btn" :disabled="refreshing" @click="refreshAll">
          {{ refreshing ? '刷新中…' : '立即刷新' }}
        </button>
      </div>

      <div v-if="preset === 'custom'" class="custom-range">
        <label class="custom-range__field">
          <span>开始</span>
          <input v-model="customFrom" type="datetime-local" class="dt-input" />
        </label>
        <span class="custom-range__tilde">~</span>
        <label class="custom-range__field">
          <span>结束</span>
          <input v-model="customTo" type="datetime-local" class="dt-input" />
        </label>
        <div class="quick-picks">
          <button
            v-for="q in QUICK_PICKS"
            :key="q.key"
            type="button"
            class="ghost-btn ghost-btn--sm"
            @click="applyQuick(q.key)"
          >
            {{ q.label }}
          </button>
        </div>
        <span class="custom-range__hint" :class="{ 'is-bad': !customParsed.ok }">
          {{ customParsed.ok ? `跨度 ${customSpanLabel}，可查询` : customParsed.msg }}
        </span>
        <SlButton size="sm" :disabled="!customParsed.ok || refreshing" @click="applyCustom">应用</SlButton>
        <SlButton size="sm" variant="secondary" @click="backToPreset">取消</SlButton>
      </div>
    </section>

    <SlAlert v-if="error" variant="error" class="mb">{{ error }}</SlAlert>
    <div v-if="loading" class="page-loading"><SlSpinner /></div>

    <template v-else>
      <!-- KPI -->
      <section class="kpi-row">
        <div class="kpi-card">
          <div class="kpi-card__top">
            <span class="kpi-card__label">请求总数</span>
            <span class="kpi-icon kpi-icon--blue">
              <svg viewBox="0 0 20 20" width="16" height="16"><path d="M2 10h3l2.2-5 3.4 10L13 10h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
          </div>
          <div class="kpi-card__value">{{ fmtNum(kpi?.total ?? 0) }}</div>
          <div class="kpi-card__foot">{{ spanLabel }}累计</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-card__top">
            <span class="kpi-card__label">平均 QPS</span>
            <span class="kpi-icon kpi-icon--violet">
              <svg viewBox="0 0 20 20" width="16" height="16"><path d="M3 15V9m4.6 6V5m4.6 10v-8M17 15v-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
            </span>
          </div>
          <div class="kpi-card__value">{{ kpi?.qps ?? 0 }}<span class="kpi-card__unit">/s</span></div>
          <div class="kpi-card__foot">窗口内平均每秒请求</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-card__top">
            <span class="kpi-card__label">服务器错误</span>
            <span class="kpi-icon kpi-icon--red">
              <svg viewBox="0 0 20 20" width="16" height="16"><path d="M10 3l7.5 13h-15L10 3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M10 8.4v3.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="10" cy="13.9" r="0.9" fill="currentColor"/></svg>
            </span>
          </div>
          <div class="kpi-card__value" :class="{ 'kpi-bad': (kpi?.errors ?? 0) > 0 }">
            {{ fmtNum(kpi?.errors ?? 0) }}
          </div>
          <div class="kpi-card__foot">
            {{ kpi?.total ? ((kpi.errors / kpi.total) * 100).toFixed(2) : '0.00' }}% 错误率（仅 5xx）
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-card__top">
            <span class="kpi-card__label">平均耗时</span>
            <span class="kpi-icon kpi-icon--amber">
              <svg viewBox="0 0 20 20" width="16" height="16"><circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10 6v4.2l2.8 1.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
          </div>
          <div class="kpi-card__value">{{ kpi?.avgTimeMs ?? 0 }}<span class="kpi-card__unit">ms</span></div>
          <div class="kpi-card__foot">网关 request_time 均值</div>
        </div>
      </section>

      <!-- 全站趋势 -->
      <section class="deploy-surface chart-card" :class="{ 'is-busy': refreshing }">
        <div class="chart-card__head">
          <div>
            <h2 class="chart-card__title">全站请求趋势</h2>
            <p class="chart-card__sub">
              全部接口求和 · 按状态码分线，点击图例可强调对应线（悬停查看每格明细）
            </p>
          </div>
          <div class="status-pills">
            <button
              v-for="line in globalLines"
              :key="line.statusClass"
              type="button"
              class="status-pill"
              :class="{ 'status-pill--off': isDimmed(line.statusClass) }"
              :style="activeStatus === line.statusClass ? { borderColor: STATUS_COLORS[line.statusClass], color: STATUS_COLORS[line.statusClass] } : undefined"
              @click="toggleStatus(line.statusClass)"
            >
              <i :style="{ background: STATUS_COLORS[line.statusClass] }" />
              {{ STATUS_LABELS[line.statusClass] }}
              <b>{{ fmtNum(line.total) }}</b>
            </button>
          </div>
        </div>
        <div class="chart-scroll">
          <div class="chart-wrap">
            <svg
              ref="globalSvg"
              :viewBox="`0 0 ${GW} ${GH}`"
              class="chart-svg"
              role="img"
              aria-label="全站请求趋势"
              @mousemove="onGlobalMove"
              @mouseleave="hoverGlobal = null"
            >
              <defs>
                <linearGradient id="grad-2xx" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#10b981" stop-opacity="0.22" />
                  <stop offset="100%" stop-color="#10b981" stop-opacity="0" />
                </linearGradient>
              </defs>
              <g v-for="t in globalTicks" :key="`gy${t}`">
                <line
                  :x1="GPAD.l" :x2="GW - GPAD.r" :y1="yAt(t, globalMax, GH, GPAD)"
                  :y2="yAt(t, globalMax, GH, GPAD)"
                  stroke="#e8edf4" stroke-width="1"
                  :stroke-dasharray="t === 0 ? '' : '3 4'"
                />
                <text
                  :x="GPAD.l - 9" :y="yAt(t, globalMax, GH, GPAD) + 3.5"
                  text-anchor="end" class="chart-tick"
                >{{ t }}</text>
              </g>
              <g v-for="i in globalXIdx" :key="`gx${i}`">
                <text :x="xAt(i, timeline.length, GW, GPAD)" :y="GH - 8" text-anchor="middle" class="chart-tick">
                  {{ axisLabel(timeline[i]) }}
                </text>
              </g>
              <template v-for="line in globalLines" :key="line.statusClass">
                <path
                  v-if="line.statusClass === '2xx' && !isDimmed('2xx')"
                  :d="areaOf(line.values, globalMax, GW, GH, GPAD)"
                  fill="url(#grad-2xx)"
                />
                <path
                  :d="polyline(line.values, globalMax, GW, GH, GPAD)"
                  fill="none"
                  :stroke="STATUS_COLORS[line.statusClass]"
                  stroke-width="1.8"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                  :opacity="isDimmed(line.statusClass) ? 0.25 : 1"
                />
              </template>
              <!-- 十字准星 -->
              <g v-if="globalTip">
                <line
                  :x1="globalTip.x" :x2="globalTip.x" :y1="GPAD.t" :y2="GH - GPAD.b"
                  stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 3"
                />
                <circle
                  v-for="(v, li) in globalTip.values"
                  :key="`gc${li}`"
                  :cx="globalTip.x"
                  :cy="yAt(v, globalMax, GH, GPAD)"
                  r="3.2"
                  :fill="STATUS_COLORS[globalLines[li].statusClass]"
                  stroke="#fff"
                  stroke-width="1.4"
                />
              </g>
            </svg>
            <div
              v-if="globalTip"
              class="chart-tip"
              :class="{ 'chart-tip--flip': globalTip.left > tipFlipAt }"
              :style="{ left: `${globalTip.left}%` }"
            >
              <div class="chart-tip__time">{{ axisTipLabel(globalTip.minute) }}</div>
              <div v-for="row in globalTip.rows" :key="row.label" class="chart-tip__row">
                <i :style="{ background: row.color }" />
                <span>{{ row.label }}</span>
                <b>{{ fmtNum(row.value) }}</b>
              </div>
              <div class="chart-tip__row chart-tip__row--sum">
                <i class="chart-tip__dot--sum" />
                <span>合计</span>
                <b>{{ fmtNum(globalTip.total) }}</b>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Top API 小图（可点击下钻） -->
      <section class="panel-block">
        <div class="panel-block__head">
          <h2 class="chart-card__title">Top {{ TOP_N }} API 时序</h2>
          <p class="chart-card__sub">按请求量排序 · 每个独立坐标，避免大流量接口淹没其他</p>
          <span v-if="topApisHint" class="panel-block__hint">{{ topApisHint }}</span>
        </div>
        <SlEmpty v-if="!apiCards.length" title="当前区间没有访问记录" description="换个时间范围或模块试试" />
        <div v-else class="api-grid">
          <button
            v-for="card in apiCards"
            :key="card.api"
            type="button"
            class="deploy-surface api-card"
            :class="{ 'api-card--active': selectedApi === card.api }"
            :title="`${card.api} —— 点击查看该接口折线图`"
            @click="openDetail(card.api)"
          >
            <div class="api-card__head">
              <code class="api-card__name">{{ apiShort(card.api) }}</code>
              <span class="api-card__total">{{ fmtNum(card.total) }}</span>
            </div>
            <div class="api-card__chart">
              <svg :viewBox="`0 0 ${SW} ${SH}`" class="api-card__spark" preserveAspectRatio="none" role="img" :aria-label="card.api">
                <template v-for="line in card.lines" :key="line.statusClass">
                  <path
                    :d="sparkPath(line.values, card.peak)"
                    fill="none"
                    :stroke="STATUS_COLORS[line.statusClass]"
                    stroke-width="1.5"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                    :opacity="isDimmed(line.statusClass) ? 0.2 : 1"
                  />
                </template>
              </svg>
              <span class="api-card__cta">
                查看折线图
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </span>
            </div>
            <div class="api-card__foot">
              <span class="api-card__delta" :class="card.trendUp ? 'is-up' : 'is-down'">
                最近 {{ fmtNum(card.last) }} {{ reqUnit }}
                <span v-if="(serverRange?.bucketMinutes ?? 1) > 1" class="api-card__permin">
                  ≈{{ (card.last / (serverRange?.bucketMinutes ?? 1)).toFixed(1) }}/min
                </span>
              </span>
              <span v-if="card.errTotal" class="api-card__err">{{ fmtNum(card.errTotal) }} 错误</span>
              <span v-else class="api-card__ok">无错误</span>
            </div>
          </button>
        </div>
      </section>

      <!-- 接口详情 -->
      <section v-if="selectedApi" ref="detailEl" class="deploy-surface chart-card detail-card">
        <div class="chart-card__head detail-card__head">
          <div class="detail-card__title">
            <h2 class="chart-card__title">接口详情</h2>
            <code class="detail-card__api">{{ selectedApi }}</code>
          </div>
          <div class="detail-card__actions">
            <MonitorSelect
              v-model="apiPickerModel"
              class="detail-picker"
              :options="apiOptions"
              placeholder="选择接口"
              searchable
              width="280px"
            />
            <button
              type="button"
              class="ghost-btn ghost-btn--sm"
              :class="{ 'ghost-btn--on': showLatency }"
              @click="showLatency = !showLatency"
            >
              叠加平均耗时
            </button>
            <button type="button" class="ghost-btn ghost-btn--sm" :disabled="detailLoading" @click="loadDetail()">
              {{ detailLoading ? '加载中…' : '刷新' }}
            </button>
            <button type="button" class="ghost-btn ghost-btn--sm" @click="closeDetail">关闭</button>
          </div>
        </div>

        <SlAlert v-if="detailError" variant="error" class="mb">{{ detailError }}</SlAlert>

        <div class="detail-body" :class="{ 'is-busy': detailLoading }">
          <div v-if="detailLoading" class="detail-overlay">
            <SlSpinner size="lg" />
            <span class="overlay-text">正在加载接口数据…</span>
          </div>

          <template v-if="detail">
            <!-- 汇总 -->
            <div class="detail-stats">
              <div class="detail-stat">
                <span>请求总数</span>
                <b>{{ fmtNum(detail.summary.total) }}</b>
              </div>
              <div class="detail-stat">
                <span>错误（5xx）</span>
                <b :class="{ 'is-bad': detail.summary.errors > 0 }">
                  {{ fmtNum(detail.summary.errors) }}
                  <em>{{ detail.summary.errorRate }}%</em>
                </b>
              </div>
              <div class="detail-stat">
                <span>平均耗时</span>
                <b>{{ fmtMs(detail.summary.avgTimeMs) }}</b>
              </div>
              <div class="detail-stat">
                <span>均值</span>
                <b>{{ detail.summary.avgPerMinute }}<em>/min</em></b>
              </div>
              <div class="detail-stat">
                <span>峰值</span>
                <b>
                  {{ fmtNum(detail.summary.peakPerBucket) }}<em>/{{ bucketLabel }}</em>
                  <small v-if="detail.summary.peakMinute">@ {{ fmtClock(detail.summary.peakMinute) }}</small>
                </b>
              </div>
            </div>

            <!-- 折线图 -->
            <div class="chart-scroll">
              <div class="chart-wrap chart-wrap--detail">
                <svg
                  ref="detailSvg"
                  :viewBox="`0 0 ${DW} ${DH}`"
                  class="chart-svg chart-svg--detail"
                  role="img"
                  :aria-label="`${selectedApi} 折线图`"
                  @mousemove="onDetailMove"
                  @mouseleave="hoverDetail = null"
                >
                  <defs>
                    <linearGradient id="grad-detail-2xx" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stop-color="#10b981" stop-opacity="0.2" />
                      <stop offset="100%" stop-color="#10b981" stop-opacity="0" />
                    </linearGradient>
                  </defs>
                  <g v-for="t in detailTicks" :key="`dy${t}`">
                    <line
                      :x1="DPAD.l" :x2="DW - DPAD.r"
                      :y1="yAt(t, detailMax, DH, DPAD)" :y2="yAt(t, detailMax, DH, DPAD)"
                      stroke="#e8edf4" stroke-width="1"
                      :stroke-dasharray="t === 0 ? '' : '3 4'"
                    />
                    <text
                      :x="DPAD.l - 9" :y="yAt(t, detailMax, DH, DPAD) + 3.5"
                      text-anchor="end" class="chart-tick"
                    >{{ t }}</text>
                  </g>
                  <!-- 右轴：平均耗时 -->
                  <g v-if="showLatency && latencyMax">
                    <g v-for="t in niceTicks(latencyMax)" :key="`dl${t}`">
                      <text
                        :x="DW - DPAD.r + 9" :y="yAt(t, latencyMax, DH, DPAD) + 3.5"
                        text-anchor="start" class="chart-tick chart-tick--latency"
                      >{{ t }}ms</text>
                    </g>
                  </g>
                  <g v-for="i in detailXIdx" :key="`dx${i}`">
                    <text :x="xAt(i, detailBuckets.length, DW, DPAD)" :y="DH - 8" text-anchor="middle" class="chart-tick">
                      {{ axisLabel(detailBuckets[i].minute) }}
                    </text>
                  </g>
                  <template v-for="line in detailLines" :key="line.statusClass">
                    <path
                      v-if="line.statusClass === '2xx' && !isDimmed('2xx')"
                      :d="areaOf(line.values, detailMax, DW, DH, DPAD)"
                      fill="url(#grad-detail-2xx)"
                    />
                    <path
                      :d="polyline(line.values, detailMax, DW, DH, DPAD)"
                      fill="none"
                      :stroke="STATUS_COLORS[line.statusClass]"
                      stroke-width="1.9"
                      stroke-linejoin="round"
                      stroke-linecap="round"
                      :opacity="isDimmed(line.statusClass) ? 0.22 : 1"
                    />
                  </template>
                  <path
                    v-if="showLatency"
                    :d="polyline(latencyValues, latencyMax, DW, DH, DPAD)"
                    fill="none"
                    :stroke="LATENCY_COLOR"
                    stroke-width="1.5"
                    stroke-dasharray="5 3"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                    opacity="0.85"
                  />
                  <g v-if="detailTip">
                    <line
                      :x1="xAt(hoverDetail ?? 0, detailBuckets.length, DW, DPAD)"
                      :x2="xAt(hoverDetail ?? 0, detailBuckets.length, DW, DPAD)"
                      :y1="DPAD.t" :y2="DH - DPAD.b"
                      stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 3"
                    />
                    <circle
                      v-for="(v, li) in detailTip.values"
                      :key="`dc${li}`"
                      :cx="xAt(hoverDetail ?? 0, detailBuckets.length, DW, DPAD)"
                      :cy="yAt(v, detailMax, DH, DPAD)"
                      r="3.4"
                      :fill="STATUS_COLORS[STATUS_CLASSES[li]]"
                      stroke="#fff"
                      stroke-width="1.4"
                    />
                  </g>
                </svg>
                <div
                  v-if="detailTip"
                  class="chart-tip"
                  :class="{ 'chart-tip--flip': detailTip.left > tipFlipAt }"
                  :style="{ left: `${detailTip.left}%` }"
                >
                  <div class="chart-tip__time">{{ axisTipLabel(detailTip.minute) }}</div>
                  <div v-for="row in detailTip.rows" :key="row.label" class="chart-tip__row">
                    <i :style="{ background: row.color }" />
                    <span>{{ row.label }}</span>
                    <b>{{ fmtNum(row.value) }}</b>
                  </div>
                  <div v-if="showLatency" class="chart-tip__row">
                    <i :style="{ background: LATENCY_COLOR }" />
                    <span>平均耗时</span>
                    <b>{{ fmtMs(detailTip.avgTimeMs) }}</b>
                  </div>
                  <div class="chart-tip__row chart-tip__row--sum">
                    <i class="chart-tip__dot--sum" />
                    <span>合计</span>
                    <b>{{ fmtNum(detailTip.total) }}</b>
                  </div>
                </div>
              </div>
            </div>

            <SlEmpty
              v-if="!detailBuckets.length || !detail.summary.total"
              title="该区间内此接口没有访问记录"
              description="可能是接口未上线、或时间范围选得太窄"
            />

            <!-- 分布 -->
            <div v-if="detail.truncated" class="detail-note">
              明细日志仅保留 7 天，该区间已超出保留期：下方分布与近期错误为空，折线图取自 30 天的分钟聚合。
            </div>

            <div class="detail-grid">
              <div class="detail-block">
                <h3 class="detail-block__title">状态码分布</h3>
                <SlEmpty v-if="!detail.statusCodes.length" title="无数据" description="明细已过期或区间内无请求" />
                <ul v-else class="bar-list">
                  <li v-for="s in detail.statusCodes" :key="s.code">
                    <span class="bar-list__key">
                      <i class="bar-list__dot" :style="{ background: statusColorOf(s.code) }" />
                      {{ s.code }}
                    </span>
                    <span class="bar-list__track">
                      <span
                        class="bar-list__fill"
                        :style="{ width: `${barPct(s.count)}%`, background: statusColorOf(s.code) }"
                      />
                    </span>
                    <span class="bar-list__val">{{ fmtNum(s.count) }}</span>
                  </li>
                </ul>
              </div>

              <div class="detail-block">
                <h3 class="detail-block__title">请求方法</h3>
                <SlEmpty v-if="!detail.methods.length" title="无数据" description="明细已过期或区间内无请求" />
                <ul v-else class="bar-list">
                  <li v-for="m in detail.methods" :key="m.method">
                    <span class="bar-list__key">{{ m.method }}</span>
                    <span class="bar-list__track">
                      <span class="bar-list__fill" :style="{ width: `${barPct(m.count)}%` }" />
                    </span>
                    <span class="bar-list__val">{{ fmtNum(m.count) }}</span>
                  </li>
                </ul>
              </div>

              <div class="detail-block">
                <h3 class="detail-block__title">
                  真实路径 Top
                  <em class="detail-block__note">同一接口下的不同 URL</em>
                </h3>
                <SlEmpty v-if="!detail.topPaths.length" title="无数据" description="明细已过期或区间内无请求" />
                <ul v-else class="bar-list bar-list--wide">
                  <li v-for="p in detail.topPaths" :key="p.path">
                    <code class="bar-list__path" :title="p.path">{{ p.path }}</code>
                    <span class="bar-list__val">{{ fmtNum(p.count) }}</span>
                  </li>
                </ul>
              </div>

              <div class="detail-block">
                <h3 class="detail-block__title">来源 Host</h3>
                <SlEmpty v-if="!detail.hosts.length" title="无数据" description="明细已过期或区间内无请求" />
                <ul v-else class="bar-list bar-list--wide">
                  <li v-for="h in detail.hosts" :key="h.host">
                    <code class="bar-list__path" :title="h.host">{{ h.host || '(空)' }}</code>
                    <span class="bar-list__val">{{ fmtNum(h.count) }}</span>
                  </li>
                </ul>
              </div>
            </div>

            <!-- 近期错误 -->
            <div class="detail-block detail-block--full">
              <h3 class="detail-block__title">
                近期错误
                <em class="detail-block__note">5xx 优先展示</em>
              </h3>
              <SlEmpty v-if="!detail.recentErrors.length" title="没有错误记录" description="区间内该接口未出现 4xx / 5xx" />
              <div v-else class="err-table-wrap">
                <table class="err-table">
                  <thead>
                    <tr>
                      <th class="col-time">时间</th>
                      <th>方法</th>
                      <th>路径</th>
                      <th class="col-status">状态</th>
                      <th class="col-ms">耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(e, i) in detail.recentErrors" :key="`${e.ts}-${i}`">
                      <td class="col-time muted">{{ fmtIsoLocal(e.ts) }}</td>
                      <td><span class="method-tag">{{ e.method }}</span></td>
                      <td class="col-path"><code>{{ e.path }}</code></td>
                      <td class="col-status">
                        <span class="status-badge" :style="{ background: statusColorOf(e.status) }">{{ e.status }}</span>
                      </td>
                      <td class="col-ms muted">{{ fmtMs(e.requestTimeMs) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </template>
        </div>
      </section>

      <!-- 机器状态 -->
      <section v-if="machine" class="deploy-surface machine-card">
        <div class="machine-card__head">
          <div>
            <h2 class="chart-card__title">机器运行状态</h2>
            <p class="chart-card__sub">{{ machine.current.hostname }} · {{ machine.current.platform }}</p>
          </div>
          <div class="machine-head-right">
            <router-link class="proc-link" :to="{ name: 'monitor-proc' }">
              进程管理
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </router-link>
            <span class="live-dot"><i /></span>
          </div>
        </div>
        <div class="machine-cards">
          <div class="machine-metric">
            <div class="machine-metric__label">CPU 使用率</div>
            <div class="machine-metric__value">
              {{ Math.round(machine.current.cpuPercent) }}<span>%</span>
            </div>
            <svg viewBox="0 0 300 64" class="machine-spark" preserveAspectRatio="none">
              <defs>
                <linearGradient id="grad-cpu" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.25" />
                  <stop offset="100%" stop-color="#3b82f6" stop-opacity="0" />
                </linearGradient>
              </defs>
              <path v-if="machineHistoryPath.cpuArea" :d="machineHistoryPath.cpuArea" fill="url(#grad-cpu)" />
              <path v-if="machineHistoryPath.cpu" :d="machineHistoryPath.cpu" fill="none" stroke="#3b82f6" stroke-width="1.6" />
            </svg>
          </div>
          <div class="machine-metric">
            <div class="machine-metric__label">内存</div>
            <div class="machine-metric__value">
              {{ fmtMb(machine.current.memUsedMb) }}
              <span class="machine-metric__sub">/ {{ fmtMb(machine.current.memTotalMb) }}</span>
            </div>
            <div class="machine-bar">
              <div
                class="machine-bar__fill"
                :class="{ 'machine-bar__fill--hot': pct(machine.current.memUsedMb, machine.current.memTotalMb) > 85 }"
                :style="{ width: pct(machine.current.memUsedMb, machine.current.memTotalMb) + '%' }"
              />
            </div>
            <svg viewBox="0 0 300 64" class="machine-spark" preserveAspectRatio="none">
              <defs>
                <linearGradient id="grad-mem" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#10b981" stop-opacity="0.25" />
                  <stop offset="100%" stop-color="#10b981" stop-opacity="0" />
                </linearGradient>
              </defs>
              <path v-if="machineHistoryPath.memArea" :d="machineHistoryPath.memArea" fill="url(#grad-mem)" />
              <path v-if="machineHistoryPath.mem" :d="machineHistoryPath.mem" fill="none" stroke="#10b981" stroke-width="1.6" />
            </svg>
          </div>
          <div class="machine-metric">
            <div class="machine-metric__label">磁盘（/）</div>
            <div class="machine-metric__value">
              {{ machine.current.diskUsedGb }}
              <span class="machine-metric__sub">/ {{ machine.current.diskTotalGb }} GB</span>
            </div>
            <div class="machine-bar">
              <div
                class="machine-bar__fill machine-bar__fill--amber"
                :class="{ 'machine-bar__fill--hot': pct(machine.current.diskUsedGb, machine.current.diskTotalGb) > 90 }"
                :style="{ width: pct(machine.current.diskUsedGb, machine.current.diskTotalGb) + '%' }"
              />
            </div>
            <div class="machine-metric__foot muted">
              已用 {{ pct(machine.current.diskUsedGb, machine.current.diskTotalGb) }}%
            </div>
          </div>
          <div class="machine-metric">
            <div class="machine-metric__label">负载 (1/5/15min)</div>
            <div class="machine-metric__value machine-metric__value--sm">
              {{ machine.current.load1.toFixed(2) }} /
              {{ machine.current.load5.toFixed(2) }} /
              {{ machine.current.load15.toFixed(2) }}
            </div>
            <div class="machine-metric__foot muted">
              运行 {{ fmtUptime(machine.current.uptimeSec) }}
            </div>
          </div>
        </div>
        <div class="machine-collector" :class="{ 'machine-collector--bad': !machine.collector.running }">
          日志采集器：
          <b>{{ machine.collector.running ? '运行中' : '未连接' }}</b>
          <code class="machine-collector__path">{{ machine.collector.logPath }}</code>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.monitor-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.hero-select {
  min-width: 200px;
}
.hero-select--sm {
  min-width: 148px;
  width: 148px;
}

/* —— 时间范围面板 —— */
.range-panel {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.range-panel__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.range-panel__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--deploy-muted-fg);
}
.range-panel__value {
  font-size: 13px;
  font-weight: 600;
  color: var(--deploy-fg);
  font-variant-numeric: tabular-nums;
}
.range-panel__spacer {
  flex: 1 1 auto;
}
.range-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--deploy-border);
  background: var(--deploy-muted);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--deploy-fg-secondary);
}
.range-chip--muted {
  background: transparent;
  color: var(--deploy-muted-fg);
}
.range-chip--custom {
  border-color: #c7d2fe;
  background: #eef2ff;
  color: #4338ca;
}
.ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 11px;
  border: 1px solid var(--deploy-border);
  border-radius: 8px;
  background: #fff;
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--deploy-fg-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}
.ghost-btn:hover:not(:disabled) {
  border-color: var(--deploy-primary);
  color: var(--deploy-primary);
}
.ghost-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ghost-btn--sm {
  padding: 4px 9px;
  font-size: 12px;
}
.ghost-btn--on {
  /* 与「平均耗时」叠加线同色，按钮激活态和线一眼能对上 */
  border-color: #0891b2;
  color: #0e7490;
  background: #ecfeff;
}
.custom-range {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding-top: 10px;
  border-top: 1px dashed var(--deploy-border);
}
.custom-range__field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--deploy-fg-secondary);
}
.custom-range__tilde {
  color: var(--deploy-muted-fg);
}
.dt-input {
  font: inherit;
  font-size: 12.5px;
  padding: 5px 8px;
  border: 1px solid var(--deploy-border);
  border-radius: 8px;
  background: #fff;
  color: var(--deploy-fg);
  color-scheme: light;
}
.dt-input:focus {
  outline: none;
  border-color: var(--deploy-primary);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.13);
}
.quick-picks {
  display: inline-flex;
  gap: 6px;
}
.custom-range__hint {
  font-size: 12px;
  color: var(--deploy-muted-fg);
}
.custom-range__hint.is-bad {
  color: #dc2626;
  font-weight: 600;
}

/* —— KPI —— */
.kpi-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.kpi-card {
  position: relative;
  background: #fff;
  border: 1px solid var(--deploy-border);
  border-radius: var(--deploy-radius-lg);
  box-shadow: var(--deploy-shadow);
  padding: 16px 18px 14px;
  overflow: hidden;
}
.kpi-card::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: linear-gradient(180deg, var(--sl-primary-500, #3b82f6), #8b5cf6);
  opacity: 0;
  transition: opacity 0.2s ease;
}
.kpi-card:hover::before {
  opacity: 1;
}
.kpi-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.kpi-card__label {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--deploy-fg-secondary);
}
.kpi-icon {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.kpi-icon--blue { background: #eff6ff; color: #2563eb; }
.kpi-icon--violet { background: #f5f3ff; color: #7c3aed; }
.kpi-icon--red { background: #fef2f2; color: #dc2626; }
.kpi-icon--amber { background: #fffbeb; color: #d97706; }
.kpi-card__value {
  font-size: 1.75rem;
  font-weight: 750;
  letter-spacing: -0.03em;
  color: var(--deploy-fg);
  font-variant-numeric: tabular-nums;
}
.kpi-card__unit {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--deploy-muted-fg);
  margin-left: 3px;
}
.kpi-card__foot {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--deploy-muted-fg);
}
.kpi-bad {
  color: #dc2626;
}

/* —— 图表卡 —— */
.chart-card {
  padding: 16px 18px 12px;
  transition: opacity 0.18s ease;
}
.chart-card.is-busy {
  opacity: 0.72;
}
.chart-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.chart-card__title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--deploy-fg);
}
.chart-card__sub {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--deploy-muted-fg);
}
.chart-scroll {
  overflow-x: auto;
}
.chart-wrap {
  position: relative;
  min-width: 640px;
}
.chart-wrap--detail {
  min-width: 760px;
}
.chart-svg {
  width: 100%;
  min-width: 640px;
  height: auto;
  display: block;
}
.chart-svg--detail {
  min-width: 760px;
}
.chart-tick {
  font-size: 10px;
  fill: #94a3b8;
  font-family: var(--deploy-mono);
}
.chart-tick--latency {
  fill: #a78bfa;
}

/* —— 悬停提示 —— */
.chart-tip {
  position: absolute;
  top: 8px;
  transform: translateX(-50%);
  min-width: 148px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid var(--deploy-border);
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.14);
  pointer-events: none;
  z-index: 3;
}
.chart-tip--flip {
  transform: translateX(-100%);
}
.chart-tip__time {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--deploy-fg);
  margin-bottom: 6px;
  font-variant-numeric: tabular-nums;
}
.chart-tip__row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--deploy-fg-secondary);
  line-height: 1.7;
}
.chart-tip__row i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
.chart-tip__row span {
  flex: 1;
}
.chart-tip__row b {
  font-variant-numeric: tabular-nums;
  color: var(--deploy-fg);
}
.chart-tip__row--sum {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px dashed var(--deploy-border);
}
.chart-tip__dot--sum {
  background: #64748b;
}

/* 状态码 pill 图例 */
.status-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-family: inherit;
  font-weight: 600;
  color: var(--deploy-fg-secondary);
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--deploy-border);
  background: #fff;
  cursor: pointer;
  transition: all 0.15s ease;
}
.status-pill i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.status-pill b {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: var(--deploy-fg);
}
.status-pill:hover {
  border-color: #b9c6d8;
  background: var(--deploy-muted);
}
.status-pill--off {
  opacity: 0.4;
}

/* —— Top API 小图 —— */
.panel-block__head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  padding: 0 2px;
}
.panel-block__head .chart-card__sub {
  margin: 0;
}
.panel-block__hint {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--deploy-muted-fg);
}
.api-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.api-card {
  /* 卡片本身即按钮：点击下钻到单接口折线图 */
  padding: 12px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: box-shadow 0.18s ease, transform 0.18s ease, border-color 0.18s ease;
}
.api-card:hover {
  border-color: var(--deploy-primary);
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.12);
  transform: translateY(-1px);
}
.api-card:focus-visible {
  outline: none;
  border-color: var(--deploy-primary);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.18);
}
.api-card--active {
  border-color: var(--deploy-primary);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.22);
}
.api-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.api-card__name {
  font-family: var(--deploy-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--deploy-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.api-card__total {
  flex: none;
  font-size: 12.5px;
  font-weight: 750;
  color: var(--deploy-primary);
  font-variant-numeric: tabular-nums;
}
.api-card__chart {
  position: relative;
}
.api-card__spark {
  width: 100%;
  height: 58px;
  display: block;
}
.api-card__cta {
  position: absolute;
  right: 0;
  bottom: 2px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid var(--deploy-border);
  font-size: 10.5px;
  font-weight: 700;
  color: var(--deploy-primary);
  opacity: 0;
  transform: translateY(3px);
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.api-card:hover .api-card__cta,
.api-card:focus-visible .api-card__cta,
.api-card--active .api-card__cta {
  opacity: 1;
  transform: translateY(0);
}
.api-card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
}
.api-card__delta {
  font-variant-numeric: tabular-nums;
  color: var(--deploy-muted-fg);
}
.api-card__delta.is-up {
  color: #15803d;
}
.api-card__delta.is-down {
  color: #b45309;
}
.api-card__permin {
  color: #94a3b8;
}
.api-card__err {
  color: #dc2626;
  font-weight: 700;
}
.api-card__ok {
  color: #94a3b8;
}

/* —— 接口详情 —— */
.detail-card {
  scroll-margin-top: 12px;
  border-color: #c7d2fe;
}
.detail-card__head {
  align-items: center;
}
.detail-card__title {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.detail-card__api {
  font-family: var(--deploy-mono);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--deploy-primary);
  word-break: break-all;
}
.detail-card__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.detail-picker {
  min-width: 280px;
}
.detail-body {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.detail-body.is-busy > :not(.detail-overlay) {
  opacity: 0.45;
  pointer-events: none;
}
.detail-overlay {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.detail-overlay .overlay-text {
  font-size: 12.5px;
  color: var(--deploy-fg-secondary);
}
.detail-stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}
.detail-stat {
  border: 1px solid var(--deploy-border);
  border-radius: 10px;
  padding: 9px 12px;
  background: #fafbfc;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.detail-stat span {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--deploy-muted-fg);
}
.detail-stat b {
  font-size: 1.15rem;
  font-weight: 750;
  color: var(--deploy-fg);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}
.detail-stat b.is-bad {
  color: #dc2626;
}
.detail-stat b em {
  font-style: normal;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--deploy-muted-fg);
  margin-left: 3px;
}
.detail-stat b small {
  display: block;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--deploy-muted-fg);
  letter-spacing: 0;
}
.detail-note {
  padding: 8px 12px;
  border-radius: 9px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  font-size: 12px;
  color: #92400e;
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.detail-block {
  border: 1px solid var(--deploy-border);
  border-radius: 11px;
  padding: 11px 13px;
  background: #fff;
  min-width: 0;
}
.detail-block--full {
  grid-column: 1 / -1;
}
.detail-block__title {
  margin: 0 0 8px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--deploy-fg);
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}
.detail-block__note {
  font-style: normal;
  font-size: 11px;
  font-weight: 500;
  color: var(--deploy-muted-fg);
}
.bar-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.bar-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  min-width: 0;
}
.bar-list__key {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  min-width: 46px;
  font-weight: 700;
  color: var(--deploy-fg-secondary);
  font-variant-numeric: tabular-nums;
}
.bar-list__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
.bar-list__track {
  flex: 1 1 auto;
  height: 7px;
  border-radius: 999px;
  background: #eef2f7;
  overflow: hidden;
  min-width: 30px;
}
.bar-list__fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #60a5fa, #3b82f6);
  transition: width 0.35s ease;
}
.bar-list__val {
  flex: none;
  font-weight: 700;
  color: var(--deploy-fg);
  font-variant-numeric: tabular-nums;
  min-width: 40px;
  text-align: right;
}
.bar-list--wide li {
  gap: 10px;
}
.bar-list__path {
  flex: 1 1 auto;
  font-family: var(--deploy-mono);
  font-size: 11.5px;
  color: var(--deploy-fg-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* 近期错误表 */
.err-table-wrap {
  overflow-x: auto;
}
.err-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.err-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--deploy-muted-fg);
  padding: 6px 10px;
  border-bottom: 1px solid var(--deploy-border);
  white-space: nowrap;
}
.err-table td {
  padding: 7px 10px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: middle;
}
.err-table tr:last-child td {
  border-bottom: none;
}
.err-table .col-time {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.err-table .col-status {
  white-space: nowrap;
}
.err-table .col-ms {
  white-space: nowrap;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.err-table .col-path code {
  font-family: var(--deploy-mono);
  font-size: 11.5px;
  color: var(--deploy-fg);
  word-break: break-all;
}
.method-tag {
  display: inline-flex;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--deploy-muted);
  border: 1px solid var(--deploy-border);
  font-family: var(--deploy-mono);
  font-size: 10.5px;
  font-weight: 700;
  color: var(--deploy-fg-secondary);
}
.status-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 38px;
  padding: 2px 7px;
  border-radius: 6px;
  color: #fff;
  font-size: 11px;
  font-weight: 750;
  font-variant-numeric: tabular-nums;
}

/* —— 机器状态 —— */
.machine-card {
  padding: 16px 18px;
}
.machine-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.machine-head-right {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}
.proc-link {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 6px 12px;
  border: 1px solid var(--deploy-border);
  border-radius: 8px;
  background: #fff;
  color: var(--deploy-fg-secondary);
  font-size: 12.5px;
  font-weight: 600;
  text-decoration: none;
  transition: all 0.15s ease;
}
.proc-link:hover {
  border-color: var(--deploy-primary);
  color: var(--deploy-primary);
}
.live-dot {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: #16a34a;
}
.live-dot i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5);
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.45); }
  70% { box-shadow: 0 0 0 7px rgba(34, 197, 94, 0); }
  100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
}
.machine-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.machine-metric {
  border: 1px solid var(--deploy-border);
  border-radius: 12px;
  padding: 12px 14px;
  background: #fafbfc;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.machine-metric__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--deploy-muted-fg);
}
.machine-metric__value {
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--deploy-fg);
  font-variant-numeric: tabular-nums;
}
.machine-metric__value--sm {
  font-size: 1.05rem;
  letter-spacing: 0;
}
.machine-metric__value span {
  font-size: 0.8rem;
  color: var(--deploy-muted-fg);
  margin-left: 2px;
}
.machine-metric__sub {
  font-size: 0.8rem !important;
  font-weight: 600;
}
.machine-metric__foot {
  font-size: 12px;
}
.machine-spark {
  width: 100%;
  height: 42px;
  display: block;
}
.machine-bar {
  height: 6px;
  background: #e2e8f0;
  border-radius: 4px;
  overflow: hidden;
}
.machine-bar__fill {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #2563eb);
  border-radius: 4px;
  transition: width 0.4s ease;
}
.machine-bar__fill--amber {
  background: linear-gradient(90deg, #f59e0b, #d97706);
}
.machine-bar__fill--hot {
  background: linear-gradient(90deg, #ef4444, #dc2626);
}
.machine-collector {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--deploy-border);
  font-size: 12.5px;
  color: var(--deploy-fg-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.machine-collector--bad b {
  color: #dc2626;
}
.machine-collector__path {
  font-size: 11px;
  color: var(--deploy-muted-fg);
}

@media (max-width: 1200px) {
  .detail-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .detail-stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 1100px) {
  .api-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 900px) {
  .kpi-row,
  .machine-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .detail-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .detail-picker {
    min-width: 0;
    flex: 1 1 100%;
  }
}
@media (max-width: 560px) {
  .api-grid,
  .detail-grid {
    grid-template-columns: 1fr;
  }
  .custom-range {
    gap: 8px;
  }
}
</style>

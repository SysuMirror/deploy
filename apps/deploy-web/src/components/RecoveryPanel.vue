<script setup lang="ts">
/**
 * 数据恢复任务面板（管理台 tab）。
 *
 * 从组数据目录里把「已被 rm、但数据块还在」的图片/数据库捞回来并回档：
 * 先只扫磁盘空闲块（不读在用数据）+ 硬限速（不抢其他服务的 I/O），
 * 再用剪出的 SQLite 库里的 sha256 把图对回原记录，写回组目录并归位。
 *
 * 交互骨架照 ModuleObjectStorageView：触发 → 1.5s 轮询 → 进度条 + 阶段 + 日志。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, monitorApi, type RecoveryJob } from '@/services/api';

const modules = ref<{ id: string; name: string }[]>([]);
const moduleId = ref('');
const env = ref<'test' | 'prod'>('prod');
const target = ref<'both' | 'images' | 'db'>('both');
const maxMbps = ref(40);

const jobs = ref<RecoveryJob[]>([]);
const current = ref<RecoveryJob | null>(null);
const logs = ref<string[]>([]);
const error = ref('');
const flash = ref('');
const busy = ref(false);
const loadingList = ref(false);

const PHASES = [
  { key: 'prepare', label: '解析组' },
  { key: 'push_script', label: '下发脚本' },
  { key: 'probe_journal', label: '探测日志' },
  { key: 'scan', label: '扫空闲块' },
  { key: 'restore', label: '对账回档' },
  { key: 'done', label: '完成' },
];

const running = computed(() => jobs.value.filter((j) => j.status === 'running'));

let pollTimer: number | null = null;

function stopPoll() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function applyJob(j: RecoveryJob) {
  current.value = j;
  logs.value = j.logs || [];
  const i = jobs.value.findIndex((x) => x.id === j.id);
  if (i >= 0) jobs.value[i] = j;
  else jobs.value.unshift(j);
}

function watchJob(job: RecoveryJob) {
  stopPoll();
  applyJob(job);
  const tick = async () => {
    try {
      const { job: j } = await api.getRecoveryJob(job.id);
      applyJob(j);
      if (j.status !== 'running') {
        stopPoll();
        if (j.status === 'success' && j.result) {
          flash.value =
            `回档完成：命中 ${j.result.matched} 张、未命中 ${j.result.unmatched} 张、` +
            `孤儿 ${j.result.orphan} 张；库记录 ${j.result.dbRows} 条`;
        }
      }
    } catch (e) {
      // 服务重启后内存任务会丢，属已知行为，不弹错
      console.warn('[recovery] 轮询失败', e);
    }
  };
  void tick();
  pollTimer = window.setInterval(() => void tick(), 1500);
}

async function loadJobs() {
  loadingList.value = true;
  try {
    const { jobs: list } = await api.listRecoveryJobs();
    jobs.value = list;
    const r = list.find((j) => j.status === 'running');
    if (r) watchJob(r);
    else if (!current.value && list.length) applyJob(list[0]);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取任务列表失败';
  } finally {
    loadingList.value = false;
  }
}

async function start() {
  error.value = '';
  flash.value = '';
  if (!moduleId.value) {
    error.value = '请先选择要恢复的模块';
    return;
  }
  if (!window.confirm(
    `将在节点上扫描磁盘空闲块恢复「${moduleId.value}」(${env.value}) 的数据。\n` +
    `全程只读空闲块、限速 ${maxMbps.value}MB/s，不影响在用数据与其他服务。\n` +
    `全盘扫描可能持续数天，可随时停止并保留断点。是否开始？`)) return;
  busy.value = true;
  try {
    const { job } = await api.startRecoveryJob({
      moduleId: moduleId.value, env: env.value, target: target.value, maxMbps: maxMbps.value,
    });
    watchJob(job);
    flash.value = '恢复任务已启动';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '启动失败';
  } finally {
    busy.value = false;
  }
}

async function stopJob(job: RecoveryJob) {
  if (!window.confirm('停止后脚本会在当前分片结束、保存断点后退出；再次启动可续扫。继续？')) return;
  try {
    const r = await api.cancelRecoveryJob(job.id);
    flash.value = r.message || '已请求停止';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '停止失败';
  }
}

function fmtTime(s: string | null) {
  if (!s) return '—';
  return new Date(s).toLocaleString('zh-CN', { hour12: false });
}

onMounted(async () => {
  try {
    const res = await monitorApi.listModules();
    modules.value = (res.modules || []).map((m: any) => ({ id: m.id || m.moduleId, name: m.name || m.moduleName }));
    if (modules.value.length) moduleId.value = modules.value[0].id;
  } catch { /* 模块列表拿不到不阻断，手填即可 */ }
  await loadJobs();
});

onUnmounted(stopPoll);
</script>

<template>
  <div class="rc">
    <SlAlert v-if="error" variant="danger" class="rc__alert">{{ error }}</SlAlert>
    <SlAlert v-if="flash" variant="success" class="rc__alert">{{ flash }}</SlAlert>

    <SlCard class="rc__card">
      <h3 class="rc__title">新建恢复任务</h3>
      <p class="rc__hint">
        只扫描磁盘<strong>空闲块</strong>（不读任何在用数据），并硬限速；
        再按剪出的 SQLite 库中的 <code>sha256</code> 把图片对回原记录后写回组目录。
      </p>
      <div class="rc__form">
        <label>模块
          <select v-model="moduleId">
            <option v-for="m in modules" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
        </label>
        <label>环境
          <select v-model="env">
            <option value="prod">prod</option>
            <option value="test">test</option>
          </select>
        </label>
        <label>范围
          <select v-model="target">
            <option value="both">图片 + 数据库</option>
            <option value="images">仅图片</option>
            <option value="db">仅数据库</option>
          </select>
        </label>
        <label>限速 (MB/s)
          <input v-model.number="maxMbps" type="number" min="5" max="300" step="5" />
        </label>
        <SlButton :busy="busy" @click="start">启动恢复</SlButton>
      </div>
    </SlCard>

    <SlCard class="rc__card">
      <div class="rc__listhead">
        <h3 class="rc__title">任务（在跑 {{ running.length }}）</h3>
        <SlButton variant="ghost" :busy="loadingList" @click="loadJobs">刷新</SlButton>
      </div>
      <SlEmpty v-if="!jobs.length" text="暂无恢复任务" />
      <ul v-else class="rc__jobs">
        <li v-for="j in jobs" :key="j.id"
            :class="['rc__job', { 'rc__job--active': current?.id === j.id }]"
            @click="applyJob(j)">
          <span :class="['rc__pill', `rc__pill--${j.status}`]">{{ j.status }}</span>
          <span class="rc__jobname">{{ j.moduleName }}/{{ j.env }} · {{ j.target }} · {{ j.maxMbps }}MB/s</span>
          <span class="rc__pct">{{ j.percent }}%</span>
          <span class="rc__phase">{{ j.phaseLabel }}</span>
        </li>
      </ul>
    </SlCard>

    <SlCard v-if="current" class="rc__card">
      <div class="rc__listhead">
        <h3 class="rc__title">进度 · {{ current.moduleName }}/{{ current.env }}</h3>
        <SlButton v-if="current.status === 'running'" variant="danger" @click="stopJob(current!)">
          停止
        </SlButton>
      </div>

      <div class="rc__bar" role="progressbar" :aria-valuenow="current.percent">
        <div class="rc__fill" :style="{ width: `${current.percent}%` }" />
      </div>

      <ol class="rc__phases">
        <li v-for="p in PHASES" :key="p.key"
            :class="{ active: current.phase === p.key }">{{ p.label }}</li>
      </ol>

      <p class="rc__meta">
        开始 {{ fmtTime(current.startedAt) }} · 结束 {{ fmtTime(current.finishedAt) }}
        <span v-if="current.group"> · 组 {{ current.group }}</span>
      </p>

      <div v-if="current.result" class="rc__result">
        命中 <b>{{ current.result.matched }}</b> ·
        未命中 {{ current.result.unmatched }} ·
        孤儿 {{ current.result.orphan }} ·
        库记录 {{ current.result.dbRows }} 条
        <span v-if="current.result.dbFile">（库 {{ current.result.dbFile }}）</span>
      </div>

      <pre class="rc__logs">{{ logs.join('\n') }}</pre>
    </SlCard>
  </div>
</template>

<style scoped>
.rc { display: flex; flex-direction: column; gap: 16px; }
.rc__card { padding: 18px; }
.rc__title { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
.rc__hint { margin: 0 0 14px; color: var(--deploy-muted, #64748b); font-size: 13px; line-height: 1.6; }
.rc__hint code { background: var(--deploy-muted, #f1f5f9); padding: 1px 4px; border-radius: 4px; }
.rc__form { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-end; }
.rc__form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--deploy-muted, #64748b); }
.rc__form select, .rc__form input { padding: 6px 8px; border: 1px solid var(--deploy-border, #cbd5e1); border-radius: 6px; font-size: 13px; }
.rc__form input { width: 90px; }
.rc__listhead { display: flex; justify-content: space-between; align-items: center; }
.rc__jobs { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rc__job { display: grid; grid-template-columns: 78px 1fr 56px 110px; gap: 10px; align-items: center;
  padding: 8px 10px; border: 1px solid var(--deploy-border, #e2e8f0); border-radius: 8px; cursor: pointer; font-size: 13px; }
.rc__job--active { border-color: var(--deploy-accent, #6366f1); background: rgba(99, 102, 241, 0.06); }
.rc__jobname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc__pct { text-align: right; font-variant-numeric: tabular-nums; }
.rc__phase { color: var(--deploy-muted, #64748b); }
.rc__pill { text-align: center; border-radius: 999px; padding: 2px 8px; font-size: 11px; }
.rc__pill--running { background: #dbeafe; color: #1d4ed8; }
.rc__pill--success { background: #dcfce7; color: #15803d; }
.rc__pill--failed { background: #fee2e2; color: #b91c1c; }
.rc__pill--cancelled { background: #f1f5f9; color: #475569; }
.rc__bar { height: 10px; border-radius: 999px; background: var(--deploy-muted, #e2e8f0); overflow: hidden; margin: 12px 0; }
.rc__fill { height: 100%; background: var(--deploy-accent, #6366f1); transition: width .35s ease; }
.rc__phases { display: flex; gap: 8px; list-style: none; padding: 0; margin: 0 0 10px; flex-wrap: wrap; }
.rc__phases li { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: var(--deploy-muted, #f1f5f9); color: var(--deploy-muted-fg, #64748b); }
.rc__phases li.active { background: var(--deploy-accent, #6366f1); color: #fff; }
.rc__meta { font-size: 12px; color: var(--deploy-muted, #64748b); margin: 0 0 8px; }
.rc__result { font-size: 13px; margin: 0 0 10px; padding: 8px 10px; border-radius: 8px; background: rgba(34, 197, 94, 0.08); }
.rc__logs { max-height: 300px; overflow: auto; background: #0f172a; color: #e2e8f0;
  padding: 12px; border-radius: 8px; font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
.rc__alert { margin-bottom: 4px; }
</style>

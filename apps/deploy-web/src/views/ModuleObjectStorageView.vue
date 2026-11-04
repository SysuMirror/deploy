<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, type Module } from '@/services/api';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const mod = ref<Module | null>(null);
const loading = ref(true);
const env = ref<'test' | 'prod'>('prod');
const error = ref('');
const flash = ref('');
const logs = ref<string[]>([]);
const busy = ref<'apply' | 'ensure' | 'sync' | 'list' | ''>('');
const syncJob = ref<{
  id: string;
  status: 'running' | 'success' | 'failed';
  phase: string;
  phaseLabel: string;
  percent: number;
  logs: string[];
  error: string;
  result: { bucket: string; files: number; bytes: number; skipped: string[] } | null;
  startedAt: string;
  finishedAt: string | null;
} | null>(null);
const syncElapsedSec = ref(0);
let syncPollTimer: ReturnType<typeof setInterval> | null = null;
let syncElapsedTimer: ReturnType<typeof setInterval> | null = null;

const storage = ref<Awaited<ReturnType<typeof api.getModuleObjectStorage>> | null>(null);

const objectsBusy = ref(false);
const objectsError = ref('');
const objectPrefix = ref('');
const objectListing = ref<{
  bucket: string;
  prefix: string;
  truncated: boolean;
  totalListed: number;
  objects: Array<{ key: string; size: number; lastModified: string | null; etag?: string }>;
} | null>(null);

const credsBusy = ref(false);
const credsError = ref('');
const credentials = ref<Awaited<ReturnType<typeof api.getModuleObjectStorageCredentials>> | null>(
  null
);
const showSecret = ref(false);

const isAdmin = computed(() => Boolean(auth.user?.isPlatformAdmin));
const current = computed(() => storage.value?.current ?? null);
const bindings = computed(() => storage.value?.all ?? []);

const statusLabel: Record<string, string> = {
  none: '未开通',
  provisioned: '已开通',
  synced: '已同步过历史数据',
  orphaned: '模块已删（桶保留）',
};

const bucketReady = computed(() => {
  const s = current.value?.binding?.status;
  return s === 'provisioned' || s === 'synced';
});

/** 主引导：申请 →（开通后）浏览/同步 */
const nextStep = computed<'apply' | 'use' | 'done'>(() => {
  const s = current.value?.binding?.status;
  if (!s || s === 'none' || s === 'orphaned') return 'apply';
  if (s === 'provisioned') return 'use';
  if (s === 'synced') return 'done';
  return 'apply';
});

const nextStepHint = computed(() => {
  switch (nextStep.value) {
    case 'apply':
      return '尚未开通：提交申请，等待平台管理员审批通过后才会建桶并发密钥。';
    case 'use':
      return '桶已开通：可浏览桶内对象；部署组 Running 后可将宿主机历史数据同步进桶。';
    case 'done':
      return '已同步过历史数据。可继续浏览桶内容，或再次同步覆盖。';
    default:
      return '';
  }
});

function fmtMb(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return fmtMb(bytes);
}

function formatTime(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function loadModule() {
  const moduleId = route.params.moduleId as string;
  const res = await api.getModule(moduleId);
  mod.value = res.module;
  const q = String(route.query.env || '');
  if (q === 'test' || q === 'prod') env.value = q;
}

async function refresh() {
  if (!mod.value) return;
  storage.value = await api.getModuleObjectStorage(mod.value.id, env.value);
}

async function refreshAll() {
  await refresh();
  if (bucketReady.value) {
    await loadCredentials();
    await loadObjects();
  } else {
    credentials.value = null;
  }
}

async function loadCredentials() {
  if (!mod.value || !bucketReady.value) {
    credentials.value = null;
    return;
  }
  credsBusy.value = true;
  credsError.value = '';
  try {
    credentials.value = await api.getModuleObjectStorageCredentials(mod.value.id, env.value);
    showSecret.value = false;
  } catch (e) {
    credentials.value = null;
    credsError.value = e instanceof Error ? e.message : '查询密钥失败';
  } finally {
    credsBusy.value = false;
  }
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    flash.value = `已复制 ${label}`;
  } catch {
    error.value = '复制失败，请手动选择文本';
  }
}

async function loadObjects() {
  if (!mod.value || !bucketReady.value) {
    objectListing.value = null;
    return;
  }
  objectsBusy.value = true;
  objectsError.value = '';
  try {
    objectListing.value = await api.listModuleBucketObjects(mod.value.id, env.value, {
      prefix: objectPrefix.value.trim() || undefined,
      limit: 200,
    });
  } catch (e) {
    objectListing.value = null;
    objectsError.value = e instanceof Error ? e.message : '列出桶内容失败';
  } finally {
    objectsBusy.value = false;
  }
}

onMounted(async () => {
  loading.value = true;
  error.value = '';
  try {
    await loadModule();
    await refresh();
    await resumeSyncIfAny();
    if (bucketReady.value) {
      await loadCredentials();
      await loadObjects();
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => stopSyncTimers());

watch(env, async () => {
  error.value = '';
  flash.value = '';
  logs.value = [];
  objectsError.value = '';
  credsError.value = '';
  credentials.value = null;
  showSecret.value = false;
  objectPrefix.value = '';
  objectListing.value = null;
  stopSyncTimers();
  syncJob.value = null;
  busy.value = '';
  router.replace({ query: { ...route.query, env: env.value } });
  try {
    await refresh();
    await resumeSyncIfAny();
    if (bucketReady.value) {
      await loadCredentials();
      await loadObjects();
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '刷新失败';
  }
});

function goBack() {
  if (mod.value) router.push(`/modules/${mod.value.id}`);
  else router.back();
}

async function applyBucket() {
  if (!mod.value) return;
  busy.value = 'apply';
  error.value = '';
  try {
    const r = await api.applyMinioBucket(mod.value.id, env.value);
    flash.value = r.message;
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '申请失败';
  } finally {
    busy.value = '';
  }
}

async function ensureBucketAdmin() {
  if (!mod.value || !isAdmin.value) return;
  if (
    !window.confirm(
      '将幂等补全当前环境的桶与密钥（记审计）。\n确认执行「确保桶存在」？'
    )
  ) {
    return;
  }
  busy.value = 'ensure';
  error.value = '';
  logs.value = [];
  try {
    const r = await api.ensureModuleObjectStorage(mod.value.id, env.value);
    flash.value = r.message;
    logs.value = r.logs || [];
    await refresh();
    if (bucketReady.value) await loadCredentials();
    if (bucketReady.value) await loadObjects();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '强制确保失败';
  } finally {
    busy.value = '';
  }
}

function stopSyncTimers() {
  if (syncPollTimer) {
    clearInterval(syncPollTimer);
    syncPollTimer = null;
  }
  if (syncElapsedTimer) {
    clearInterval(syncElapsedTimer);
    syncElapsedTimer = null;
  }
}

function elapsedFromStarted(startedAt: string) {
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

function watchSyncJob(moduleId: string, job: NonNullable<typeof syncJob.value>) {
  stopSyncTimers();
  syncJob.value = job;
  logs.value = job.logs || [];
  syncElapsedSec.value = elapsedFromStarted(job.startedAt);
  if (job.status !== 'running') {
    busy.value = '';
    return;
  }
  busy.value = 'sync';
  flash.value = '同步任务在后台进行中，可离开页面稍后回来查看进度';
  syncElapsedTimer = setInterval(() => {
    syncElapsedSec.value = elapsedFromStarted(job.startedAt);
  }, 1000);

  const tick = async () => {
    try {
      const { job: j } = await api.getMinioSyncJob(moduleId, job.id);
      syncJob.value = j;
      logs.value = j.logs || [];
      syncElapsedSec.value = elapsedFromStarted(j.startedAt);
      if (j.status === 'success') {
        stopSyncTimers();
        busy.value = '';
        flash.value = j.result
          ? `已同步 ${j.result.files} 个文件到桶 ${j.result.bucket}`
          : '同步完成';
        await refresh();
        await loadObjects();
        return;
      }
      if (j.status === 'failed') {
        stopSyncTimers();
        busy.value = '';
        error.value = j.error || '同步失败';
      }
    } catch (e) {
      console.warn('[object-storage] poll sync job', e);
    }
  };
  void tick();
  syncPollTimer = setInterval(() => {
    void tick();
  }, 1500);
}

async function resumeSyncIfAny() {
  if (!mod.value) return;
  try {
    const { job } = await api.getLatestMinioSyncJob(mod.value.id, env.value);
    if (!job) return;
    if (job.status === 'running' || job.logs?.length) {
      watchSyncJob(mod.value.id, job);
      if (job.status === 'failed' && job.error) error.value = job.error;
      if (job.status === 'success' && job.result) {
        flash.value = `已同步 ${job.result.files} 个文件到桶 ${job.result.bucket}`;
      }
    }
  } catch {
    /* ignore */
  }
}

async function syncHistory() {
  if (!mod.value) return;
  if (!bucketReady.value) {
    error.value = '请先申请并通过审批后再同步';
    return;
  }
  if (busy.value === 'sync' || syncJob.value?.status === 'running') {
    flash.value = '已有同步任务在进行，进度见下方';
    return;
  }
  if (
    !window.confirm(
      `将「${env.value === 'prod' ? '正式' : '测试'}」环境宿主机历史数据同步到 MinIO 桶。\n` +
        `要求：该环境组已 Running，且对象存储已审批开通。\n` +
        `注意：桶不会因删组而删除。\n` +
        `任务在后台执行，可离开本页稍后回来看进度。\n继续？`
    )
  ) {
    return;
  }
  error.value = '';
  flash.value = '';
  logs.value = [];
  syncJob.value = null;
  try {
    const started = await api.syncModuleObjectStorage(mod.value.id, env.value, true);
    watchSyncJob(mod.value.id, started.job);
  } catch (e) {
    busy.value = '';
    error.value = e instanceof Error ? e.message : '同步失败';
  }
}
</script>

<template>
  <div v-if="loading" class="page-loading"><SlSpinner /></div>

  <div v-else-if="mod" class="os-page">
    <button type="button" class="page-back" @click="goBack">← 返回模块 {{ mod.name }}</button>

    <header class="page-hero">
      <div class="page-hero__main">
        <h1 class="page-hero__title">对象存储</h1>
        <p class="page-hero__desc">
          按环境查看绑定状态与桶内对象。开通须走审批；平台管理员才可强制建桶。
        </p>
      </div>
    </header>

    <div class="list-panel__tabs os-tabs">
      <button
        type="button"
        class="list-panel__tab"
        :class="{ 'list-panel__tab--active': env === 'test' }"
        @click="env = 'test'"
      >
        测试环境
      </button>
      <button
        type="button"
        class="list-panel__tab"
        :class="{ 'list-panel__tab--active': env === 'prod' }"
        @click="env = 'prod'"
      >
        正式环境
      </button>
    </div>

    <SlAlert v-if="error" variant="error" class="mb-3">{{ error }}</SlAlert>
    <SlAlert v-if="flash" variant="success" class="mb-3">{{ flash }}</SlAlert>

    <section v-if="current" class="os-card">
      <h2 class="os-card__title">当前环境</h2>
      <p class="os-next-hint">{{ nextStepHint }}</p>
      <dl class="os-kv">
        <div>
          <dt>桶名</dt>
          <dd><code>{{ current.bucket }}</code></dd>
        </div>
        <div>
          <dt>密钥标签</dt>
          <dd><code>{{ current.keyLabel }}</code>（须等于组名才会注入）</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>
            {{
              statusLabel[current.binding?.status || 'none'] ||
              current.binding?.status ||
              '未开通'
            }}
          </dd>
        </div>
        <div>
          <dt>宿主机历史数据</dt>
          <dd>
            约 {{ current.hostFiles }} 文件 / {{ fmtMb(current.hostApproxBytes) }}
            <br />
            <code class="os-path">{{ current.hostDataDir }}</code>
          </dd>
        </div>
        <div v-if="current.binding?.createdAt">
          <dt>开通时间</dt>
          <dd>{{ formatTime(current.binding.createdAt) }}</dd>
        </div>
        <div v-if="current.binding?.lastSyncAt">
          <dt>上次同步</dt>
          <dd>
            {{ current.binding.lastSyncFiles }} 文件 /
            {{ fmtMb(current.binding.lastSyncBytes) }} ·
            {{ formatTime(current.binding.lastSyncAt) }}
          </dd>
        </div>
      </dl>
      <p class="os-policy">{{ current.policy.note }}</p>
      <p v-if="current.binding?.lastError" class="os-err">{{ current.binding.lastError }}</p>
    </section>

    <section class="os-card">
      <h2 class="os-card__title">开通与同步</h2>
      <ol class="os-steps">
        <li :class="{ 'os-steps__current': nextStep === 'apply' }">
          <strong>申请开通</strong>
          ：提交后由平台管理员审批；通过后自动建桶并发密钥。
          <span v-if="nextStep === 'apply'" class="os-steps__badge">进行中</span>
          <span v-else class="os-steps__done">已完成</span>
        </li>
        <li :class="{ 'os-steps__current': nextStep === 'use' || nextStep === 'done' }">
          <strong>部署该环境</strong>
          ：组 Running 后注入 <code>MINIO_*</code>；同步也要求组已 Running。
        </li>
        <li :class="{ 'os-steps__current': nextStep === 'use' }">
          <strong>同步历史数据</strong>
          （可选）：把宿主机 MODULE_DATA 上传到桶。
          <span v-if="nextStep === 'use'" class="os-steps__badge">可选</span>
          <span v-else-if="nextStep === 'done'" class="os-steps__done">已同步过</span>
        </li>
      </ol>
      <div class="os-actions">
        <SlButton
          :variant="nextStep === 'apply' ? 'primary' : 'secondary'"
          :disabled="Boolean(busy)"
          @click="applyBucket"
        >
          {{ busy === 'apply' ? '提交中…' : '申请对象存储' }}
        </SlButton>
        <SlButton
          :variant="nextStep === 'use' ? 'primary' : 'secondary'"
          :disabled="Boolean(busy) || !bucketReady"
          @click="syncHistory"
        >
          {{ busy === 'sync' ? '同步中…' : '同步历史数据到桶' }}
        </SlButton>
        <SlButton variant="secondary" :disabled="Boolean(busy)" @click="refreshAll">
          刷新状态
        </SlButton>
      </div>
    </section>

    <section v-if="bucketReady" class="os-card">
      <div class="os-browser__head">
        <h2 class="os-card__title">连接凭证</h2>
        <SlButton variant="secondary" :disabled="credsBusy" @click="loadCredentials">
          {{ credsBusy ? '查询中…' : '刷新凭证' }}
        </SlButton>
      </div>
      <SlAlert v-if="credsError" variant="error" class="mb-3">{{ credsError }}</SlAlert>
      <p v-if="credentials && !credentials.found" class="muted">
        未在 sseinfra 面板找到标签为 <code>{{ credentials.keyLabel }}</code> 的密钥。请确认已审批开通或联系管理员发密钥。
      </p>
      <template v-else-if="credentials?.credentials">
        <p v-if="credentials.keysForLabel.length > 1" class="os-creds-warn muted">
          同标签存在 {{ credentials.keysForLabel.length }} 组密钥，下列为默认使用的第一组；其余见教师面板。
        </p>
        <dl class="os-kv">
          <div>
            <dt>MINIO_ENDPOINT</dt>
            <dd>
              <code>{{ credentials.endpoint }}</code>
              <span class="muted"> · {{ credentials.endpointNote }}</span>
            </dd>
          </div>
          <div>
            <dt>MINIO_BUCKET</dt>
            <dd><code>{{ credentials.credentials.bucket }}</code></dd>
          </div>
          <div>
            <dt>MINIO_ACCESS_KEY</dt>
            <dd class="os-cred-row">
              <code>{{ credentials.credentials.accessKey }}</code>
              <button type="button" class="os-copy" @click="copyText(credentials.credentials!.accessKey, 'Access Key')">
                复制
              </button>
            </dd>
          </div>
          <div>
            <dt>MINIO_SECRET</dt>
            <dd class="os-cred-row">
              <code>{{ showSecret ? credentials.credentials.secret : '••••••••••••' }}</code>
              <button type="button" class="os-copy" @click="showSecret = !showSecret">
                {{ showSecret ? '隐藏' : '显示' }}
              </button>
              <button
                type="button"
                class="os-copy"
                @click="copyText(credentials.credentials!.secret, 'Secret')"
              >
                复制
              </button>
            </dd>
          </div>
        </dl>
        <p class="os-policy muted">
          来源：{{ credentials.source === 'panel' ? 'sseinfra 存储面板' : 'GPU minio_keys.json' }}。
          部署组 Running 后上述四元组会注入进程环境；本地调试可手动配置。
        </p>
      </template>
      <div v-else-if="credsBusy" class="os-browser__loading"><SlSpinner /></div>
    </section>

    <section v-if="bucketReady" class="os-card">
      <div class="os-browser__head">
        <h2 class="os-card__title">桶内容</h2>
        <div class="os-browser__tools">
          <input
            v-model="objectPrefix"
            class="os-prefix"
            type="text"
            placeholder="前缀过滤，如 uploads/"
            @keydown.enter="loadObjects"
          />
          <SlButton
            variant="secondary"
            :disabled="objectsBusy"
            @click="loadObjects"
          >
            {{ objectsBusy ? '加载中…' : '刷新列表' }}
          </SlButton>
        </div>
      </div>
      <SlAlert v-if="objectsError" variant="error" class="mb-3">{{ objectsError }}</SlAlert>
      <p v-if="objectListing" class="os-browser__meta muted">
        桶 <code>{{ objectListing.bucket }}</code>
        · 本页 {{ objectListing.objects.length }} 条
        <template v-if="objectListing.truncated">（已截断，请缩小前缀）</template>
      </p>
      <div v-if="objectsBusy && !objectListing" class="os-browser__loading">
        <SlSpinner />
      </div>
      <div v-else-if="objectListing" class="ct-table-wrap">
        <table class="deploy-table">
          <thead>
            <tr>
              <th>对象键</th>
              <th>大小</th>
              <th>修改时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!objectListing.objects.length">
              <td colspan="3" class="muted">桶为空，或前缀无匹配</td>
            </tr>
            <tr v-for="o in objectListing.objects" :key="o.key">
              <td><code class="os-key">{{ o.key }}</code></td>
              <td>{{ fmtBytes(o.size) }}</td>
              <td>{{ formatTime(o.lastModified) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-else class="os-card os-card--muted">
      <h2 class="os-card__title">桶内容</h2>
      <p class="muted">审批通过并开通后，可在此浏览该环境桶内对象。</p>
    </section>

    <section v-if="syncJob" class="os-card os-progress">
      <h2 class="os-card__title">同步进度</h2>
      <div class="os-progress__meta">
        <span>{{ syncJob.phaseLabel }}</span>
        <span>{{ syncJob.percent }}%</span>
        <span class="muted">已用时 {{ syncElapsedSec }}s</span>
        <span
          :class="{
            'os-progress__ok': syncJob.status === 'success',
            'os-progress__bad': syncJob.status === 'failed',
          }"
        >
          {{
            syncJob.status === 'running'
              ? '进行中'
              : syncJob.status === 'success'
                ? '成功'
                : '失败'
          }}
        </span>
      </div>
      <div class="os-progress__bar" role="progressbar" :aria-valuenow="syncJob.percent">
        <div class="os-progress__fill" :style="{ width: `${syncJob.percent}%` }" />
      </div>
      <ol class="os-progress__phases">
        <li :class="{ active: ['ensure', 'queued'].includes(syncJob.phase) }">补全桶</li>
        <li :class="{ active: syncJob.phase === 'check_group' }">检查组</li>
        <li :class="{ active: syncJob.phase === 'push_host' }">推送数据</li>
        <li :class="{ active: syncJob.phase === 'creds' }">注入密钥</li>
        <li :class="{ active: syncJob.phase === 'upload' }">上传到桶</li>
        <li :class="{ active: syncJob.phase === 'done' || syncJob.status === 'success' }">完成</li>
      </ol>
    </section>

    <section v-if="logs.length" class="os-card">
      <h2 class="os-card__title">最近操作日志</h2>
      <pre class="os-logs">{{ logs.join('\n') }}</pre>
    </section>

    <section v-if="bindings.length" class="os-card">
      <h2 class="os-card__title">本模块全部环境</h2>
      <div class="ct-table-wrap">
        <table class="deploy-table">
          <thead>
            <tr>
              <th>环境</th>
              <th>桶</th>
              <th>状态</th>
              <th>开通时间</th>
              <th>上次同步</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in bindings" :key="b.env">
              <td>{{ b.env === 'prod' ? '正式' : '测试' }}</td>
              <td><code>{{ b.bucket }}</code></td>
              <td>{{ statusLabel[b.status] || b.status }}</td>
              <td>{{ formatTime(b.createdAt) }}</td>
              <td>
                <template v-if="b.lastSyncAt">
                  {{ b.lastSyncFiles }} 文件 / {{ fmtMb(b.lastSyncBytes) }}
                  <span class="muted"> · {{ formatTime(b.lastSyncAt) }}</span>
                </template>
                <span v-else class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="isAdmin" class="os-card">
      <h2 class="os-card__title">运维工具</h2>
      <p class="os-tools-desc muted">
        幂等补全当前环境的桶与密钥（审计记录）。与上方申请流程无关，一般用于排查或补救。
      </p>
      <SlButton variant="secondary" :disabled="Boolean(busy)" @click="ensureBucketAdmin">
        {{ busy === 'ensure' ? '处理中…' : '确保桶存在' }}
      </SlButton>
    </section>
  </div>

  <div v-else class="page-loading">
    <SlAlert variant="error">模块不存在或无权访问</SlAlert>
  </div>
</template>

<style scoped>
.os-page {
  max-width: 960px;
}
.os-tabs {
  margin-bottom: 16px;
}
.os-card {
  margin-bottom: 16px;
  padding: 16px 18px;
  border: 1px solid var(--deploy-border);
  border-radius: 10px;
  background: var(--deploy-bg-elevated, var(--deploy-bg));
}
.os-card--muted {
  background: color-mix(in srgb, var(--deploy-muted, #e5e7eb) 35%, transparent);
}
.os-card__title {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
}
.os-kv {
  display: grid;
  gap: 10px 24px;
  margin: 0;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
}
.os-kv dt {
  font-size: 12px;
  color: var(--deploy-fg-secondary);
  margin-bottom: 2px;
}
.os-kv dd {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
}
.os-path {
  font-size: 11px;
  word-break: break-all;
}
.os-policy {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
  line-height: 1.5;
}
.os-err {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--deploy-danger, #c0392b);
}
.os-steps {
  margin: 0 0 14px;
  padding-left: 1.2em;
  font-size: 13px;
  line-height: 1.65;
  color: var(--deploy-fg-secondary);
}
.os-steps strong {
  color: var(--deploy-fg);
}
.os-steps__current {
  color: var(--deploy-fg);
}
.os-steps__badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  background: var(--deploy-accent, #2563eb);
  vertical-align: middle;
}
.os-steps__done {
  display: inline-block;
  margin-left: 6px;
  font-size: 11px;
  color: var(--deploy-fg-secondary);
  vertical-align: middle;
}
.os-next-hint {
  margin: 0 0 12px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.45;
  background: color-mix(in srgb, var(--deploy-accent, #2563eb) 10%, transparent);
  color: var(--deploy-fg);
}
.os-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.os-tools-desc {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.45;
}
.os-creds-warn {
  margin: 0 0 10px;
  font-size: 12px;
}
.os-cred-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.os-copy {
  padding: 2px 8px;
  border: 1px solid var(--deploy-border);
  border-radius: 4px;
  font-size: 11px;
  background: var(--deploy-bg);
  color: var(--deploy-fg-secondary);
  cursor: pointer;
}
.os-copy:hover {
  color: var(--deploy-accent, #2563eb);
  border-color: var(--deploy-accent, #2563eb);
}
.os-browser__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.os-browser__head .os-card__title {
  margin-bottom: 0;
}
.os-browser__tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.os-prefix {
  min-width: 180px;
  padding: 6px 10px;
  border: 1px solid var(--deploy-border);
  border-radius: 6px;
  font-size: 13px;
  background: var(--deploy-bg);
  color: var(--deploy-fg);
}
.os-browser__meta {
  margin: 0 0 10px;
  font-size: 12px;
}
.os-browser__loading {
  padding: 24px;
  text-align: center;
}
.os-key {
  font-size: 12px;
  word-break: break-all;
}
.os-progress__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  margin-bottom: 10px;
  font-size: 13px;
}
.os-progress__ok {
  color: #15803d;
  font-weight: 600;
}
.os-progress__bad {
  color: var(--deploy-danger, #c0392b);
  font-weight: 600;
}
.os-progress__bar {
  height: 10px;
  border-radius: 999px;
  background: var(--deploy-muted, #e5e7eb);
  overflow: hidden;
}
.os-progress__fill {
  height: 100%;
  border-radius: inherit;
  background: var(--deploy-accent, #2563eb);
  transition: width 0.35s ease;
}
.os-progress__phases {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  font-size: 12px;
}
.os-progress__phases li {
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--deploy-border);
  color: var(--deploy-fg-secondary);
}
.os-progress__phases li.active {
  border-color: var(--deploy-accent, #2563eb);
  color: var(--deploy-accent, #2563eb);
  background: color-mix(in srgb, var(--deploy-accent, #2563eb) 10%, transparent);
  font-weight: 600;
}
.os-logs {
  margin: 0;
  max-height: 280px;
  overflow: auto;
  padding: 12px;
  border-radius: 8px;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
.mb-3 {
  margin-bottom: 12px;
}
.muted {
  color: var(--deploy-fg-secondary);
}
</style>

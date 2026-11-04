<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import {
  api,
  type Application,
  type DockerContainer,
  type DockerDiskUsage,
  type DockerImage,
  type DockerNetwork,
  type DockerSystemInfo,
  type DockerVolume,
  type PlatformAdmin,
} from '@/services/api';
import RecoveryPanel from '@/components/RecoveryPanel.vue';

const props = defineProps<{ tab?: string }>();
const route = useRoute();
const auth = useAuthStore();

type TabKey = 'approvals' | 'audit' | 'containers' | 'images' | 'volumes' | 'networks' | 'system' | 'admins' | 'recovery';

const VALID_TABS = new Set<TabKey>([
  'approvals',
  'audit',
  'containers',
  'images',
  'volumes',
  'networks',
  'system',
  'admins',
  'recovery',
]);

function normalizeTab(raw?: string): TabKey {
  const t = String(raw || 'approvals') as TabKey;
  return VALID_TABS.has(t) ? t : 'approvals';
}

const tab = ref<TabKey>(normalizeTab(props.tab || (route.params.tab as string)));
const loading = ref(true);
const error = ref('');
const busy = ref(false);
const flash = ref('');

// —— 审批 ——
const applications = ref<Application[]>([]);

// —— 审计 ——
const auditLogs = ref<
  Awaited<ReturnType<typeof api.listAuditLogs>>['logs']
>([]);

// —— 容器 ——
const containers = ref<DockerContainer[]>([]);
const selectedContainers = ref<Set<string>>(new Set());

// —— 镜像 ——
const images = ref<DockerImage[]>([]);
const selectedImages = ref<Set<string>>(new Set());

// —— 数据卷 ——
const volumes = ref<DockerVolume[]>([]);
const selectedVolumes = ref<Set<string>>(new Set());

// —— 网络 ——
const networks = ref<DockerNetwork[]>([]);
const selectedNetworks = ref<Set<string>>(new Set());

// —— 概览 ——
const systemInfo = ref<DockerSystemInfo | null>(null);
const systemDisk = ref<DockerDiskUsage[]>([]);
const objectStorageBindings = ref<
  Awaited<ReturnType<typeof api.listAdminObjectStorage>>['bindings']
>([]);
const objectStoragePolicy = ref('');

// —— 平台管理员 ——
const admins = ref<PlatformAdmin[]>([]);
const adminQuery = ref('');
const adminOAuthId = ref('');

// —— 平台设置 ——
const agentFixerEnabled = ref(false);
const agentFixerConfigured = ref(false);
const aiEndpoints = ref<
  Awaited<ReturnType<typeof api.listAiEndpoints>>['endpoints']
>([]);
const aiActiveId = ref<string | null>(null);
const aiLlmConfigured = ref(false);
const aiForm = ref({
  label: '',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-v4-flash',
  format: 'openai' as 'openai' | 'vllm',
});
const aiBusy = ref(false);
const baseDomain = ref('');
const pathMode = ref<'root' | 'subpath'>('root');
const settingsLoading = ref(false);

const sseinfraForm = ref({
  baseUrl: 'http://ssemarket.cn:24000',
  username: '',
  password: '',
  groupPrefix: 'sdpy',
  sshHost: 'ssemarket.cn',
  sshUser: 'root',
  giteeToken: '',
  clearPassword: false,
  clearGiteeToken: false,
  defaultCpu: '2',
  defaultMem: '4Gi',
  defaultStorage: '10',
});
const sseinfraMeta = ref<{
  configured: boolean;
  username: string;
  usernameSource: string;
  usernameEnvLocked: boolean;
  passwordSource: string;
  passwordEnvLocked: boolean;
  maskedPassword: string | null;
  hasGiteeToken: boolean;
  giteeTokenEnvLocked: boolean;
  maskedGiteeToken: string | null;
  cpuEnvLocked?: boolean;
  memEnvLocked?: boolean;
  storageEnvLocked?: boolean;
} | null>(null);
const sseinfraBusy = ref(false);

// —— 二次确认浮窗 ——
const confirmState = ref<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  action: (() => Promise<void>) | null;
}>({ open: false, title: '', message: '', confirmLabel: '确认', danger: false, action: null });

const typeLabel: Record<string, string> = {
  create_project: '创建项目',
  join_project: '加入项目',
  create_module: '创建模块',
  join_module: '加入模块',
  minio_bucket: '对象存储桶',
};

const diskTypeLabel: Record<string, string> = {
  Images: '镜像',
  Containers: '容器',
  'Local Volumes': '数据卷',
  'Build Cache': '构建缓存',
};

const isAdmin = computed(() => Boolean(auth.user?.isPlatformAdmin));

const tabTitle: Record<TabKey, string> = {
  approvals: '审批',
  containers: '容器',
  images: '镜像',
  volumes: '数据卷',
  networks: '网络',
  audit: '审计',
  system: '系统概览',
  admins: '管理员与设置',
  recovery: '数据恢复',
};

// —— 加载 ——
async function loadApprovals() {
  const res = await api.listApplications(false);
  applications.value = res.applications;
}

async function loadAudit() {
  const res = await api.listAuditLogs({ limit: 150 });
  auditLogs.value = res.logs;
}

async function loadContainers() {
  const res = await api.listContainers();
  containers.value = res.containers;
  selectedContainers.value = new Set();
}

async function loadImages() {
  const res = await api.listImages();
  images.value = res.images;
  selectedImages.value = new Set();
}

async function loadVolumes() {
  const res = await api.listVolumes();
  volumes.value = res.volumes;
  selectedVolumes.value = new Set();
}

async function loadNetworks() {
  const res = await api.listNetworks();
  networks.value = res.networks;
  selectedNetworks.value = new Set();
}

async function loadSystem() {
  const res = await api.getSystem();
  systemInfo.value = res.info;
  systemDisk.value = res.disk;
  try {
    const os = await api.listAdminObjectStorage();
    objectStorageBindings.value = os.bindings;
    objectStoragePolicy.value = os.policy || '';
  } catch {
    objectStorageBindings.value = [];
    objectStoragePolicy.value = '';
  }
}

async function loadAdmins() {
  const a = await api.listAdmins();
  admins.value = a.admins;
}

async function loadSettings() {
  const s = await api.getSettings();
  agentFixerEnabled.value = s.agentFixerEnabled;
  agentFixerConfigured.value = s.agentFixerConfigured;
  baseDomain.value = s.baseDomain;
  pathMode.value = s.rootMode ? 'root' : 'subpath';
  try {
    const ai = await api.listAiEndpoints();
    aiEndpoints.value = ai.endpoints;
    aiActiveId.value = ai.activeId;
    aiLlmConfigured.value = ai.llmConfigured;
  } catch {
    aiEndpoints.value = [];
  }
  try {
    const { sseinfra } = await api.getSseinfraSettings();
    sseinfraForm.value.baseUrl = sseinfra.baseUrl;
    sseinfraForm.value.username = sseinfra.username || '';
    sseinfraForm.value.groupPrefix = sseinfra.groupPrefix;
    sseinfraForm.value.sshHost = sseinfra.sshHost;
    sseinfraForm.value.sshUser = sseinfra.sshUser;
    sseinfraForm.value.password = '';
    sseinfraForm.value.giteeToken = '';
    sseinfraForm.value.clearPassword = false;
    sseinfraForm.value.clearGiteeToken = false;
    sseinfraForm.value.defaultCpu = sseinfra.defaultCpu || '2';
    sseinfraForm.value.defaultMem = sseinfra.defaultMem || '4Gi';
    sseinfraForm.value.defaultStorage = sseinfra.defaultStorage || '10';
    sseinfraMeta.value = {
      configured: sseinfra.configured,
      username: sseinfra.username || '',
      usernameSource: sseinfra.usernameSource,
      usernameEnvLocked: sseinfra.usernameEnvLocked,
      passwordSource: sseinfra.passwordSource,
      passwordEnvLocked: sseinfra.passwordEnvLocked,
      maskedPassword: sseinfra.maskedPassword,
      hasGiteeToken: sseinfra.hasGiteeToken,
      giteeTokenEnvLocked: sseinfra.giteeTokenEnvLocked,
      maskedGiteeToken: sseinfra.maskedGiteeToken,
      cpuEnvLocked: sseinfra.cpuEnvLocked,
      memEnvLocked: sseinfra.memEnvLocked,
      storageEnvLocked: sseinfra.storageEnvLocked,
    };
  } catch {
    sseinfraMeta.value = null;
  }
}

async function saveSseinfra() {
  sseinfraBusy.value = true;
  error.value = '';
  try {
    const { sseinfra } = await api.saveSseinfraSettings({
      baseUrl: sseinfraForm.value.baseUrl.trim(),
      username: sseinfraForm.value.username.trim(),
      groupPrefix: sseinfraForm.value.groupPrefix.trim(),
      sshHost: sseinfraForm.value.sshHost.trim(),
      sshUser: sseinfraForm.value.sshUser.trim(),
      password: sseinfraForm.value.password.trim() || undefined,
      clearPassword: sseinfraForm.value.clearPassword,
      giteeToken: sseinfraForm.value.giteeToken.trim() || undefined,
      clearGiteeToken: sseinfraForm.value.clearGiteeToken,
      defaultCpu: sseinfraForm.value.defaultCpu.trim(),
      defaultMem: sseinfraForm.value.defaultMem.trim(),
      defaultStorage: sseinfraForm.value.defaultStorage.trim(),
    });
    sseinfraForm.value.password = '';
    sseinfraForm.value.giteeToken = '';
    sseinfraForm.value.clearPassword = false;
    sseinfraForm.value.clearGiteeToken = false;
    sseinfraForm.value.defaultCpu = sseinfra.defaultCpu || '2';
    sseinfraForm.value.defaultMem = sseinfra.defaultMem || '4Gi';
    sseinfraForm.value.defaultStorage = sseinfra.defaultStorage || '10';
    sseinfraMeta.value = {
      configured: sseinfra.configured,
      username: sseinfra.username || '',
      usernameSource: sseinfra.usernameSource,
      usernameEnvLocked: sseinfra.usernameEnvLocked,
      passwordSource: sseinfra.passwordSource,
      passwordEnvLocked: sseinfra.passwordEnvLocked,
      maskedPassword: sseinfra.maskedPassword,
      hasGiteeToken: sseinfra.hasGiteeToken,
      giteeTokenEnvLocked: sseinfra.giteeTokenEnvLocked,
      maskedGiteeToken: sseinfra.maskedGiteeToken,
      cpuEnvLocked: sseinfra.cpuEnvLocked,
      memEnvLocked: sseinfra.memEnvLocked,
      storageEnvLocked: sseinfra.storageEnvLocked,
    };
    flash.value = '已保存 sseinfra 配置';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败';
  } finally {
    sseinfraBusy.value = false;
  }
}

async function testSseinfraLogin() {
  sseinfraBusy.value = true;
  error.value = '';
  try {
    const res = await api.testSseinfraLogin({
      baseUrl: sseinfraForm.value.baseUrl.trim(),
      username: sseinfraForm.value.username.trim(),
      groupPrefix: sseinfraForm.value.groupPrefix.trim(),
      sshHost: sseinfraForm.value.sshHost.trim(),
      sshUser: sseinfraForm.value.sshUser.trim(),
      password: sseinfraForm.value.password.trim() || undefined,
    });
    const s = res.sseinfra;
    sseinfraForm.value.password = '';
    sseinfraMeta.value = {
      configured: s.configured,
      username: s.username || '',
      usernameSource: s.usernameSource,
      usernameEnvLocked: s.usernameEnvLocked,
      passwordSource: s.passwordSource,
      passwordEnvLocked: s.passwordEnvLocked,
      maskedPassword: s.maskedPassword,
      hasGiteeToken: s.hasGiteeToken,
      giteeTokenEnvLocked: s.giteeTokenEnvLocked,
      maskedGiteeToken: s.maskedGiteeToken,
      cpuEnvLocked: s.cpuEnvLocked,
      memEnvLocked: s.memEnvLocked,
      storageEnvLocked: s.storageEnvLocked,
    };
    flash.value = res.message || '登录成功';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '登录失败';
  } finally {
    sseinfraBusy.value = false;
  }
}

async function saveAiEndpoint() {
  if (!aiForm.value.label.trim() || !aiForm.value.baseUrl.trim() || !aiForm.value.model.trim()) {
    flash.value = '请填写名称、baseUrl、model';
    return;
  }
  if (aiForm.value.format === 'openai' && !aiForm.value.apiKey.trim()) {
    flash.value = 'OpenAI / DeepSeek 兼容格式需要填写 apiKey';
    return;
  }
  aiBusy.value = true;
  try {
    await api.createAiEndpoint({
      label: aiForm.value.label.trim(),
      baseUrl: aiForm.value.baseUrl.trim(),
      apiKey: aiForm.value.apiKey.trim() || undefined,
      model: aiForm.value.model.trim(),
      format: aiForm.value.format,
    });
    aiForm.value.apiKey = '';
    await loadSettings();
    flash.value = '已添加 AI 端点';
  } catch (e) {
    flash.value = e instanceof Error ? e.message : '添加失败';
  } finally {
    aiBusy.value = false;
  }
}

/** DeepSeek 官方 OpenAI 兼容预设，见 https://api-docs.deepseek.com/zh-cn/ */
function applyDeepseekPreset(model: 'deepseek-v4-flash' | 'deepseek-v4-pro') {
  aiForm.value = {
    label: model === 'deepseek-v4-pro' ? 'DeepSeek V4 Pro' : 'DeepSeek V4 Flash',
    baseUrl: 'https://api.deepseek.com',
    apiKey: aiForm.value.apiKey,
    model,
    format: 'openai',
  };
  flash.value = '已填入 DeepSeek 预设，请粘贴 API Key 后点「添加」，再点「设为当前」';
}

function applyVllmPreset() {
  aiForm.value = {
    label: '本地 vLLM',
    baseUrl: 'http://127.0.0.1:8000/v1',
    apiKey: '',
    model: '',
    format: 'vllm',
  };
}

async function activateAiEndpoint(id: string) {
  aiBusy.value = true;
  try {
    const ai = await api.setActiveAiEndpoint(id);
    aiEndpoints.value = ai.endpoints;
    aiActiveId.value = ai.activeId;
    aiLlmConfigured.value = ai.llmConfigured;
    flash.value = '已设为当前 Agent 端点';
  } catch (e) {
    flash.value = e instanceof Error ? e.message : '设置失败';
  } finally {
    aiBusy.value = false;
  }
}

async function removeAiEndpoint(id: string) {
  aiBusy.value = true;
  try {
    await api.deleteAiEndpoint(id);
    await loadSettings();
    flash.value = '已删除端点';
  } catch (e) {
    flash.value = e instanceof Error ? e.message : '删除失败';
  } finally {
    aiBusy.value = false;
  }
}

async function loadTabData(t: TabKey) {
  loading.value = true;
  error.value = '';
  try {
    if (t === 'approvals') await loadApprovals();
    else if (t === 'audit') await loadAudit();
    else if (t === 'containers') await loadContainers();
    else if (t === 'images') await loadImages();
    else if (t === 'volumes') await loadVolumes();
    else if (t === 'networks') await loadNetworks();
    else if (t === 'system') await loadSystem();
    else if (t === 'admins') await Promise.all([loadAdmins(), loadSettings()]);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

/** 后台预加载各资源数量用于选项卡角标（失败静默，不阻塞首屏） */
async function preloadCounts() {
  const jobs: Promise<void>[] = [loadContainers().catch(() => {})];
  if (isAdmin.value) {
    jobs.push(loadImages().catch(() => {}), loadVolumes().catch(() => {}), loadNetworks().catch(() => {}));
  }
  await Promise.all(jobs);
}

onMounted(async () => {
  tab.value = normalizeTab(props.tab || (route.params.tab as string));
  loading.value = true;
  error.value = '';
  try {
    await loadTabData(tab.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
  void preloadCounts();
});

watch(
  () => [props.tab, route.params.tab] as const,
  ([p, r]) => {
    const next = normalizeTab(p || (r as string));
    if (next !== tab.value) {
      tab.value = next;
      void loadTabData(next);
    }
  }
);

// —— 操作包装 / 二次确认 ——
async function runBusy(action: () => Promise<void>) {
  busy.value = true;
  error.value = '';
  try {
    await action();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败';
  } finally {
    busy.value = false;
  }
}

function askConfirm(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  action: () => Promise<void>;
}) {
  confirmState.value = {
    open: true,
    title: opts.title,
    message: opts.message,
    confirmLabel: opts.confirmLabel || '确认',
    danger: opts.danger ?? false,
    action: opts.action,
  };
}

function closeConfirm() {
  confirmState.value.open = false;
  confirmState.value.action = null;
}

async function runConfirm() {
  const action = confirmState.value.action;
  confirmState.value.open = false;
  confirmState.value.action = null;
  if (!action) return;
  await action();
}

// —— 选择辅助（返回新 Set，配合模板内 ref 赋值） ——
function toggleInSet(cur: Set<string>, id: string): Set<string> {
  const next = new Set(cur);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function toggleAllInSet(cur: Set<string>, ids: string[]): Set<string> {
  if (ids.length > 0 && cur.size === ids.length) return new Set<string>();
  return new Set(ids);
}

// —— 容器操作 ——
function doContainerAction(verb: 'start' | 'stop' | 'restart') {
  if (!selectedContainers.value.size) return;
  const conf: Record<string, { title: string; message: string; danger: boolean }> = {
    start: { title: '启动容器', message: `确认启动选中的 ${selectedContainers.value.size} 个容器？`, danger: false },
    stop: { title: '停止容器', message: `确认停止选中的 ${selectedContainers.value.size} 个容器？运行中的容器将被停止。`, danger: true },
    restart: { title: '重启容器', message: `确认重启选中的 ${selectedContainers.value.size} 个容器？`, danger: true },
  };
  const { title, message, danger } = conf[verb];
  askConfirm({
    title,
    message,
    confirmLabel: title,
    danger,
    action: () =>
      runBusy(async () => {
        const res =
          verb === 'start'
            ? await api.startContainers([...selectedContainers.value])
            : verb === 'stop'
              ? await api.stopContainers([...selectedContainers.value])
              : await api.restartContainers([...selectedContainers.value]);
        flash.value = `已完成 ${res.ok.length} 个` + (res.errors.length ? `；失败 ${res.errors.length}` : '');
        await loadContainers();
      }),
  });
}

function deleteSelectedContainers() {
  if (!selectedContainers.value.size) return;
  askConfirm({
    title: '删除容器',
    message: `确认删除选中的 ${selectedContainers.value.size} 个容器？此操作不可撤销，运行中的容器会被强制停止。`,
    confirmLabel: '删除',
    danger: true,
    action: () =>
      runBusy(async () => {
        const res = await api.deleteContainers([...selectedContainers.value]);
        flash.value = `已删除 ${res.removed.length} 个` + (res.errors.length ? `；失败 ${res.errors.length}` : '');
        await loadContainers();
      }),
  });
}

function pruneUnusedContainers() {
  askConfirm({
    title: '清理无用容器',
    message: '清空已退出（且属于 sdpy）的容器？运行中的容器不会被删除。',
    confirmLabel: '清理',
    danger: true,
    action: () =>
      runBusy(async () => {
        const res = await api.pruneContainers({ onlySdpy: true, includeRunning: false });
        flash.value = `已清理 ${res.removed.length} 个无用容器`;
        await loadContainers();
      }),
  });
}

// —— 镜像操作 ——
function imageRef(i: DockerImage): string {
  if (i.dangling || i.tag === '<none>') return i.id;
  return `${i.repository}:${i.tag}`;
}

function deleteSelectedImages() {
  if (!selectedImages.value.size) return;
  askConfirm({
    title: '删除镜像',
    message: `确认删除选中的 ${selectedImages.value.size} 个镜像？被运行中容器使用的镜像会删除失败，删除会释放磁盘空间。`,
    confirmLabel: '删除',
    danger: true,
    action: () =>
      runBusy(async () => {
        const res = await api.deleteImages([...selectedImages.value]);
        flash.value = `已删除 ${res.removed.length} 个` + (res.errors.length ? `；失败 ${res.errors.length}` : '');
        await loadImages();
      }),
  });
}

function pruneDanglingImages() {
  askConfirm({
    title: '清理悬空镜像',
    message: '清理未被任何标签引用的悬空镜像（docker image prune）？正在使用的镜像不受影响。',
    confirmLabel: '清理',
    danger: true,
    action: () =>
      runBusy(async () => {
        const res = await api.pruneImages();
        flash.value = `${res.message}${res.reclaimed ? `：${res.reclaimed}` : ''}`;
        await loadImages();
      }),
  });
}

// —— 数据卷操作 ——
function deleteSelectedVolumes() {
  if (!selectedVolumes.value.size) return;
  askConfirm({
    title: '删除数据卷',
    message: `确认删除选中的 ${selectedVolumes.value.size} 个数据卷？卷内数据将被永久删除，被容器占用的卷会删除失败。`,
    confirmLabel: '删除',
    danger: true,
    action: () =>
      runBusy(async () => {
        const res = await api.deleteVolumes([...selectedVolumes.value]);
        flash.value = `已删除 ${res.removed.length} 个` + (res.errors.length ? `；失败 ${res.errors.length}` : '');
        await loadVolumes();
      }),
  });
}

function pruneUnusedVolumes() {
  askConfirm({
    title: '清理数据卷',
    message: '清理未被任何容器引用的匿名数据卷（docker volume prune）？',
    confirmLabel: '清理',
    danger: true,
    action: () =>
      runBusy(async () => {
        const res = await api.pruneVolumes();
        flash.value = `${res.message}${res.reclaimed ? `：${res.reclaimed}` : ''}`;
        await loadVolumes();
      }),
  });
}

// —— 网络操作 ——
function deleteSelectedNetworks() {
  if (!selectedNetworks.value.size) return;
  askConfirm({
    title: '删除网络',
    message: `确认删除选中的 ${selectedNetworks.value.size} 个网络？被容器使用的网络会删除失败。`,
    confirmLabel: '删除',
    danger: true,
    action: () =>
      runBusy(async () => {
        const res = await api.deleteNetworks([...selectedNetworks.value]);
        flash.value = `已删除 ${res.removed.length} 个` + (res.errors.length ? `；失败 ${res.errors.length}` : '');
        await loadNetworks();
      }),
  });
}

function pruneUnusedNetworks() {
  askConfirm({
    title: '清理网络',
    message: '清理未被任何容器使用的网络（docker network prune）？',
    confirmLabel: '清理',
    danger: true,
    action: () =>
      runBusy(async () => {
        const res = await api.pruneNetworks();
        flash.value = `${res.message}${res.reclaimed ? `：${res.reclaimed}` : ''}`;
        await loadNetworks();
      }),
  });
}

function pruneBuildCache() {
  askConfirm({
    title: '清理构建缓存',
    message: '清理 Docker 构建缓存（docker builder prune）？仅影响构建缓存，不影响已构建镜像。',
    confirmLabel: '清理',
    danger: true,
    action: () =>
      runBusy(async () => {
        const res = await api.pruneBuilder();
        flash.value = `${res.message}${res.reclaimed ? `：${res.reclaimed}` : ''}`;
        await loadSystem();
      }),
  });
}

// —— 网关 / 审批 / 管理员 ——
function reloadGw() {
  askConfirm({
    title: '重载网关',
    message: '重新生成 nginx 路由并 reload 网关？',
    confirmLabel: '重载',
    action: () =>
      runBusy(async () => {
        const res = await api.reloadGateway();
        flash.value = res.message;
      }),
  });
}

async function review(app: Application, decision: 'approved' | 'rejected') {
  busy.value = true;
  error.value = '';
  try {
    await api.reviewApplication(app.id, decision);
    flash.value = decision === 'approved' ? '已通过' : '已拒绝';
    await loadApprovals();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '审核失败';
  } finally {
    busy.value = false;
  }
}

async function toggleAgentFixer() {
  if (!isAdmin.value) return;
  settingsLoading.value = true;
  error.value = '';
  try {
    const s = await api.updateSettings({ agentFixerEnabled: !agentFixerEnabled.value });
    agentFixerEnabled.value = s.agentFixerEnabled;
    agentFixerConfigured.value = s.agentFixerConfigured;
    flash.value = s.agentFixerEnabled ? '已开启 Agent 自愈' : '已关闭 Agent 自愈';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '更新设置失败';
  } finally {
    settingsLoading.value = false;
  }
}

async function savePathMode() {
  if (!isAdmin.value) return;
  settingsLoading.value = true;
  error.value = '';
  try {
    const s = await api.updateSettings({
      publicBasePath: pathMode.value === 'root' ? '' : '/sdpy',
    });
    baseDomain.value = s.baseDomain;
    pathMode.value = s.rootMode ? 'root' : 'subpath';
    flash.value = '已更新挂载路径，网关路由已重载';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '更新挂载路径失败';
  } finally {
    settingsLoading.value = false;
  }
}

async function saveBaseDomain() {
  if (!isAdmin.value) return;
  const domain = baseDomain.value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  if (!domain) {
    error.value = '请填写主域名';
    return;
  }
  settingsLoading.value = true;
  error.value = '';
  try {
    const s = await api.updateSettings({ baseDomain: domain });
    baseDomain.value = s.baseDomain;
    flash.value = '已保存主域名';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存主域名失败';
  } finally {
    settingsLoading.value = false;
  }
}

async function addAdmin() {
  const oauthId = adminOAuthId.value.trim();
  const userQuery = adminQuery.value.trim();
  if (!oauthId && !userQuery) {
    error.value = '请填写 OAuth ID 或用户邮箱 / 用户名';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const res = await api.addAdmin(oauthId ? { oauthId } : { userQuery });
    admins.value = res.admins;
    adminOAuthId.value = '';
    adminQuery.value = '';
    flash.value = '已添加管理员';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '添加失败';
  } finally {
    busy.value = false;
  }
}

function removeAdmin(a: PlatformAdmin) {
  askConfirm({
    title: '移除管理员',
    message: `确认移除管理员「${a.name || a.oauthId}」？`,
    confirmLabel: '移除',
    danger: true,
    action: () =>
      runBusy(async () => {
        const res = await api.removeAdmin(a.oauthId);
        admins.value = res.admins;
        flash.value = '已移除管理员';
      }),
  });
}

// —— 格式化 ——
function stateBadge(state: string) {
  if (state === 'running') return 'status-badge--success';
  if (state === 'exited' || state === 'dead') return 'status-badge--failed';
  return 'status-badge--pending';
}

function formatUptime(sec?: number) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}天${h}时`;
  if (h) return `${h}时${m}分`;
  return `${m}分`;
}

function formatTime(iso?: string) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN');
  } catch {
    return iso;
  }
}

function formatBytes(bytes?: number) {
  if (!bytes) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${bytes} B`;
}
</script>

<template>
  <div class="admin-page">
    <header class="page-hero">
      <div class="page-hero__main">
        <p class="admin-kicker">管理台</p>
        <h1 class="page-hero__title">{{ tabTitle[tab] }}</h1>
        <p class="page-hero__desc">左侧切换板块；平台设置在「管理员」页。</p>
      </div>
      <div class="page-hero__actions">
        <SlButton variant="secondary" size="sm" :disabled="busy" @click="reloadGw">
          重载网关
        </SlButton>
      </div>
    </header>

    <SlAlert v-if="flash" variant="success" class="mb">{{ flash }}</SlAlert>
    <SlAlert v-if="error" variant="error" class="mb">{{ error }}</SlAlert>

    <div class="admin-shell list-panel">
      <div class="admin-shell__tabs--hidden" aria-hidden="true" />


      <div class="admin-shell__body">
        <div v-if="loading" class="page-loading"><SlSpinner /></div>

        <template v-else-if="tab === 'approvals'">
      <div v-if="!applications.length" class="empty-inline">
        <p>暂无待审申请</p>
      </div>
      <div v-else class="app-list">
        <div v-for="a in applications" :key="a.id" class="app-row">
          <div>
            <div class="app-row__title">
              <strong>{{ typeLabel[a.type] || a.type }}</strong>
              <span class="muted">{{ a.applicantName || a.applicantId }}</span>
            </div>
            <div class="app-row__meta">
              <span v-if="a.projectName">项目 {{ a.projectName }}</span>
              <span v-if="a.moduleName || a.payload?.name">模块 {{ a.moduleName || a.payload?.name }}</span>
              <span>{{ formatTime(a.createdAt) }}</span>
            </div>
          </div>
          <div class="app-row__actions">
            <SlButton size="sm" variant="primary" :disabled="busy" @click="review(a, 'approved')">通过</SlButton>
            <SlButton size="sm" variant="secondary" :disabled="busy" @click="review(a, 'rejected')">拒绝</SlButton>
          </div>
        </div>
      </div>
    </template>

    <template v-else-if="tab === 'audit'">
      <div class="ct-toolbar">
        <SlButton size="sm" variant="secondary" :disabled="busy" @click="loadAudit">刷新</SlButton>
        <span class="muted">谁申请了啥、审批、建组/删组均记入此表</span>
      </div>
      <div v-if="!auditLogs.length" class="empty-inline">
        <p>暂无审计记录</p>
      </div>
      <div v-else class="admin-list">
        <div v-for="row in auditLogs" :key="row.id" class="admin-row">
          <div class="admin-row__main">
            <div class="admin-row__title">
              <strong>{{ row.summary }}</strong>
              <span class="pkg-tag pkg-tag--muted">{{ row.action }}</span>
            </div>
            <div class="admin-row__meta">
              <span>{{ row.actorName || row.actorId || '系统' }}</span>
              <span>{{ row.targetType }}:{{ row.targetId }}</span>
              <span>{{ formatTime(row.createdAt) }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>

    <template v-else-if="tab === 'containers'">
      <div class="ct-toolbar">
        <SlButton size="sm" variant="secondary" :disabled="busy" @click="loadContainers">刷新</SlButton>
        <template v-if="isAdmin">
          <SlButton size="sm" variant="secondary" :disabled="busy || !selectedContainers.size" @click="doContainerAction('start')">
            启动 ({{ selectedContainers.size }})
          </SlButton>
          <SlButton size="sm" variant="secondary" :disabled="busy || !selectedContainers.size" @click="doContainerAction('stop')">
            停止 ({{ selectedContainers.size }})
          </SlButton>
          <SlButton size="sm" variant="secondary" :disabled="busy || !selectedContainers.size" @click="doContainerAction('restart')">
            重启 ({{ selectedContainers.size }})
          </SlButton>
        </template>
        <SlButton size="sm" variant="danger" :disabled="busy || !selectedContainers.size" @click="deleteSelectedContainers">
          删除选中 ({{ selectedContainers.size }})
        </SlButton>
        <SlButton size="sm" variant="secondary" :disabled="busy" @click="pruneUnusedContainers">一键清空无用容器</SlButton>
      </div>

      <div v-if="!containers.length" class="empty-inline">暂无容器</div>
      <div v-else class="ct-table-wrap">
        <table class="deploy-table">
          <thead>
            <tr>
              <th class="cell-check">
                <input
                  type="checkbox"
                  :checked="selectedContainers.size === containers.length && containers.length > 0"
                  @change="selectedContainers = toggleAllInSet(selectedContainers, containers.map((c) => c.id))"
                />
              </th>
              <th>容器名</th>
              <th>状态</th>
              <th>创建 / 启动</th>
              <th>存活</th>
              <th>镜像</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in containers" :key="c.id">
              <td class="cell-check">
                <input
                  type="checkbox"
                  :checked="selectedContainers.has(c.id)"
                  @change="selectedContainers = toggleInSet(selectedContainers, c.id)"
                />
              </td>
              <td>
                <code class="ct-name">{{ c.name }}</code>
                <span v-if="c.isSdpy" class="pkg-tag">sdpy</span>
              </td>
              <td><span class="status-badge" :class="stateBadge(c.state)">{{ c.status }}</span></td>
              <td class="muted sm">{{ formatTime(c.startedAt || c.createdAt) }}</td>
              <td>{{ formatUptime(c.uptimeSeconds) }}</td>
              <td class="muted sm">{{ c.image }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else-if="tab === 'images'">
      <div class="ct-toolbar">
        <SlButton size="sm" variant="secondary" :disabled="busy" @click="loadImages">刷新</SlButton>
        <SlButton size="sm" variant="danger" :disabled="busy || !selectedImages.size" @click="deleteSelectedImages">
          删除选中 ({{ selectedImages.size }})
        </SlButton>
        <SlButton size="sm" variant="secondary" :disabled="busy" @click="pruneDanglingImages">清理悬空镜像</SlButton>
      </div>

      <div v-if="!images.length" class="empty-inline">暂无镜像</div>
      <div v-else class="ct-table-wrap">
        <table class="deploy-table">
          <thead>
            <tr>
              <th class="cell-check">
                <input
                  type="checkbox"
                  :checked="selectedImages.size === images.length && images.length > 0"
                  @change="selectedImages = toggleAllInSet(selectedImages, images.map((i) => imageRef(i)))"
                />
              </th>
              <th>镜像</th>
              <th>标签</th>
              <th>大小</th>
              <th>创建</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in images" :key="`${i.id}:${i.repository}:${i.tag}`">
              <td class="cell-check">
                <input
                  type="checkbox"
                  :checked="selectedImages.has(imageRef(i))"
                  @change="selectedImages = toggleInSet(selectedImages, imageRef(i))"
                />
              </td>
              <td>
                <span v-if="i.dangling" class="status-badge status-badge--failed">悬空</span>
                <code v-else class="ct-name">{{ i.repository }}</code>
              </td>
              <td><code v-if="!i.dangling" class="ct-name">{{ i.tag }}</code><span v-else class="muted sm">—</span></td>
              <td>{{ i.size }}</td>
              <td class="muted sm">{{ i.createdSince }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else-if="tab === 'volumes'">
      <div class="ct-toolbar">
        <SlButton size="sm" variant="secondary" :disabled="busy" @click="loadVolumes">刷新</SlButton>
        <SlButton size="sm" variant="danger" :disabled="busy || !selectedVolumes.size" @click="deleteSelectedVolumes">
          删除选中 ({{ selectedVolumes.size }})
        </SlButton>
        <SlButton size="sm" variant="secondary" :disabled="busy" @click="pruneUnusedVolumes">清理无主数据卷</SlButton>
      </div>

      <div v-if="!volumes.length" class="empty-inline">暂无数据卷</div>
      <div v-else class="ct-table-wrap">
        <table class="deploy-table">
          <thead>
            <tr>
              <th class="cell-check">
                <input
                  type="checkbox"
                  :checked="selectedVolumes.size === volumes.length && volumes.length > 0"
                  @change="selectedVolumes = toggleAllInSet(selectedVolumes, volumes.map((v) => v.name))"
                />
              </th>
              <th>名称</th>
              <th>驱动</th>
              <th>挂载点</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in volumes" :key="v.name">
              <td class="cell-check">
                <input
                  type="checkbox"
                  :checked="selectedVolumes.has(v.name)"
                  @change="selectedVolumes = toggleInSet(selectedVolumes, v.name)"
                />
              </td>
              <td>
                <code class="ct-name">{{ v.name }}</code>
                <span v-if="v.isSdpy" class="pkg-tag">sdpy</span>
              </td>
              <td>{{ v.driver }}</td>
              <td class="muted sm">{{ v.mountpoint }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else-if="tab === 'networks'">
      <div class="ct-toolbar">
        <SlButton size="sm" variant="secondary" :disabled="busy" @click="loadNetworks">刷新</SlButton>
        <SlButton size="sm" variant="danger" :disabled="busy || !selectedNetworks.size" @click="deleteSelectedNetworks">
          删除选中 ({{ selectedNetworks.size }})
        </SlButton>
        <SlButton size="sm" variant="secondary" :disabled="busy" @click="pruneUnusedNetworks">清理未使用网络</SlButton>
      </div>

      <div v-if="!networks.length" class="empty-inline">暂无网络</div>
      <div v-else class="ct-table-wrap">
        <table class="deploy-table">
          <thead>
            <tr>
              <th class="cell-check">
                <input
                  type="checkbox"
                  :checked="selectedNetworks.size === networks.length && networks.length > 0"
                  @change="selectedNetworks = toggleAllInSet(selectedNetworks, networks.map((n) => n.name))"
                />
              </th>
              <th>名称</th>
              <th>驱动</th>
              <th>范围</th>
              <th>内网</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="n in networks" :key="n.id">
              <td class="cell-check">
                <input
                  type="checkbox"
                  :checked="selectedNetworks.has(n.name)"
                  @change="selectedNetworks = toggleInSet(selectedNetworks, n.name)"
                />
              </td>
              <td>
                <code class="ct-name">{{ n.name }}</code>
                <span v-if="n.isSdpy" class="pkg-tag">sdpy</span>
              </td>
              <td>{{ n.driver }}</td>
              <td>{{ n.scope }}</td>
              <td>{{ n.internal ? '是' : '否' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else-if="tab === 'system'">
      <div class="ct-toolbar">
        <SlButton size="sm" variant="secondary" :disabled="busy" @click="loadSystem">刷新</SlButton>
        <SlButton size="sm" variant="secondary" :disabled="busy" @click="pruneBuildCache">清理构建缓存</SlButton>
      </div>

      <div v-if="systemInfo" class="sys-grid">
        <div class="sys-card">
          <div class="sys-card__label">容器</div>
          <div class="sys-card__value">
            {{ systemInfo.containersRunning }}<span class="sys-card__unit">/ {{ systemInfo.containers }} 运行</span>
          </div>
        </div>
        <div class="sys-card">
          <div class="sys-card__label">镜像</div>
          <div class="sys-card__value">{{ systemInfo.images }}</div>
        </div>
        <div class="sys-card">
          <div class="sys-card__label">CPU</div>
          <div class="sys-card__value">{{ systemInfo.ncpu }}<span class="sys-card__unit">核</span></div>
        </div>
        <div class="sys-card">
          <div class="sys-card__label">内存</div>
          <div class="sys-card__value">{{ formatBytes(systemInfo.memTotalBytes) }}</div>
        </div>
      </div>

      <div v-if="systemInfo" class="sys-meta">
        <span>Docker {{ systemInfo.serverVersion }}</span>
        <span>{{ systemInfo.operatingSystem }}</span>
        <span>{{ systemInfo.architecture }}</span>
        <span v-if="systemInfo.dockerRootDir">Root {{ systemInfo.dockerRootDir }}</span>
      </div>

      <div v-if="systemDisk.length" class="ct-table-wrap sys-disk">
        <table class="deploy-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>数量</th>
              <th>占用</th>
              <th>可回收</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in systemDisk" :key="d.type">
              <td>{{ diskTypeLabel[d.type] || d.type }}</td>
              <td>{{ d.totalCount }}<span class="muted sm">（活跃 {{ d.active }}）</span></td>
              <td>{{ d.size }}</td>
              <td>{{ d.reclaimable }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="sys-minio">
        <h3 class="sys-minio__title">模块对象存储（MinIO）</h3>
        <p class="sys-minio__policy">{{ objectStoragePolicy || '桶随模块保留；平台不提供删桶。' }}</p>
        <div v-if="objectStorageBindings.length" class="ct-table-wrap">
          <table class="deploy-table">
            <thead>
              <tr>
                <th>模块 ID</th>
                <th>环境</th>
                <th>桶</th>
                <th>密钥标签</th>
                <th>状态</th>
                <th>上次同步</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in objectStorageBindings" :key="`${b.moduleId}-${b.env}`">
                <td><code>{{ b.moduleId }}</code></td>
                <td>{{ b.env }}</td>
                <td><code>{{ b.bucket }}</code></td>
                <td><code>{{ b.keyLabel }}</code></td>
                <td>{{ b.status }}</td>
                <td>
                  <template v-if="b.lastSyncAt">
                    {{ b.lastSyncFiles }} 文件 / {{ formatBytes(b.lastSyncBytes) }}
                    <span class="muted sm">{{ b.lastSyncAt }}</span>
                  </template>
                  <span v-else class="muted">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">暂无模块桶绑定记录。</p>
      </div>
    </template>
    <template v-else-if="tab === 'admins'">
      <div class="admin-stack">
        <section class="admin-card">
          <header class="admin-card__head">
            <h2 class="admin-card__title">sseinfra 面板登录</h2>
            <p class="admin-card__desc">
              部署到 K8s 时用 Cookie + CSRF 登录控制面板（用户名 + 密码）。优先环境变量；未设 env 时可在此填写并「测试登录」。
            </p>
          </header>

          <div class="settings-list">
            <div class="settings-row settings-row--stack">
              <div class="settings-row__main">
                <div class="settings-row__label">面板地址</div>
                <div class="settings-row__desc">默认 http://ssemarket.cn:24000</div>
              </div>
              <SlInput v-model="sseinfraForm.baseUrl" placeholder="http://ssemarket.cn:24000" />
            </div>
            <div class="settings-row settings-row--stack">
              <div class="settings-row__main">
                <div class="settings-row__label">面板账号</div>
                <div class="settings-row__desc">
                  <template v-if="sseinfraMeta?.usernameEnvLocked">
                    已由环境变量锁定（{{ sseinfraMeta.username }}）
                  </template>
                  <template v-else-if="sseinfraMeta?.username">
                    已配置（{{ sseinfraMeta.username }} · {{ sseinfraMeta.usernameSource }}）
                  </template>
                  <template v-else>面板登录须填写用户名</template>
                </div>
              </div>
              <SlInput
                v-model="sseinfraForm.username"
                placeholder="用户名"
                :disabled="Boolean(sseinfraMeta?.usernameEnvLocked)"
                autocomplete="username"
              />
            </div>
            <div class="settings-row settings-row--stack">
              <div class="settings-row__main">
                <div class="settings-row__label">面板密码</div>
                <div class="settings-row__desc">
                  <template v-if="sseinfraMeta?.passwordEnvLocked">
                    已由环境变量锁定（{{ sseinfraMeta.maskedPassword }}），表单不可改。
                  </template>
                  <template v-else-if="sseinfraMeta?.maskedPassword">
                    已配置（{{ sseinfraMeta.maskedPassword }} · {{ sseinfraMeta.passwordSource }}）。留空保存则保留原值。
                  </template>
                  <template v-else>尚未配置，部署前请填写。</template>
                </div>
              </div>
              <SlInput
                v-model="sseinfraForm.password"
                type="password"
                :disabled="Boolean(sseinfraMeta?.passwordEnvLocked)"
                :placeholder="sseinfraMeta?.passwordEnvLocked ? '环境变量已锁定' : '输入面板密码'"
              />
              <label
                v-if="!sseinfraMeta?.passwordEnvLocked && sseinfraMeta?.maskedPassword"
                class="sseinfra-clear"
              >
                <input v-model="sseinfraForm.clearPassword" type="checkbox" />
                清除已存密码
              </label>
            </div>
            <div class="settings-row settings-row--stack">
              <div class="settings-row__main">
                <div class="settings-row__label">组名前缀</div>
                <div class="settings-row__desc">组名形如 {前缀}-{模块}-t|p</div>
              </div>
              <SlInput v-model="sseinfraForm.groupPrefix" placeholder="sdpy" />
            </div>
            <div class="settings-row settings-row--stack">
              <div class="settings-row__main">
                <div class="settings-row__label">新建组默认规格</div>
                <div class="settings-row__desc">
                  测试/正式各一组，规格相同；仅新建生效。环境变量 SSEINFRA_DEFAULT_* 可锁定。
                </div>
              </div>
              <div class="settings-domain">
                <SlInput
                  v-model="sseinfraForm.defaultCpu"
                  placeholder="CPU 如 2"
                  :disabled="Boolean(sseinfraMeta?.cpuEnvLocked)"
                  class="settings-domain__input"
                />
                <SlInput
                  v-model="sseinfraForm.defaultMem"
                  placeholder="内存 如 4Gi"
                  :disabled="Boolean(sseinfraMeta?.memEnvLocked)"
                  class="settings-domain__input"
                />
                <SlInput
                  v-model="sseinfraForm.defaultStorage"
                  placeholder="存储 Gi 如 10"
                  :disabled="Boolean(sseinfraMeta?.storageEnvLocked)"
                  class="settings-domain__input"
                />
              </div>
            </div>
            <div class="settings-row settings-row--stack">
              <div class="settings-row__main">
                <div class="settings-row__label">SSH 跳板（压缩包传 Pod）</div>
                <div class="settings-row__desc">用户 / 主机，密码同面板密码</div>
              </div>
              <div class="settings-domain">
                <SlInput v-model="sseinfraForm.sshUser" placeholder="root" class="settings-domain__input" />
                <SlInput v-model="sseinfraForm.sshHost" placeholder="ssemarket.cn" class="settings-domain__input" />
              </div>
            </div>
            <div class="settings-row settings-row--stack">
              <div class="settings-row__main">
                <div class="settings-row__label">平台 Gitee Token（可选）</div>
                <div class="settings-row__desc">
                  <template v-if="sseinfraMeta?.giteeTokenEnvLocked">环境变量已锁定</template>
                  <template v-else-if="sseinfraMeta?.hasGiteeToken">
                    已配置 {{ sseinfraMeta.maskedGiteeToken }}
                  </template>
                  <template v-else>私有仓部署时可注入</template>
                </div>
              </div>
              <SlInput
                v-model="sseinfraForm.giteeToken"
                type="password"
                :disabled="Boolean(sseinfraMeta?.giteeTokenEnvLocked)"
                placeholder="留空保留原值"
              />
              <label
                v-if="!sseinfraMeta?.giteeTokenEnvLocked && sseinfraMeta?.hasGiteeToken"
                class="sseinfra-clear"
              >
                <input v-model="sseinfraForm.clearGiteeToken" type="checkbox" />
                清除 Token
              </label>
            </div>
          </div>

          <div class="sseinfra-actions">
            <SlButton size="sm" variant="primary" :disabled="sseinfraBusy" @click="saveSseinfra">
              {{ sseinfraBusy ? '…' : '保存' }}
            </SlButton>
            <SlButton size="sm" variant="secondary" :disabled="sseinfraBusy" @click="testSseinfraLogin">
              测试登录
            </SlButton>
            <span
              class="sseinfra-status"
              :class="sseinfraMeta?.configured ? 'sseinfra-status--ok' : 'sseinfra-status--warn'"
            >
              {{ sseinfraMeta?.configured ? '身份已配置' : '身份未配置' }}
            </span>
          </div>
        </section>

        <section class="admin-card">
          <header class="admin-card__head">
            <h2 class="admin-card__title">平台设置</h2>
            <p class="admin-card__desc">Agent、挂载路径与主域名</p>
          </header>

          <div class="settings-list">
            <label class="settings-row">
              <div class="settings-row__main">
                <div class="settings-row__label">Agent 自愈部署</div>
                <div class="settings-row__desc">
                  部署失败时可由 AI 修补构建文件并重试；亦可生成 deploy.sh。
                  <span v-if="!agentFixerConfigured && !aiLlmConfigured" class="settings-row__warn">
                    未配置 LLM，请先添加下方端点。
                  </span>
                </div>
              </div>
              <input
                type="checkbox"
                class="settings-row__switch"
                :checked="agentFixerEnabled"
                :disabled="settingsLoading"
                @change="toggleAgentFixer"
              />
            </label>

            <label class="settings-row">
              <div class="settings-row__main">
                <div class="settings-row__label">挂载路径</div>
                <div class="settings-row__desc">新模块默认根路径或 /sdpy 前缀（仅 compose 网关）。</div>
              </div>
              <select
                v-model="pathMode"
                class="settings-select"
                :disabled="settingsLoading"
                @change="savePathMode"
              >
                <option value="root">根路径（/）</option>
                <option value="subpath">/sdpy 前缀</option>
              </select>
            </label>

            <div class="settings-row settings-row--stack">
              <div class="settings-row__main">
                <div class="settings-row__label">主域名</div>
                <div class="settings-row__desc">模块公网地址使用的域名。</div>
              </div>
              <div class="settings-domain">
                <SlInput v-model="baseDomain" placeholder="ssemarket.cn" class="settings-domain__input" />
                <SlButton size="sm" variant="primary" :disabled="settingsLoading" @click="saveBaseDomain">
                  保存
                </SlButton>
              </div>
            </div>
          </div>
        </section>

        <section class="admin-card">
          <header class="admin-card__head">
            <h2 class="admin-card__title">AI / DeepSeek / vLLM</h2>
            <p class="admin-card__desc">
              部署 Agent 共用「当前」端点。推荐
              <a
                href="https://api-docs.deepseek.com/zh-cn/"
                target="_blank"
                rel="noopener noreferrer"
              >DeepSeek OpenAI 兼容 API</a>
              （支持 Tool Calls）。自建 vLLM 需自身支持 tools，否则会报 xgrammar 等错误。
            </p>
          </header>

          <div class="ai-preset-bar">
            <SlButton size="sm" variant="secondary" :disabled="aiBusy" @click="applyDeepseekPreset('deepseek-v4-flash')">
              预设 DeepSeek Flash
            </SlButton>
            <SlButton size="sm" variant="secondary" :disabled="aiBusy" @click="applyDeepseekPreset('deepseek-v4-pro')">
              预设 DeepSeek Pro
            </SlButton>
            <SlButton size="sm" variant="secondary" :disabled="aiBusy" @click="applyVllmPreset">
              预设本地 vLLM
            </SlButton>
          </div>

          <div class="ai-form">
            <SlInput v-model="aiForm.label" placeholder="显示名" />
            <select v-model="aiForm.format" class="settings-select">
              <option value="openai">OpenAI / DeepSeek 兼容（需 Key）</option>
              <option value="vllm">vLLM（Key 可选）</option>
            </select>
            <SlInput
              v-model="aiForm.baseUrl"
              :placeholder="
                aiForm.format === 'openai'
                  ? 'https://api.deepseek.com'
                  : 'http://127.0.0.1:8000/v1'
              "
            />
            <SlInput
              v-model="aiForm.model"
              :placeholder="aiForm.format === 'openai' ? 'deepseek-v4-flash' : 'model 名'"
            />
            <SlInput
              v-model="aiForm.apiKey"
              :placeholder="
                aiForm.format === 'vllm' ? 'apiKey（可选）' : 'DeepSeek / OpenAI API Key（必填）'
              "
              type="password"
            />
            <SlButton size="sm" variant="primary" :disabled="aiBusy" @click="saveAiEndpoint">
              添加
            </SlButton>
          </div>
          <p class="muted settings-hint">
            DeepSeek：base_url=<code>https://api.deepseek.com</code>，model=<code>deepseek-v4-flash</code>
            或 <code>deepseek-v4-pro</code>；Key 在
            <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer"
              >platform.deepseek.com</a
            >
            申请。也可 env：<code>DEEPSEEK_API_KEY</code> / <code>AGENT_FIXER_*</code>。
          </p>

          <div v-if="!aiEndpoints.length" class="empty-inline empty-inline--inset">暂无自定义端点</div>
          <div v-else class="admin-list">
            <div v-for="ep in aiEndpoints" :key="ep.id" class="admin-row">
              <div class="admin-row__main">
                <div class="admin-row__title">
                  <strong>{{ ep.label }}</strong>
                  <span v-if="ep.isActive" class="pkg-tag">当前</span>
                  <span class="pkg-tag pkg-tag--muted">{{ ep.format }}</span>
                </div>
                <div class="admin-row__meta">
                  <code>{{ ep.baseUrl }}</code>
                  <span>{{ ep.model }}</span>
                  <span v-if="ep.maskedKey">{{ ep.maskedKey }}</span>
                  <span v-else class="muted">无 Key</span>
                </div>
              </div>
              <div class="admin-row__actions">
                <SlButton
                  size="sm"
                  variant="secondary"
                  :disabled="aiBusy || ep.isActive"
                  @click="activateAiEndpoint(ep.id)"
                >
                  设为当前
                </SlButton>
                <SlButton
                  size="sm"
                  variant="secondary"
                  class="danger-outline"
                  :disabled="aiBusy"
                  @click="removeAiEndpoint(ep.id)"
                >
                  删除
                </SlButton>
              </div>
            </div>
          </div>
        </section>

        <section class="admin-card">
          <header class="admin-card__head">
            <h2 class="admin-card__title">平台管理员</h2>
            <p class="admin-card__desc">
              可审批申请、管理容器与网关。初始可由
              <code>PLATFORM_ADMIN_OAUTH_IDS</code> 引导。
            </p>
          </header>

          <div class="admin-add">
            <SlInput v-model="adminOAuthId" placeholder="OAuth ID（如 561）" class="admin-add__field" />
            <SlInput v-model="adminQuery" placeholder="或 用户邮箱 / 用户名" class="admin-add__field" />
            <SlButton size="sm" variant="primary" :disabled="busy" @click="addAdmin">添加</SlButton>
          </div>

          <div v-if="!admins.length" class="empty-inline empty-inline--inset">暂无管理员</div>
          <div v-else class="admin-list">
            <div v-for="a in admins" :key="a.oauthId" class="admin-row">
              <div class="admin-row__main">
                <div class="admin-row__title">
                  <strong>{{ a.name || '（未登录用户）' }}</strong>
                  <span v-if="!a.name" class="pkg-tag">待登录</span>
                </div>
                <div class="admin-row__meta">
                  <code>{{ a.oauthId }}</code>
                  <span v-if="a.email">{{ a.email }}</span>
                  <span v-if="a.addedAt">添加于 {{ formatTime(a.addedAt) }}</span>
                </div>
              </div>
              <SlButton size="sm" variant="secondary" class="danger-outline" :disabled="busy" @click="removeAdmin(a)">
                移除
              </SlButton>
            </div>
          </div>
        </section>
      </div>
    </template>

    <template v-else-if="tab === 'recovery'">
      <RecoveryPanel />
    </template>
      </div>
    </div>

    <!-- 二次确认浮窗 -->
    <SlModal v-model="confirmState.open" :title="confirmState.title">
      <p class="confirm-msg">{{ confirmState.message }}</p>
      <template #footer>
        <SlButton variant="secondary" :disabled="busy" @click="closeConfirm">取消</SlButton>
        <SlButton :variant="confirmState.danger ? 'danger' : 'primary'" :disabled="busy" @click="runConfirm">
          {{ confirmState.confirmLabel }}
        </SlButton>
      </template>
    </SlModal>
  </div>
</template>

<style scoped>
.admin-page { max-width: 100%; }
.admin-kicker {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--deploy-primary);
}
.mb { margin-bottom: 12px; }
.admin-shell { margin-top: 4px; overflow: hidden; }
.admin-shell__tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: thin; }
.admin-shell__body { padding: 14px 16px 18px; min-height: 200px; }
.app-list { display: flex; flex-direction: column; margin: -14px -16px; }
.app-row {
  display: flex; justify-content: space-between; gap: 12px; padding: 14px 16px;
  border-bottom: 1px solid var(--deploy-border); background: #fff; flex-wrap: wrap; align-items: center;
}
.app-row:last-child { border-bottom: none; }
.app-row__title { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 14px; }
.app-row__meta { display: flex; gap: 12px; margin-top: 4px; font-size: 12px; color: var(--deploy-fg-secondary); flex-wrap: wrap; }
.app-row__actions { display: flex; gap: 8px; flex-shrink: 0; }
.muted { color: var(--deploy-muted-fg); font-size: 13px; }
.sm { font-size: 12px; }
.ct-toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
.ct-table-wrap {
  overflow-x: auto; -webkit-overflow-scrolling: touch; background: #fff;
  border: 1px solid var(--deploy-border); border-radius: var(--deploy-radius-lg); box-shadow: var(--deploy-shadow);
}
.ct-name { font-family: var(--deploy-mono); font-size: 12px; }
.pkg-tag {
  margin-left: 6px; font-size: 11px; padding: 1px 7px; border-radius: 999px;
  background: var(--deploy-accent-soft); color: var(--deploy-primary); font-weight: 650;
}
.pkg-tag--muted { background: var(--deploy-muted); color: var(--deploy-fg-secondary); }
.cell-check { width: 36px; }
.cell-check input { width: 16px; height: 16px; accent-color: var(--deploy-primary); cursor: pointer; }
.confirm-msg { margin: 0; font-size: 14px; line-height: 1.6; color: var(--deploy-fg-secondary); }
.admin-stack { display: flex; flex-direction: column; gap: 14px; }
.admin-card {
  background: #fff; border: 1px solid var(--deploy-border); border-radius: var(--deploy-radius-lg);
  padding: 16px 18px; box-shadow: var(--deploy-shadow);
}
.admin-card__head { margin-bottom: 14px; }
.admin-card__title { margin: 0 0 4px; font-size: 15px; font-weight: 700; letter-spacing: -0.02em; color: var(--deploy-fg); }
.admin-card__desc { margin: 0; font-size: 13px; line-height: 1.5; color: var(--deploy-fg-secondary); }
.admin-card__desc code {
  font-family: var(--deploy-mono); font-size: 12px; background: var(--deploy-muted); padding: 1px 5px; border-radius: 4px;
}
.settings-list { display: flex; flex-direction: column; gap: 8px; }
.settings-row {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 12px 14px; border: 1px solid var(--deploy-border); border-radius: var(--deploy-radius); background: var(--deploy-bg);
}
.settings-row--stack { flex-direction: column; align-items: stretch; }
.settings-row__main { flex: 1; min-width: 0; }
.settings-row__label { font-size: 13px; font-weight: 650; color: var(--deploy-fg); }
.settings-row__desc { margin-top: 3px; font-size: 12px; line-height: 1.45; color: var(--deploy-fg-secondary); }
.settings-row__warn { color: #b45309; font-weight: 650; }
.settings-row__switch { width: 42px; height: 24px; accent-color: var(--deploy-primary); cursor: pointer; flex-shrink: 0; }
.settings-select {
  min-width: 140px; height: 36px; padding: 0 10px; border: 1px solid var(--deploy-border);
  border-radius: 8px; background: #fff; font: inherit; font-size: 13px; color: var(--deploy-fg);
}
.settings-domain { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.settings-domain__input { flex: 1; min-width: 180px; }
.sseinfra-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: 14px;
}
.sseinfra-clear {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
  cursor: pointer;
}
.sseinfra-status {
  font-size: 12px;
  font-weight: 650;
  margin-left: 4px;
}
.sseinfra-status--ok { color: #059669; }
.sseinfra-status--warn { color: #b45309; }
.ai-preset-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 12px;
}
.ai-form { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center; }
.ai-form > * { min-width: 120px; flex: 1 1 140px; }
.ai-form .settings-select { flex: 0 0 130px; min-width: 120px; }
.admin-add { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
.admin-add__field { flex: 1; min-width: 160px; }
.admin-list { display: flex; flex-direction: column; gap: 8px; }
.admin-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px;
  border: 1px solid var(--deploy-border); border-radius: var(--deploy-radius); background: var(--deploy-bg); flex-wrap: wrap;
}
.admin-row__main { flex: 1; min-width: 0; }
.admin-row__title { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 14px; }
.admin-row__meta { display: flex; gap: 10px; margin-top: 4px; font-size: 12px; color: var(--deploy-fg-secondary); flex-wrap: wrap; }
.admin-row__meta code { font-family: var(--deploy-mono); font-size: 11px; }
.admin-row__actions { display: flex; gap: 8px; flex-shrink: 0; }
.empty-inline { padding: 28px 16px; text-align: center; color: var(--deploy-muted-fg); font-size: 13px; }
.empty-inline--inset { padding: 18px 12px; border: 1px dashed var(--deploy-border); border-radius: var(--deploy-radius); }
.danger-outline { color: #b91c1c !important; border-color: #fecaca !important; }
.danger-outline:hover { background: #fef2f2 !important; }
.sys-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
.sys-card {
  background: #fff; border: 1px solid var(--deploy-border); border-radius: var(--deploy-radius-lg);
  padding: 14px 16px; box-shadow: var(--deploy-shadow);
}
.sys-card__label { font-size: 12px; color: var(--deploy-fg-secondary); margin-bottom: 4px; }
.sys-card__value { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.03em; color: var(--deploy-fg); }
.sys-card__unit { font-size: 12px; font-weight: 500; color: var(--deploy-muted-fg); margin-left: 4px; }
.sys-meta { display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 12px; color: var(--deploy-fg-secondary); margin: 0 0 12px; }
.sys-disk { margin-top: 4px; }
.sys-minio { margin-top: 20px; }
.sys-minio__title { margin: 0 0 6px; font-size: 15px; }
.sys-minio__policy { margin: 0 0 10px; font-size: 12px; color: var(--deploy-fg-secondary); line-height: 1.5; }
@media (max-width: 768px) {
  .admin-shell__body { padding: 12px 12px 16px; }
  .admin-card { padding: 14px; }
  .settings-row { flex-direction: column; align-items: stretch; }
  .settings-select { width: 100%; }
  .sys-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .app-row__actions, .admin-row__actions { width: 100%; }
}
</style>

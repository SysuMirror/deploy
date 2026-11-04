<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  api,
  ApiError,
  type Deployment,
  type Module,
  type ModuleDomain,
  type ModuleUrls,
  type PackageVersion,
} from '@/services/api';
import { useAuthStore } from '@/stores/auth';
import { useDeployStore } from '@/stores/deploy';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const deployStore = useDeployStore();

const mod = ref<Module | null>(null);
const urls = ref<ModuleUrls>({ test: '', testApi: '', prod: '', prodApi: '' });
const deployments = ref<Deployment[]>([]);
const packages = ref<PackageVersion[]>([]);
const loading = ref(true);
const uploading = ref(false);
const tplBusy = ref(false);
const deploying = ref(false);
const promoting = ref(false);
const deleting = ref(false);
const actionError = ref('');
const noCache = ref(false);
const uploadLabel = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const envTab = ref<'test' | 'prod'>('test');
const showLinks = ref(false);
const canDelete = ref(false);
const canWrite = ref(false);
const baseDomain = ref('ssemarket.cn');
const moduleDomains = ref<ModuleDomain[]>([]);
const reservedSubdomains = ref<string[]>([]);
const showDomains = ref(false);
const domainBusy = ref(false);
const domainError = ref('');
const domainKind = ref<'subdomain' | 'custom'>('subdomain');
const domainValue = ref('');
const domainRouteTarget = ref<'web' | 'api'>('web');
const domainAsPrimary = ref(true);
const domainGrayType = ref<'none' | 'header' | 'query' | 'cookie'>('none');
const domainGrayKey = ref('');
const domainGrayValue = ref('');
const showMoreActions = ref(false);
const showSourceHint = ref(false);
const showSourceTools = ref(false);

const showDeployPicker = ref(false);
const deployTargetEnv = ref<'test' | 'prod'>('test');
const selectedVersion = ref('');

const showDeleteModule = ref(false);
const showDeletePkg = ref(false);
const pendingDeletePkg = ref<PackageVersion | null>(null);
const showPromoteConfirm = ref(false);

// —— Git 分支部署 ——
const showGitPanel = ref(false);
const savingGit = ref(false);
const gitRepoUrl = ref('');
const gitProvider = ref('');
const gitBranch = ref('main');
const gitUsername = ref('');
const gitToken = ref('');
const gitClearToken = ref(false);
const gitError = ref('');

const deploySource = ref<'package' | 'git'>('git');
const gitDeployBranch = ref('main');
const useAgentFixer = ref(false);

// —— 回滚 ——
const rollbacking = ref(false);
const showRollbackPicker = ref(false);
const rollbackTargetEnv = ref<'test' | 'prod'>('test');
const rollbackTargetId = ref('');

const migrating = ref(false);
const showMigrateConfirm = ref(false);
const migrateTargetEnv = ref<'test' | 'prod'>('test');
const legacyInfo = ref<Awaited<ReturnType<typeof api.getModuleLegacy>> | null>(null);
const genDeployBusy = ref(false);
const genDeployPreview = ref('');
const showGenDeploy = ref(false);
const flashHint = ref('');


// —— 按环境分槽的环境变量 ——
const showEnvConfig = ref(false);
const envConfigBusy = ref(false);
const envConfigSaving = ref(false);
const envConfigText = ref('{}');
const envConfigFormat = ref<'json' | 'dotenv'>('json');
const envConfigMeta = ref<{
  dataDir: string;
  keyCount: number;
  reservedKeys: string[];
  envFile: string;
} | null>(null);
const envConfigError = ref('');
const envConfigKeyCount = ref({ test: 0, prod: 0 });
const dataExportBusy = ref(false);
const showAgentConfirm = ref(false);
const agentConfirmMessage = ref('');
const agentConfirmKind = ref<'deploy' | 'migrate'>('deploy');
const pendingConfirmAgent = ref(false);

const envConfigPlaceholder = computed(() =>
  envConfigFormat.value === 'json'
    ? '{\n  "DATABASE_URL": "...",\n  "FEATURE_X": "1"\n}'
    : 'DATABASE_URL=...\nFEATURE_X=1'
);

const currentLegacy = computed(() => {
  if (!legacyInfo.value) return null;
  return envTab.value === 'test' ? legacyInfo.value.legacy.test : legacyInfo.value.legacy.prod;
});

const canMigrateCurrent = computed(
  () =>
    Boolean(legacyInfo.value?.sseinfra) &&
    Boolean(currentLegacy.value?.legacy) &&
    (hasGit.value || hasPackage.value)
);

// —— Webhook 自动部署 ——
const showWebhookPanel = ref(false);
const webhookLoading = ref(false);
const rotatingWebhook = ref(false);
const webhookError = ref('');
const webhook = ref<{
  enabled: boolean;
  secret: string;
  path: string;
  webhookUrl: string;
} | null>(null);

const statusLabel: Record<string, string> = {
  pending: '待处理',
  unpacking: '准备包',
  cloning: '准备中',
  building: '构建中',
  deploying: '部署中',
  success: '成功',
  failed: '失败',
};

const envLabel: Record<string, string> = {
  test: '测试',
  prod: '正式',
};

const hasPackage = computed(() => packages.value.length > 0 || Boolean(mod.value?.packageFileName));

const hasGit = computed(() => Boolean(mod.value?.repoUrl));

const currentSlot = computed(() => {
  if (!mod.value) return { url: undefined as string | undefined, apiUrl: undefined as string | undefined };
  return envTab.value === 'test' ? mod.value.test : mod.value.prod;
});

const currentWebUrl = computed(() => {
  if (!mod.value) return '';
  return envTab.value === 'test'
    ? (mod.value.test.url || urls.value.test)
    : (mod.value.prod.url || urls.value.prod);
});

const currentApiUrl = computed(() => {
  if (!mod.value) return '';
  return envTab.value === 'test'
    ? (mod.value.test.apiUrl || urls.value.testApi)
    : (mod.value.prod.apiUrl || urls.value.prodApi);
});

const envDeployments = computed(() =>
  deployments.value.filter((d) => d.env === envTab.value)
);

const rollbackCandidates = computed(() => {
  const activeId =
    rollbackTargetEnv.value === 'test'
      ? mod.value?.test.deploymentId
      : mod.value?.prod.deploymentId;
  return deployments.value.filter(
    (d) => d.env === rollbackTargetEnv.value && d.status === 'success' && d.id !== activeId
  );
});

const canPromote = computed(() => Boolean(mod.value?.test.url && mod.value?.test.deploymentId));

const canUseAgentFixer = computed(() => Boolean(deployStore.agentFixerEnabled));

const meId = computed(() => auth.user?.id);

async function load() {
  const moduleId = route.params.moduleId as string;
  const [modRes, depRes, pkgRes] = await Promise.all([
    api.getModule(moduleId),
    api.listDeployments(moduleId),
    api.listPackages(moduleId),
  ]);
  mod.value = modRes.module;
  urls.value = modRes.urls;
  canDelete.value = Boolean(modRes.canDelete);
  canWrite.value = Boolean(modRes.canWrite);
  baseDomain.value = modRes.baseDomain || 'ssemarket.cn';
  moduleDomains.value = modRes.domains || [];
  reservedSubdomains.value = modRes.reservedSubdomains || [];
  deployments.value = depRes.deployments;
  packages.value = pkgRes.packages;
  try {
    legacyInfo.value = await api.getModuleLegacy(moduleId);
  } catch {
    legacyInfo.value = null;
  }
  if (!selectedVersion.value) {
    selectedVersion.value = pkgRes.currentVersion || pkgRes.packages[0]?.version || '';
  }
  gitRepoUrl.value = mod.value.repoUrl || '';
  gitProvider.value = mod.value.gitProvider || '';
  gitBranch.value = mod.value.defaultBranch || 'main';
  gitUsername.value = mod.value.gitUsername || '';
  gitToken.value = '';
  gitClearToken.value = false;
  gitDeployBranch.value = mod.value.defaultBranch || 'main';
  await refreshEnvConfigCounts();
}

async function refreshEnvConfigCounts() {
  if (!mod.value) return;
  try {
    const [t, p] = await Promise.all([
      api.getModuleEnvConfig(mod.value.id, 'test'),
      api.getModuleEnvConfig(mod.value.id, 'prod'),
    ]);
    envConfigKeyCount.value = {
      test: t.config.keyCount,
      prod: p.config.keyCount,
    };
  } catch {
    // 忽略
  }
}

async function openEnvConfig() {
  if (!mod.value) return;
  showEnvConfig.value = true;
  envConfigError.value = '';
  envConfigBusy.value = true;
  try {
    const { config } = await api.getModuleEnvConfig(mod.value.id, envTab.value);
    envConfigMeta.value = {
      dataDir: config.dataDir,
      keyCount: config.keyCount,
      reservedKeys: config.reservedKeys,
      envFile: config.envFile,
    };
    envConfigFormat.value = 'json';
    envConfigText.value = JSON.stringify(config.vars, null, 2);
  } catch (e) {
    envConfigError.value = e instanceof Error ? e.message : '加载失败';
    envConfigText.value = '{}';
  } finally {
    envConfigBusy.value = false;
  }
}

const currentEnvDomains = computed(() =>
  moduleDomains.value.filter((d) => d.env === envTab.value)
);

const domainPreviewHost = computed(() => {
  const v = domainValue.value.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0] || '';
  if (!v) return '';
  if (domainKind.value === 'subdomain') {
    const label = v.split('.')[0] || '';
    return label ? `${label}.${baseDomain.value}` : '';
  }
  return v;
});

async function refreshDomains() {
  if (!mod.value) return;
  try {
    const res = await api.listModuleDomains(mod.value.id);
    moduleDomains.value = res.domains;
    baseDomain.value = res.baseDomain || baseDomain.value;
    reservedSubdomains.value = res.reservedSubdomains || [];
  } catch {
    // ignore
  }
}

function openDomains() {
  domainError.value = '';
  domainValue.value = '';
  domainKind.value = 'subdomain';
  domainRouteTarget.value = 'web';
  domainAsPrimary.value = currentEnvDomains.value.filter((d) => d.routeTarget !== 'api').length === 0;
  domainGrayType.value = 'none';
  domainGrayKey.value = '';
  domainGrayValue.value = '';
  showDomains.value = true;
  void refreshDomains();
}

async function submitDomain() {
  if (!mod.value || !canWrite.value) return;
  domainBusy.value = true;
  domainError.value = '';
  try {
    await api.addModuleDomain(mod.value.id, {
      env: envTab.value,
      kind: domainKind.value,
      value: domainValue.value.trim(),
      routeTarget: domainRouteTarget.value,
      isPrimary: domainRouteTarget.value === 'web' ? domainAsPrimary.value : false,
      grayMatchType: domainGrayType.value,
      grayMatchKey: domainGrayKey.value.trim() || undefined,
      grayMatchValue: domainGrayValue.value.trim() || undefined,
    });
    domainValue.value = '';
    await refreshDomains();
    flashHint.value = '域名已保存；部署该环境后网关才会反代';
  } catch (e) {
    domainError.value = e instanceof Error ? e.message : '添加失败';
  } finally {
    domainBusy.value = false;
  }
}

async function setDomainPrimary(d: ModuleDomain) {
  if (!mod.value || !canWrite.value) return;
  try {
    await api.updateModuleDomain(mod.value.id, d.id, { isPrimary: true });
    await refreshDomains();
  } catch (e) {
    domainError.value = e instanceof Error ? e.message : '操作失败';
  }
}

async function toggleDomainEnabled(d: ModuleDomain) {
  if (!mod.value || !canWrite.value) return;
  try {
    await api.updateModuleDomain(mod.value.id, d.id, { enabled: !d.enabled });
    await refreshDomains();
  } catch (e) {
    domainError.value = e instanceof Error ? e.message : '操作失败';
  }
}

async function removeDomain(d: ModuleDomain) {
  if (!mod.value || !canWrite.value) return;
  if (!confirm(`确定解绑 ${d.host}？`)) return;
  try {
    await api.deleteModuleDomain(mod.value.id, d.id);
    await refreshDomains();
  } catch (e) {
    domainError.value = e instanceof Error ? e.message : '删除失败';
  }
}

function switchEnvConfigFormat(fmt: 'json' | 'dotenv') {
  if (fmt === envConfigFormat.value) return;
  try {
    if (fmt === 'dotenv') {
      const obj = JSON.parse(envConfigText.value || '{}') as Record<string, string>;
      envConfigText.value = Object.entries(obj)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
    } else {
      // .env → 粗解析到 JSON（保存时后端会再校验）
      const vars: Record<string, string> = {};
      for (const line of (envConfigText.value || '').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq <= 0) continue;
        vars[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      }
      envConfigText.value = JSON.stringify(vars, null, 2);
    }
    envConfigFormat.value = fmt;
  } catch {
    envConfigError.value = '当前内容无法转换格式，请先修正后再切换';
  }
}

async function saveEnvConfig() {
  if (!mod.value) return;
  envConfigSaving.value = true;
  envConfigError.value = '';
  try {
    const { config, message } = await api.saveModuleEnvConfig(mod.value.id, {
      env: envTab.value,
      text: envConfigText.value,
    });
    envConfigMeta.value = {
      dataDir: config.dataDir,
      keyCount: config.keyCount,
      reservedKeys: envConfigMeta.value?.reservedKeys ?? [],
      envFile: config.envFile,
    };
    envConfigKeyCount.value = {
      ...envConfigKeyCount.value,
      [envTab.value]: config.keyCount,
    };
    if (envConfigFormat.value === 'json') {
      envConfigText.value = JSON.stringify(config.vars, null, 2);
    } else {
      envConfigText.value = config.envFile || '';
    }
    flashHint.value = message;
    showEnvConfig.value = false;
  } catch (e) {
    envConfigError.value = e instanceof Error ? e.message : '保存失败';
  } finally {
    envConfigSaving.value = false;
  }
}

async function downloadEnvData() {
  if (!mod.value) return;
  dataExportBusy.value = true;
  actionError.value = '';
  try {
    const { export: info } = await api.getModuleDataExport(mod.value.id, envTab.value);
    if (info.empty) {
      actionError.value = `当前${envLabel[envTab.value]}数据目录为空（${info.dataDir}）`;
      return;
    }
    if (info.tooLarge) {
      actionError.value = `数据约 ${(info.approxBytes / 1024 / 1024).toFixed(0)}MB，超过导出上限 ${(info.maxBytes / 1024 / 1024).toFixed(0)}MB`;
      return;
    }
    await api.downloadModuleData(mod.value.id, envTab.value, info.fileName);
    flashHint.value = `已下载 ${info.fileName}（约 ${(info.approxBytes / 1024 / 1024).toFixed(1)} MB）`;
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : '下载数据失败';
  } finally {
    dataExportBusy.value = false;
  }
}

onMounted(async () => {
  loading.value = true;
  try {
    await load();
  } finally {
    loading.value = false;
  }
});

function pickFile() {
  fileInput.value?.click();
}

async function downloadTpl(id: 'compose-module' | 'sseinfra-module') {
  tplBusy.value = true;
  actionError.value = '';
  try {
    await api.downloadTemplate(id);
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : '下载模板失败';
  } finally {
    tplBusy.value = false;
  }
}

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !mod.value) return;
  uploading.value = true;
  actionError.value = '';
  try {
    const res = await api.uploadPackage(mod.value.id, file, uploadLabel.value || undefined);
    mod.value = res.module;
    selectedVersion.value = res.package.version;
    uploadLabel.value = '';
    await load();
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : '上传失败';
  } finally {
    uploading.value = false;
  }
}

async function saveGit() {
  if (!mod.value) return;
  savingGit.value = true;
  gitError.value = '';
  try {
    const res = await api.saveModuleGit(mod.value.id, {
      repoUrl: gitRepoUrl.value.trim(),
      provider: gitProvider.value.trim(),
      branch: gitBranch.value.trim() || 'main',
      username: gitUsername.value.trim(),
      token: gitToken.value.trim() || undefined,
      clearToken: gitClearToken.value,
    });
    mod.value = res.module;
    gitToken.value = '';
    gitClearToken.value = false;
    await load();
  } catch (e) {
    gitError.value = e instanceof Error ? e.message : '保存失败';
  } finally {
    savingGit.value = false;
  }
}

const prioritySaving = ref(false);
const priorityError = ref('');
const PRIORITY_OPTIONS: Array<{ value: 'critical' | 'normal' | 'best_effort'; label: string }> = [
  { value: 'critical', label: 'critical · 尽量不杀' },
  { value: 'normal', label: 'normal' },
  { value: 'best_effort', label: 'best_effort · 可先杀' },
];

const accessSaving = ref(false);
const accessError = ref('');
const ACCESS_OPTIONS: Array<{ value: 'root' | 'subpath' | 'domain' | ''; label: string }> = [
  { value: '', label: '跟随平台默认' },
  { value: 'root', label: '路径 · 根路径' },
  { value: 'subpath', label: '路径 · /sdpy' },
  { value: 'domain', label: '仅子域名' },
];

async function changeAccessMode(e: Event) {
  if (!mod.value) return;
  const value = (e.target as HTMLSelectElement).value as 'root' | 'subpath' | 'domain' | '';
  accessSaving.value = true;
  accessError.value = '';
  try {
    const res = await api.setModuleAccessMode(mod.value.id, value);
    mod.value = res.module;
    const modRes = await api.getModule(mod.value.id);
    urls.value = modRes.urls;
  } catch (err) {
    accessError.value = err instanceof Error ? err.message : '保存失败';
    (e.target as HTMLSelectElement).value = mod.value.pathMode ?? '';
  } finally {
    accessSaving.value = false;
  }
}

async function changePriority(e: Event) {
  if (!mod.value) return;
  const value = (e.target as HTMLSelectElement).value as 'critical' | 'normal' | 'best_effort';
  prioritySaving.value = true;
  priorityError.value = '';
  try {
    const res = await api.setModulePriority(mod.value.id, value);
    mod.value = res.module;
  } catch (err) {
    priorityError.value = err instanceof Error ? err.message : '保存失败';
    // 回退 select 显示值
    (e.target as HTMLSelectElement).value = mod.value.priority;
  } finally {
    prioritySaving.value = false;
  }
}

function openRollback(env: 'test' | 'prod') {
  rollbackTargetEnv.value = env;
  const activeId =
    env === 'test' ? mod.value?.test.deploymentId : mod.value?.prod.deploymentId;
  const candidates = deployments.value.filter(
    (d) => d.env === env && d.status === 'success' && d.id !== activeId
  );
  rollbackTargetId.value = candidates[0]?.id ?? '';
  showRollbackPicker.value = true;
}

async function confirmRollback() {
  if (!mod.value || !rollbackTargetId.value) return;
  rollbacking.value = true;
  actionError.value = '';
  try {
    const { deployment } = await api.rollbackModule(
      mod.value.id,
      rollbackTargetEnv.value,
      rollbackTargetId.value
    );
    showRollbackPicker.value = false;
    await afterDeployStarted(deployment);
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : '回滚失败';
  } finally {
    rollbacking.value = false;
  }
}

function openMigrate(env: 'test' | 'prod') {
  migrateTargetEnv.value = env;
  showMigrateConfirm.value = true;
}

async function submitMigrate(confirmAgentGenerate: boolean) {
  if (!mod.value) return;
  migrating.value = true;
  actionError.value = '';
  try {
    const { deployment } = await api.migrateModule(mod.value.id, {
      env: migrateTargetEnv.value,
      confirmAgentGenerate,
      ...(hasGit.value
        ? { source: 'git' as const, branch: mod.value.defaultBranch || 'main' }
        : {
            source: 'package' as const,
            packageVersion: selectedVersion.value || undefined,
          }),
    });
    showMigrateConfirm.value = false;
    showAgentConfirm.value = false;
    await afterDeployStarted(
      deployment,
      confirmAgentGenerate
        ? '已开始迁移：Agent 将生成 deploy.sh；可在流水线页取消'
        : undefined
    );
  } catch (e) {
    if (e instanceof ApiError && e.code === 'NEED_AGENT_DEPLOY_SH') {
      agentConfirmKind.value = 'migrate';
      agentConfirmMessage.value = e.message;
      showAgentConfirm.value = true;
      showMigrateConfirm.value = false;
      return;
    }
    actionError.value = e instanceof Error ? e.message : '迁移失败';
  } finally {
    migrating.value = false;
  }
}

async function confirmMigrate() {
  await submitMigrate(false);
}

async function runGenerateDeploySh() {
  if (!mod.value || !hasPackage.value) {
    actionError.value = '请先上传压缩包';
    return;
  }
  genDeployBusy.value = true;
  genDeployPreview.value = '';
  showGenDeploy.value = true;
  actionError.value = '';
  try {
    const { generateDeployShStream } = await import('@/services/api');
    await generateDeployShStream(mod.value.id, {
      packageVersion: selectedVersion.value || undefined,
      apply: true,
      onDelta: (t) => {
        genDeployPreview.value += t;
      },
      onDone: (p) => {
        const files = p.writtenFiles?.length ? ` · 写入 ${p.writtenFiles.join(', ')}` : '';
        genDeployPreview.value =
          (p.summary ? `${p.summary}\n\n` : '') +
          (p.deploySh || genDeployPreview.value);
        flashHint.value = p.applied
          ? `Agent 已写入包内部署文件${files}`
          : `Agent 完成（未落盘）${files}`;
      },
    });
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : '生成失败';
  } finally {
    genDeployBusy.value = false;
  }
}

async function toggleWebhookPanel() {
  showWebhookPanel.value = !showWebhookPanel.value;
  if (showWebhookPanel.value && !webhook.value) {
    await loadWebhook();
  }
}

async function loadWebhook() {
  if (!mod.value) return;
  webhookLoading.value = true;
  webhookError.value = '';
  try {
    webhook.value = await api.getModuleWebhook(mod.value.id);
  } catch (e) {
    webhookError.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    webhookLoading.value = false;
  }
}

async function rotateWebhook() {
  if (!mod.value) return;
  rotatingWebhook.value = true;
  webhookError.value = '';
  try {
    webhook.value = await api.rotateModuleWebhook(mod.value.id);
    if (mod.value) mod.value.hasWebhookSecret = true;
  } catch (e) {
    webhookError.value = e instanceof Error ? e.message : '轮换失败';
  } finally {
    rotatingWebhook.value = false;
  }
}

function openDeployPicker(env: 'test' | 'prod') {
  if (!hasPackage.value && !hasGit.value) {
    actionError.value = '请先配置 Git 仓库，或上传带 deploy.sh 的压缩包';
    return;
  }
  deployTargetEnv.value = env;
  deploySource.value = hasGit.value ? 'git' : hasPackage.value ? 'package' : 'git';
  selectedVersion.value =
    mod.value?.packageVersion || packages.value[0]?.version || '';
  gitDeployBranch.value = mod.value?.defaultBranch || 'main';
  useAgentFixer.value = false;
  showDeployPicker.value = true;
}

async function submitDeploy(confirmAgentGenerate: boolean) {
  if (!mod.value) return;
  deploying.value = true;
  actionError.value = '';
  try {
    const { deployment } = await api.createDeployment(mod.value.id, {
      env: deployTargetEnv.value,
      noCache: noCache.value,
      useAgentFixer: canUseAgentFixer.value ? useAgentFixer.value : false,
      confirmAgentGenerate,
      ...(deploySource.value === 'git'
        ? { source: 'git' as const, branch: gitDeployBranch.value.trim() }
        : {
            source: 'package' as const,
            packageVersion: selectedVersion.value,
          }),
    });
    showDeployPicker.value = false;
    showAgentConfirm.value = false;
    await afterDeployStarted(
      deployment,
      confirmAgentGenerate
        ? '已开始部署：Agent 将生成 deploy.sh；可在流水线页取消'
        : undefined
    );
  } catch (e) {
    if (e instanceof ApiError && e.code === 'NEED_AGENT_DEPLOY_SH') {
      agentConfirmKind.value = 'deploy';
      agentConfirmMessage.value = e.message;
      showAgentConfirm.value = true;
      showDeployPicker.value = false;
      return;
    }
    actionError.value = e instanceof Error ? e.message : '部署失败';
  } finally {
    deploying.value = false;
  }
}

async function confirmDeploy() {
  if (!mod.value) return;
  if (deploySource.value === 'git' && !gitDeployBranch.value.trim()) {
    actionError.value = '请填写要部署的分支';
    return;
  }
  if (deploySource.value === 'package' && !selectedVersion.value) {
    actionError.value = '请选择要部署的版本';
    return;
  }
  await submitDeploy(false);
}

async function confirmAgentThenProceed() {
  pendingConfirmAgent.value = true;
  try {
    if (agentConfirmKind.value === 'migrate') {
      await submitMigrate(true);
    } else {
      await submitDeploy(true);
    }
  } finally {
    pendingConfirmAgent.value = false;
  }
}

async function confirmPromote() {
  if (!mod.value) return;
  promoting.value = true;
  actionError.value = '';
  try {
    const { deployment } = await api.promoteToProd(mod.value.id, { noCache: noCache.value });
    showPromoteConfirm.value = false;
    envTab.value = 'prod';
    await afterDeployStarted(deployment);
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : '晋升失败';
  } finally {
    promoting.value = false;
  }
}

async function confirmDeleteModule() {
  if (!mod.value) return;
  deleting.value = true;
  actionError.value = '';
  try {
    const projectId = mod.value.projectId;
    await api.deleteModule(mod.value.id);
    showDeleteModule.value = false;
    router.replace(`/projects/${projectId}`);
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : '删除失败';
  } finally {
    deleting.value = false;
  }
}

function askDeletePkg(pkg: PackageVersion) {
  pendingDeletePkg.value = pkg;
  showDeletePkg.value = true;
}

async function confirmDeletePkg() {
  if (!mod.value || !pendingDeletePkg.value) return;
  deleting.value = true;
  actionError.value = '';
  try {
    await api.deletePackage(mod.value.id, pendingDeletePkg.value.version);
    showDeletePkg.value = false;
    pendingDeletePkg.value = null;
    await load();
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : '删除失败';
  } finally {
    deleting.value = false;
  }
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
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

function goBack() {
  if (mod.value?.projectId) {
    router.push(`/projects/${mod.value.projectId}`);
  } else {
    router.push('/projects');
  }
}

function openLogs(d: Deployment) {
  router.push(`/modules/${d.moduleId}/deployments/${d.id}`);
}

function openObjectStorage() {
  if (!mod.value) return;
  router.push({
    path: `/modules/${mod.value.id}/object-storage`,
    query: { env: envTab.value },
  });
}

function afterDeployStarted(deployment: Deployment, hint?: string) {
  if (hint) flashHint.value = hint;
  deployments.value = [deployment, ...deployments.value.filter((d) => d.id !== deployment.id)];
  openLogs(deployment);
}

function canDeleteThisPkg(pkg: PackageVersion) {
  return Boolean(pkg.canDelete || (meId.value && pkg.uploadedBy === meId.value));
}
</script>

<template>
  <div v-if="loading" class="page-loading"><SlSpinner /></div>

  <div v-else-if="mod" class="module-page">
    <button type="button" class="page-back" @click="goBack">← 返回项目</button>

    <header class="page-hero">
      <div class="page-hero__main">
        <p class="page-hero__eyebrow">模块</p>
        <h1 class="page-hero__title">{{ mod.name }}</h1>
        <p class="page-hero__desc">
          {{
            hasGit
              ? `Git · ${gitProvider || 'repo'} · ${gitBranch || mod.defaultBranch || 'main'}`
              : hasPackage
                ? `压缩包 · ${mod.packageFileName || mod.packageVersion}`
                : '请上传压缩包或配置 Git 仓库后部署'
          }}
        </p>
      </div>
      <div class="page-hero__actions">
        <label
          class="priority-field"
          title="访问方式：路径（默认 / 或 /sdpy 前缀）或仅子域名（名称.域名 / test.名称.域名）"
        >
          <span class="priority-field__label">访问方式</span>
          <select
            class="priority-select"
            :value="mod.pathMode ?? ''"
            :disabled="accessSaving || !canWrite"
            @change="changeAccessMode"
          >
            <option v-for="o in ACCESS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
        <label class="priority-field" title="系统压力高时 sseinfra 按优先级排杀序；部署时注入为 PRIORITY 环境变量">
          <span class="priority-field__label">优先级</span>
          <select
            class="priority-select"
            :value="mod.priority"
            :disabled="prioritySaving || !canWrite"
            @change="changePriority"
          >
            <option v-for="o in PRIORITY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
        <p v-if="accessError" class="priority-error">{{ accessError }}</p>
        <p v-if="priorityError" class="priority-error">{{ priorityError }}</p>
        <label class="nocache">
          <input v-model="noCache" type="checkbox" />
          --no-cache
        </label>
        <SlButton
          v-if="canDelete"
          variant="secondary"
          class="danger-outline"
          @click="showDeleteModule = true"
        >
          删除
        </SlButton>
      </div>
    </header>

    <div class="source-bar list-panel">
      <div class="source-bar__row">
        <SlInput
          v-model="uploadLabel"
          placeholder="版本标签（可选）"
          class="upload-bar__label"
        />
        <SlButton variant="secondary" :disabled="uploading" @click="pickFile">
          {{ uploading ? '上传中…' : '上传压缩包' }}
        </SlButton>
        <SlButton variant="secondary" @click="showGitPanel = !showGitPanel">
          {{ hasGit ? 'Git 已配置' : '配置 Git' }}
        </SlButton>
        <SlButton variant="secondary" @click="showSourceTools = !showSourceTools">
          工具 {{ showSourceTools ? '▴' : '▾' }}
        </SlButton>
      </div>
      <div v-if="showSourceTools" class="source-bar__tools">
        <SlButton variant="secondary" size="sm" :disabled="tplBusy" @click="downloadTpl('sseinfra-module')">
          下载 Git 模板
        </SlButton>
        <SlButton variant="secondary" size="sm" :disabled="tplBusy" @click="downloadTpl('compose-module')">
          下载 compose 模板
        </SlButton>
        <SlButton
          variant="secondary"
          size="sm"
          :disabled="genDeployBusy || !hasPackage"
          @click="runGenerateDeploySh"
        >
          {{ genDeployBusy ? 'Agent…' : 'Agent 生成 deploy.sh' }}
        </SlButton>
        <SlButton
          variant="secondary"
          size="sm"
          :disabled="!hasGit"
          @click="toggleWebhookPanel"
        >
          Webhook
        </SlButton>
      </div>
      <p v-if="flashHint" class="upload-hint muted">{{ flashHint }}</p>
      <button type="button" class="link-btn source-hint-toggle" @click="showSourceHint = !showSourceHint">
        {{ showSourceHint ? '收起说明' : '部署说明' }}
      </button>
      <p v-if="showSourceHint" class="upload-hint muted">
        默认 <code>DEPLOY_RUNTIME=sseinfra</code>：压缩包与 Git 都进 K8s 组容器，根目录须有可执行
        <code>deploy.sh</code>（组内无 Docker）。可先下载模板。
      </p>
    </div>

    <input
      ref="fileInput"
      type="file"
      accept=".zip,application/zip"
      class="hidden-file"
      @change="onFileChange"
    />

    <!-- Git 分支部署配置 -->
    <div v-if="showGitPanel" class="list-panel mb-4">
      <div class="list-panel__toolbar">
        <h2 class="list-panel__toolbar-title">Git 仓库</h2>
        <SlButton variant="secondary" size="sm" @click="showGitPanel = false">收起</SlButton>
      </div>

      <div class="git-form">
        <label class="git-field">
          <span>仓库地址</span>
          <SlInput
            v-model="gitRepoUrl"
            placeholder="https://github.com/owner/repo 或 https://gitee.com/owner/repo"
          />
        </label>
        <div class="git-form__row">
          <label class="git-field">
            <span>平台</span>
            <select v-model="gitProvider" class="git-select">
              <option value="">自动识别</option>
              <option value="github">GitHub</option>
              <option value="gitee">Gitee</option>
              <option value="generic">其他</option>
            </select>
          </label>
          <label class="git-field">
            <span>默认分支</span>
            <SlInput v-model="gitBranch" placeholder="main" />
          </label>
        </div>
        <div class="git-form__row">
          <label class="git-field">
            <span>用户名（私有仓库，GitHub 可留空）</span>
            <SlInput v-model="gitUsername" placeholder="Gitee 用户名" />
          </label>
          <label class="git-field">
            <span>访问令牌（私有仓库）</span>
            <input
              v-model="gitToken"
              type="password"
              class="git-token"
              placeholder="留空表示不修改"
            />
          </label>
        </div>
        <label v-if="mod?.hasGitToken" class="git-clear">
          <input v-model="gitClearToken" type="checkbox" />
          清除已保存的令牌
        </label>
        <SlAlert v-if="gitError" variant="error" class="mt-2">{{ gitError }}</SlAlert>
        <div class="git-form__actions">
          <SlButton variant="primary" size="sm" :disabled="savingGit" @click="saveGit">
            {{ savingGit ? '保存中…' : '保存仓库配置' }}
          </SlButton>
        </div>
      </div>
    </div>

    <!-- Webhook 自动部署 -->
    <div v-if="showWebhookPanel" class="list-panel mb-4">
      <div class="list-panel__toolbar">
        <h2 class="list-panel__toolbar-title">Webhook 自动部署</h2>
        <SlButton variant="secondary" size="sm" @click="showWebhookPanel = false">收起</SlButton>
      </div>

      <div class="webhook-panel">
        <p v-if="!hasGit" class="muted">需先配置 Git 仓库才能使用 Webhook 自动部署。</p>
        <template v-else>
          <p class="webhook-panel__hint">
            在 Gitee / GitHub 仓库中配置 Push 事件 Webhook，代码推送到默认分支后即自动触发部署。
          </p>
          <div v-if="webhookLoading" class="webhook-panel__loading">加载中…</div>
          <template v-else-if="webhook">
            <label class="git-field">
              <span>回调地址（Webhook URL）</span>
              <code class="webhook-panel__url">{{ webhook.webhookUrl }}</code>
            </label>
            <div class="webhook-panel__row">
              <label class="git-field">
                <span>密钥（Secret）</span>
                <code class="webhook-panel__url">{{ webhook.secret || '尚未生成' }}</code>
              </label>
              <SlButton
                variant="secondary"
                size="sm"
                :disabled="rotatingWebhook"
                @click="rotateWebhook"
              >
                {{ rotatingWebhook ? '生成中…' : webhook.secret ? '轮换密钥' : '生成密钥' }}
              </SlButton>
            </div>
            <div class="webhook-panel__actions">
              <SlButton variant="secondary" size="sm" @click="copyText(webhook.webhookUrl)">
                复制 URL
              </SlButton>
              <SlButton
                v-if="webhook.secret"
                variant="secondary"
                size="sm"
                @click="copyText(webhook.secret)"
              >
                复制密钥
              </SlButton>
            </div>
          </template>
          <SlAlert v-if="webhookError" variant="error" class="mt-2">{{ webhookError }}</SlAlert>
        </template>
      </div>
    </div>

    <SlAlert v-if="actionError" variant="error" class="mb-4">{{ actionError }}</SlAlert>

    <!-- 包版本列表 -->
    <div v-if="packages.length" class="list-panel mb-4">
      <div class="list-panel__toolbar">
        <h2 class="list-panel__toolbar-title">压缩包版本</h2>
        <span class="muted">{{ packages.length }} 个 · 可选择历史版本重新部署</span>
      </div>
      <div class="pkg-list">
        <div v-for="pkg in packages" :key="pkg.id" class="pkg-row">
          <div class="pkg-row__main">
            <div class="pkg-row__title">
              <strong>{{ pkg.label }}</strong>
              <span v-if="pkg.isCurrent" class="pkg-tag">当前</span>
            </div>
            <div class="pkg-row__meta">
              <code>{{ pkg.version }}</code>
              <span>{{ formatTime(pkg.createdAt) }}</span>
              <span v-if="pkg.uploadedByName || pkg.uploadedBy" class="muted">
                上传人 {{ pkg.uploadedByName || pkg.uploadedBy }}
              </span>
              <span class="muted">{{ pkg.fileName }}</span>
            </div>
          </div>
          <div class="pkg-row__actions">
            <SlButton
              v-if="canDeleteThisPkg(pkg)"
              variant="secondary"
              size="sm"
              class="danger-outline"
              @click="askDeletePkg(pkg)"
            >
              删除
            </SlButton>
          </div>
        </div>
      </div>
    </div>

    <div class="list-panel">
      <div class="list-panel__tabs" role="tablist" aria-label="环境">
        <button
          type="button"
          role="tab"
          class="list-panel__tab"
          :class="{ 'list-panel__tab--active': envTab === 'test' }"
          :aria-selected="envTab === 'test'"
          @click="envTab = 'test'"
        >
          测试环境
          <span class="list-panel__tab-count">{{ mod.test.url ? '已部署' : '未部署' }}</span>
        </button>
        <button
          type="button"
          role="tab"
          class="list-panel__tab"
          :class="{ 'list-panel__tab--active': envTab === 'prod' }"
          :aria-selected="envTab === 'prod'"
          @click="envTab = 'prod'"
        >
          正式环境
          <span class="list-panel__tab-count">{{ mod.prod.url ? '已部署' : '未部署' }}</span>
        </button>
      </div>

      <div class="module-actions">
        <div class="module-actions__primary">
          <SlButton
            variant="primary"
            :disabled="(!hasPackage && !hasGit) || deploying"
            @click="openDeployPicker(envTab)"
          >
            {{ envTab === 'test' ? '部署测试' : '部署正式' }}
          </SlButton>
          <SlButton variant="secondary" @click="showLinks = true">访问链接</SlButton>
          <div class="more-wrap">
            <SlButton variant="secondary" @click="showMoreActions = !showMoreActions">
              更多 {{ showMoreActions ? '▴' : '▾' }}
            </SlButton>
            <div v-if="showMoreActions" class="more-menu deploy-surface" @click.stop>
              <button type="button" class="more-menu__item" @click="openEnvConfig(); showMoreActions = false">
                环境变量
                <span v-if="envConfigKeyCount[envTab]" class="more-menu__meta">
                  {{ envConfigKeyCount[envTab] }}
                </span>
              </button>
              <button type="button" class="more-menu__item" @click="openDomains(); showMoreActions = false">
                访问域名
                <span v-if="currentEnvDomains.length" class="more-menu__meta">
                  {{ currentEnvDomains.length }}
                </span>
              </button>
              <button type="button" class="more-menu__item" @click="openObjectStorage(); showMoreActions = false">
                对象存储
              </button>
              <button
                type="button"
                class="more-menu__item"
                :disabled="dataExportBusy"
                @click="downloadEnvData(); showMoreActions = false"
              >
                {{ dataExportBusy ? '打包中…' : '下载数据' }}
              </button>
              <button
                v-if="currentSlot.url"
                type="button"
                class="more-menu__item"
                :disabled="rollbacking"
                @click="openRollback(envTab); showMoreActions = false"
              >
                回滚历史版本
              </button>
              <button
                v-if="canMigrateCurrent"
                type="button"
                class="more-menu__item"
                :disabled="migrating"
                @click="openMigrate(envTab); showMoreActions = false"
              >
                迁移到 K8s
              </button>
              <button
                v-if="envTab === 'test' && canPromote"
                type="button"
                class="more-menu__item"
                :disabled="promoting"
                @click="showPromoteConfirm = true; showMoreActions = false"
              >
                一键晋升正式
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="env-summary">
        <span
          :class="[
            'status-pill',
            currentSlot.url ? 'status-pill--on' : 'status-pill--off',
          ]"
        >
          {{ currentSlot.url ? '已部署' : '未部署' }}
        </span>
        <div class="env-summary__body">
          <p v-if="currentLegacy?.legacy" class="migrate-hint">
            本机 compose 遗留：{{ currentLegacy.reason }}；数据
            <code>{{ currentLegacy.hostDataDir }}</code>
            <template v-if="currentLegacy.dataExists">
              （约 {{ (currentLegacy.dataApproxBytes / 1024 / 1024).toFixed(1) }} MB）
            </template>
            。可「迁移到 K8s」同步数据并停旧站。
          </p>
          <p v-else>
            {{
              currentSlot.url
                ? '当前环境已上线。部署日志请从历史记录进入查看。'
                : hasPackage || hasGit
                  ? '选择 Git 分支后即可经 sseinfra 一键部署。'
                  : '请先配置 Git 仓库（仓根 deploy.sh），再部署当前环境。'
            }}
          </p>
        </div>
      </div>

      <div class="list-panel mb-4 os-entry">
        <div class="list-panel__toolbar">
          <h2 class="list-panel__toolbar-title">对象存储（MinIO）</h2>
          <SlButton variant="primary" size="sm" @click="openObjectStorage">
            进入管理
          </SlButton>
        </div>
        <p class="os-entry__hint muted">
          开通数据桶、同步宿主机历史图片/文件到桶。点「进入管理」在独立页按步骤操作；桶随模块保留，删组不删桶。
        </p>
      </div>

      <div class="list-panel__toolbar">
        <h2 class="list-panel__toolbar-title">部署历史</h2>
        <span class="muted">{{ envDeployments.length }} 条</span>
      </div>      <div v-if="!envDeployments.length" class="empty-inline">
        <p>暂无部署记录</p>
        <span>部署当前环境后会出现在这里</span>
      </div>
      <div v-else class="deploy-list">
        <button
          v-for="d in envDeployments"
          :key="d.id"
          type="button"
          class="deploy-row"
          @click="openLogs(d)"
        >
          <div class="deploy-row__main">
            <div class="deploy-row__top">
              <span>{{ formatTime(d.createdAt) }}</span>
              <span :class="['status-badge', `status-badge--${d.status}`]">
                {{ statusLabel[d.status] ?? d.status }}
              </span>
            </div>
            <div class="deploy-row__meta">
              <span>{{
                d.action === 'promote'
                  ? '晋升'
                  : d.action === 'migrate'
                    ? '迁移'
                    : d.action === 'rollback'
                      ? '回滚'
                      : '部署'
              }}</span>
              <code>{{ d.commitSha || d.branch || '—' }}</code>
              <span v-if="d.operatorName">{{ d.operatorName }}</span>
              <span v-if="d.fixedByAgent" class="agent-mini" title="曾由 Agent 自动修复">
                🤖 Agent
              </span>
            </div>
          </div>
          <span class="deploy-row__go">查看流水线 →</span>
        </button>
      </div>
    </div>

    <!-- 选版/选分支部署 -->
    <SlModal v-model="showDeployPicker" :title="`部署${envLabel[deployTargetEnv]}`">
      <div class="source-tabs" role="tablist" aria-label="部署来源">
        <button
          type="button"
          role="tab"
          class="source-tab"
          :class="{ 'source-tab--active': deploySource === 'package' }"
          :aria-selected="deploySource === 'package'"
          @click="deploySource = 'package'"
        >
          压缩包版本
        </button>
        <button
          type="button"
          role="tab"
          class="source-tab"
          :class="{ 'source-tab--active': deploySource === 'git' }"
          :aria-selected="deploySource === 'git'"
          @click="deploySource = 'git'"
        >
          Git 分支
        </button>
      </div>

      <template v-if="deploySource === 'git'">
        <p class="modal-hint">
          经 <strong>sseinfra</strong> 远程部署：克隆仓库并用 supervisord 执行仓根
          <code>deploy.sh</code>（须可执行；监听 <code>0.0.0.0:$PORT</code>）。
        </p>
        <p v-if="!hasGit" class="modal-hint">请先在模块页配置 Git 仓库地址。</p>
        <label v-else class="git-field">
          <span>分支</span>
          <SlInput v-model="gitDeployBranch" placeholder="main" />
        </label>
      </template>
      <template v-else>
        <p class="modal-hint">
          经 <strong>sseinfra / K8s</strong> 部署：同步压缩包到组容器并用 supervisord 执行根目录
          <code>deploy.sh</code>（须可执行；监听 <code>0.0.0.0:$PORT</code>）。可先「下载 Git 模板」。仅
          <code>DEPLOY_RUNTIME=compose</code> 时才走本机 docker compose。
        </p>
        <p v-if="!hasPackage" class="modal-hint">请先上传压缩包版本。</p>
        <div v-else class="version-picker">
          <label
            v-for="pkg in packages"
            :key="pkg.id"
            class="version-option"
            :class="{ 'version-option--active': selectedVersion === pkg.version }"
          >
            <input v-model="selectedVersion" type="radio" :value="pkg.version" />
            <div>
              <div class="version-option__title">
                <strong>{{ pkg.label }}</strong>
                <span v-if="pkg.isCurrent" class="pkg-tag">当前</span>
              </div>
              <div class="version-option__meta">
                <code>{{ pkg.version }}</code>
                <span>{{ formatTime(pkg.createdAt) }}</span>
              </div>
            </div>
          </label>
        </div>
      </template>

      <label v-if="canUseAgentFixer" class="agent-fix-opt">
        <input v-model="useAgentFixer" type="checkbox" />
        <span>
          Agent 自动修复（构建失败时由 AI 自动修补 Dockerfile / compose 后重试）
        </span>
      </label>

      <template #footer>
        <SlButton variant="secondary" @click="showDeployPicker = false">取消</SlButton>
        <SlButton
          variant="primary"
          :disabled="
            deploying ||
            (deploySource === 'git'
              ? !hasGit || !gitDeployBranch.trim()
              : !hasPackage || !selectedVersion)
          "
          @click="confirmDeploy"
        >
          {{ deploying ? '提交中…' : '开始部署' }}
        </SlButton>
      </template>
    </SlModal>

    <!-- 晋升确认 -->
    <SlModal v-model="showPromoteConfirm" title="一键晋升到正式环境">
      <p class="modal-hint">
        将使用<strong>测试环境当前成功部署</strong>所用的压缩包版本，重新构建并部署到正式环境。
        正式环境上的旧容器会被替换。测试/正式的<strong>环境变量与数据目录彼此独立</strong>，晋升不会复制配置。是否继续？
      </p>
      <template #footer>
        <SlButton variant="secondary" @click="showPromoteConfirm = false">取消</SlButton>
        <SlButton variant="primary" :disabled="promoting" @click="confirmPromote">
          {{ promoting ? '提交中…' : '确认晋升' }}
        </SlButton>
      </template>
    </SlModal>

    <!-- 迁移到 K8s -->
    <SlModal
      v-model="showMigrateConfirm"
      :title="`迁移到 K8s · ${envLabel[migrateTargetEnv]}环境`"
    >
      <p class="modal-hint">
        将把本机 <code>MODULE_DATA</code> 同步到组容器
        <code>/home/cloud/data</code>（兼容 <code>/data</code>），再按
        {{ hasGit ? 'Git 仓库' : '压缩包' }} 部署到 sseinfra，成功后<strong>停止本机 docker
        compose</strong>并刷新 nginx。宿主机数据目录会保留作备份。
      </p>
      <p v-if="currentLegacy" class="modal-hint muted">
        {{ currentLegacy.reason }} · {{ currentLegacy.hostDataDir }}
        <template v-if="currentLegacy.dataExists">
          · ≈{{ (currentLegacy.dataApproxBytes / 1024 / 1024).toFixed(1) }} MB
        </template>
      </p>
      <p class="modal-hint">
        组内无 Docker。若压缩包缺 <code>deploy.sh</code>，确认迁移后会先提醒你是否允许
        Agent 生成；生成与部署过程均可在日志页<strong>取消</strong>。
      </p>
      <template #footer>
        <SlButton variant="secondary" @click="showMigrateConfirm = false">取消</SlButton>
        <SlButton variant="primary" :disabled="migrating" @click="confirmMigrate">
          {{ migrating ? '提交中…' : '确认迁移' }}
        </SlButton>
      </template>
    </SlModal>

    <!-- Agent 生成确认（部署/迁移缺 deploy.sh） -->
    <SlModal v-model="showAgentConfirm" title="需要部署 Agent 生成 deploy.sh">
      <p class="modal-hint">{{ agentConfirmMessage }}</p>
      <p class="modal-hint muted">
        确认后将调用 AI 写入配置/部署脚本（不改业务源码）。过程中可在部署日志页随时取消。
        构建失败时的 Agent 自愈仍按部署弹窗勾选，不额外弹窗。
      </p>
      <template #footer>
        <SlButton variant="secondary" @click="showAgentConfirm = false">取消</SlButton>
        <SlButton
          variant="primary"
          :disabled="pendingConfirmAgent || deploying || migrating"
          @click="confirmAgentThenProceed"
        >
          {{ pendingConfirmAgent ? '提交中…' : '确认使用 Agent 并继续' }}
        </SlButton>
      </template>
    </SlModal>

    <!-- 按环境分槽：环境变量 → 部署时根 .env -->
    <SlModal
      v-model="showEnvConfig"
      :title="`环境变量 · ${envLabel[envTab]}`"
    >
      <p class="modal-hint">
        测试 / 正式<strong>配置分槽、数据分目录</strong>。此处保存的是当前
        <code>{{ envTab }}</code> 槽；部署该环境时写入应用根目录
        <code>.env</code>，并注入进程/组环境。平台键（如
        <code>SDPY_DATA_DIR</code>、<code>PORT</code>）部署时覆盖同名用户项。
      </p>
      <p v-if="envConfigMeta" class="modal-hint muted">
        本环境数据目录：<code>{{ envConfigMeta.dataDir }}</code>
      </p>
      <div class="env-fmt-bar">
        <button
          type="button"
          class="env-fmt-btn"
          :class="{ 'env-fmt-btn--on': envConfigFormat === 'json' }"
          @click="switchEnvConfigFormat('json')"
        >
          JSON
        </button>
        <button
          type="button"
          class="env-fmt-btn"
          :class="{ 'env-fmt-btn--on': envConfigFormat === 'dotenv' }"
          @click="switchEnvConfigFormat('dotenv')"
        >
          .env
        </button>
      </div>
      <textarea
        v-model="envConfigText"
        class="env-config-ta"
        :disabled="envConfigBusy"
        :placeholder="envConfigPlaceholder"
        rows="14"
      />
      <p v-if="envConfigError" class="form-error">{{ envConfigError }}</p>
      <p v-if="envConfigBusy" class="muted">加载中…</p>
      <template #footer>
        <SlButton variant="secondary" @click="showEnvConfig = false">取消</SlButton>
        <SlButton
          variant="primary"
          :disabled="envConfigBusy || envConfigSaving"
          @click="saveEnvConfig"
        >
          {{ envConfigSaving ? '保存中…' : '保存' }}
        </SlButton>
      </template>
    </SlModal>

    <!-- 部署 Agent（tools） -->
    <SlModal v-model="showGenDeploy" title="部署 Agent（tools）">
      <p class="modal-hint">
        Agent 可自行 list/read 压缩包，并写入<strong>配置与部署脚本</strong>（如
        <code>deploy.sh</code> / compose / Dockerfile）。<strong>禁止改业务源码</strong>。须管理台已配
        AI/vLLM（且模型支持 function calling）。
      </p>
      <pre class="gen-deploy-pre">{{ genDeployPreview || (genDeployBusy ? 'Agent 运行中…' : '（空）') }}</pre>
      <template #footer>
        <SlButton variant="secondary" @click="showGenDeploy = false">关闭</SlButton>
      </template>
    </SlModal>

    <!-- 回滚选版 -->
    <SlModal
      v-model="showRollbackPicker"
      :title="`回滚到历史版本 · ${envLabel[rollbackTargetEnv]}环境`"
    >
      <p class="modal-hint">
        选择一个历史成功部署，重新构建并部署到{{ envLabel[rollbackTargetEnv] }}环境。
        当前环境上正在运行的容器会被替换。
      </p>
      <div v-if="!rollbackCandidates.length" class="empty-inline">
        <p>没有可回滚的历史成功版本</p>
      </div>
      <div v-else class="version-picker">
        <label
          v-for="d in rollbackCandidates"
          :key="d.id"
          class="version-option"
          :class="{ 'version-option--active': rollbackTargetId === d.id }"
        >
          <input v-model="rollbackTargetId" type="radio" :value="d.id" />
          <div>
            <div class="version-option__title">
              <strong>{{ d.commitSha || d.branch || '—' }}</strong>
              <span class="pkg-tag">{{ d.source === 'git' ? 'Git' : '包' }}</span>
            </div>
            <div class="version-option__meta">
              <span>{{ formatTime(d.createdAt) }}</span>
              <span v-if="d.operatorName">{{ d.operatorName }}</span>
            </div>
          </div>
        </label>
      </div>
      <template #footer>
        <SlButton variant="secondary" @click="showRollbackPicker = false">取消</SlButton>
        <SlButton
          variant="primary"
          :disabled="rollbacking || !rollbackTargetId"
          @click="confirmRollback"
        >
          {{ rollbacking ? '提交中…' : '确认回滚' }}
        </SlButton>
      </template>
    </SlModal>

    <!-- 删除模块 -->
    <SlModal v-model="showDeleteModule" title="删除模块">
      <p class="modal-hint danger-text">
        仅模块创建人可删除。将停止本机 compose（若有）、释放 sseinfra 测试/正式 K8s 组，并删除上传包与部署记录，不可恢复。
        确认删除模块「{{ mod.name }}」？
      </p>
      <template #footer>
        <SlButton variant="secondary" @click="showDeleteModule = false">取消</SlButton>
        <SlButton variant="primary" class="danger-btn" :disabled="deleting" @click="confirmDeleteModule">
          {{ deleting ? '删除中…' : '确认删除' }}
        </SlButton>
      </template>
    </SlModal>

    <!-- 删除包版本 -->
    <SlModal v-model="showDeletePkg" title="删除包版本">
      <p class="modal-hint danger-text">
        仅该版本上传者可删除。将永久删除版本
        「{{ pendingDeletePkg?.label }}」（{{ pendingDeletePkg?.version }}），不可恢复。
      </p>
      <template #footer>
        <SlButton variant="secondary" @click="showDeletePkg = false">取消</SlButton>
        <SlButton variant="primary" class="danger-btn" :disabled="deleting" @click="confirmDeletePkg">
          {{ deleting ? '删除中…' : '确认删除' }}
        </SlButton>
      </template>
    </SlModal>

    <SlModal
      v-model="showLinks"
      :title="`访问链接 · ${envTab === 'test' ? '测试环境' : '正式环境'}`"
    >
      <p class="links-modal__hint">
        {{ currentSlot.url ? '当前环境已部署，可复制或打开。' : '尚未部署，以下为预期地址。' }}
        路径访问长期保留；若配置了域名，部署后主 URL 优先用主域名。
      </p>
      <table class="deploy-table deploy-table--dashed">
        <tbody>
          <tr>
            <td class="col-type">前端</td>
            <td class="url-cell">{{ currentWebUrl }}</td>
            <td class="actions-cell">
              <button type="button" class="link-btn" @click="copyText(currentWebUrl)">复制</button>
              <button
                v-if="currentSlot.url"
                type="button"
                class="link-btn"
                @click="openUrl(currentSlot.url)"
              >
                打开
              </button>
            </td>
          </tr>
          <tr>
            <td class="col-type">后端 API</td>
            <td class="url-cell">{{ currentApiUrl }}</td>
            <td class="actions-cell">
              <button type="button" class="link-btn" @click="copyText(currentApiUrl)">复制</button>
              <button
                v-if="currentSlot.apiUrl"
                type="button"
                class="link-btn"
                @click="openUrl(currentSlot.apiUrl)"
              >
                打开
              </button>
            </td>
          </tr>
          <tr v-for="d in currentEnvDomains" :key="d.id">
            <td class="col-type">
              {{ d.kind === 'subdomain' ? '子域名' : '自定义' }}
              <span v-if="d.isPrimary">·主</span>
            </td>
            <td class="url-cell">https://{{ d.host }}</td>
            <td class="actions-cell">
              <button type="button" class="link-btn" @click="copyText(`https://${d.host}`)">
                复制
              </button>
              <button type="button" class="link-btn" @click="openUrl(`https://${d.host}`)">
                打开
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <template #footer>
        <SlButton variant="secondary" @click="showLinks = false">关闭</SlButton>
      </template>
    </SlModal>

    <SlModal
      v-model="showDomains"
      :title="`访问域名 · ${envTab === 'test' ? '测试' : '正式'}`"
    >
      <p class="links-modal__hint">
        可为当前环境绑定多个域名（全局唯一）。不可占用根域
        <code>{{ baseDomain }}</code>
        与保留子域（如 cloud）。平台子域证书已覆盖
        <code>*.{{ baseDomain }}</code>
        。可分别为<strong>前端</strong>（如 platform）与<strong>后端 API</strong>（如 api）绑定不同域名。
      </p>
      <p v-if="domainError" class="form-error">{{ domainError }}</p>
      <table v-if="currentEnvDomains.length" class="deploy-table deploy-table--dashed mb-4">
        <thead>
          <tr>
            <th>主机</th>
            <th>用途</th>
            <th>类型</th>
            <th>状态</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in currentEnvDomains" :key="d.id">
            <td class="url-cell">
              https://{{ d.host }}
              <span v-if="d.isPrimary" class="status-pill status-pill--on">主</span>
            </td>
            <td>{{ d.routeTarget === 'api' ? '后端 API' : '前端' }}</td>
            <td>{{ d.kind === 'subdomain' ? '平台子域' : '自定义' }}</td>
            <td>{{ d.enabled ? '启用' : '停用' }}</td>
            <td class="actions-cell">
              <button
                v-if="canWrite && !d.isPrimary && d.routeTarget !== 'api'"
                type="button"
                class="link-btn"
                @click="setDomainPrimary(d)"
              >
                设为主
              </button>
              <button
                v-if="canWrite"
                type="button"
                class="link-btn"
                @click="toggleDomainEnabled(d)"
              >
                {{ d.enabled ? '停用' : '启用' }}
              </button>
              <button
                v-if="canWrite"
                type="button"
                class="link-btn"
                @click="removeDomain(d)"
              >
                解绑
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="canWrite" class="domain-form">
        <label class="field-label">用途</label>
        <select v-model="domainRouteTarget" class="field-input">
          <option value="web">前端 / 控制台（写入 SDPY_PUBLIC_URL）</option>
          <option value="api">后端 API（写入 SDPY_API_PUBLIC_URL）</option>
        </select>
        <label class="field-label">类型</label>
        <select v-model="domainKind" class="field-input">
          <option value="subdomain">平台子域名（*.{{ baseDomain }}）</option>
          <option value="custom">自定义域名</option>
        </select>
        <label class="field-label">
          {{ domainKind === 'subdomain' ? '子域标签' : '完整域名' }}
        </label>
        <input
          v-model="domainValue"
          class="field-input"
          :placeholder="
            domainKind === 'subdomain'
              ? domainRouteTarget === 'api'
                ? '如 api'
                : '如 platform'
              : '如 app.example.com'
          "
        />
        <p v-if="domainPreviewHost" class="links-modal__hint">
          将绑定：<strong>https://{{ domainPreviewHost }}</strong>
        </p>
        <label v-if="domainRouteTarget === 'web'" class="nocache">
          <input v-model="domainAsPrimary" type="checkbox" />
          设为该环境主访问域名（部署写入 SDPY_PUBLIC_URL）
        </label>
        <label class="field-label">灰度匹配（预留）</label>
        <select v-model="domainGrayType" class="field-input">
          <option value="none">无</option>
          <option value="header">Header</option>
          <option value="query">Query</option>
          <option value="cookie">Cookie</option>
        </select>
        <template v-if="domainGrayType !== 'none'">
          <input v-model="domainGrayKey" class="field-input" placeholder="key，如 X-Canary" />
          <input v-model="domainGrayValue" class="field-input" placeholder="value，如 1" />
        </template>
        <SlButton
          variant="primary"
          size="sm"
          class="mt-2"
          :disabled="domainBusy || !domainValue.trim()"
          @click="submitDomain"
        >
          {{ domainBusy ? '提交中…' : '添加域名' }}
        </SlButton>
      </div>
      <p v-else class="links-modal__hint">只读：需要模块写权限才能改域名。</p>
      <template #footer>
        <SlButton variant="secondary" @click="showDomains = false">关闭</SlButton>
      </template>
    </SlModal>
  </div>
</template>

<style scoped>
.mb-4 { margin-bottom: 16px; }
.hidden-file { display: none; }
.nocache {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
  cursor: pointer;
}
.priority-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
}
.priority-field__label { opacity: 0.8; }
.priority-select {
  font-size: 12px;
  padding: 3px 8px;
  border: 1px solid var(--deploy-border, #d2d6dc);
  border-radius: 6px;
  background: var(--deploy-bg, #fff);
  color: var(--deploy-fg, #1f2937);
  cursor: pointer;
}
.priority-error {
  margin: 0;
  font-size: 12px;
  color: var(--deploy-danger, #d14343);
}
.upload-bar {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  padding: 12px 0;
}
.source-bar {
  padding: 12px 14px;
  margin-bottom: 16px;
}
.source-bar__row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.source-bar__tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--deploy-border);
}
.source-hint-toggle {
  margin-top: 8px;
  font-size: 12px;
}
.upload-bar__label {
  flex: 1;
  min-width: 180px;
}
.upload-hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
}
.tabs-actions-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--deploy-border);
  justify-content: flex-end;
}
.module-actions {
  padding: 14px 16px 8px;
  border-bottom: 1px solid var(--deploy-border);
}
.module-actions__primary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.more-wrap {
  position: relative;
}
.more-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 20;
  min-width: 210px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.more-menu__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
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
.more-menu__item:hover:not(:disabled) {
  background: var(--deploy-muted);
}
.more-menu__item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.more-menu__meta {
  font-size: 11px;
  color: var(--deploy-muted-fg);
  font-weight: 650;
}
.env-summary {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--deploy-border);
}
.env-summary__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.env-summary p {
  margin: 0;
  font-size: 13px;
  color: var(--deploy-fg-secondary);
  line-height: 1.5;
}
.os-entry__hint {
  margin: 0;
  padding: 0 16px 14px;
  font-size: 13px;
  line-height: 1.5;
}
.env-fmt-bar {
  display: flex;
  gap: 6px;
  margin: 0 0 8px;
}
.env-fmt-btn {
  border: 1px solid var(--deploy-border);
  background: var(--deploy-bg);
  color: var(--deploy-fg-secondary);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.env-fmt-btn--on {
  border-color: var(--deploy-accent, #2563eb);
  color: var(--deploy-fg);
  background: color-mix(in srgb, var(--deploy-accent, #2563eb) 12%, transparent);
}
.env-config-ta {
  width: 100%;
  box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.45;
  padding: 10px 12px;
  border: 1px solid var(--deploy-border);
  border-radius: 8px;
  background: var(--deploy-bg-elevated, var(--deploy-bg));
  color: var(--deploy-fg);
  resize: vertical;
  min-height: 220px;
}
.form-error {
  margin: 8px 0 0;
  font-size: 13px;
  color: #b91c1c;
}
.actions-cell {
  text-align: right;
  white-space: nowrap;
  width: 100px;
}
.actions-cell .link-btn + .link-btn { margin-left: 10px; }
.col-type {
  width: 72px;
  color: var(--deploy-fg-secondary);
  white-space: nowrap;
}
.links-modal__hint,
.modal-hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--deploy-fg-secondary);
  line-height: 1.55;
}
.danger-text { color: #b91c1c; }
.muted { color: var(--deploy-muted-fg); font-size: 13px; }
.migrate-hint {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--deploy-muted-fg);
}
.gen-deploy-pre {
  max-height: 360px;
  overflow: auto;
  padding: 12px;
  font-size: 12px;
  line-height: 1.4;
  background: #0f172a;
  color: #e2e8f0;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}

.pkg-list, .deploy-list { display: flex; flex-direction: column; }
.pkg-row, .deploy-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--deploy-border);
  background: #fff;
  text-align: left;
  width: 100%;
  border-left: none;
  border-right: none;
  border-top: none;
  font-family: inherit;
}
.deploy-row {
  cursor: pointer;
  transition: background 0.15s;
}
.deploy-row:hover { background: var(--deploy-accent-soft); }
.pkg-row__title, .deploy-row__top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pkg-row__meta, .deploy-row__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
}
.pkg-row__meta code, .deploy-row__meta code {
  font-family: var(--deploy-mono);
  font-size: 11px;
  background: var(--deploy-muted);
  padding: 1px 5px;
  border-radius: 4px;
}
.pkg-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--deploy-accent-soft);
  color: var(--deploy-primary);
  font-weight: 650;
}
.agent-mini {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fcd34d;
}
.deploy-row__go {
  font-size: 12px;
  color: var(--deploy-primary);
  white-space: nowrap;
  flex-shrink: 0;
}

.version-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 360px;
  overflow: auto;
}
.version-option {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--deploy-border);
  border-radius: 8px;
  cursor: pointer;
}
.version-option--active {
  border-color: #7dd3fc;
  background: var(--deploy-accent-soft);
}
.version-option__title {
  display: flex;
  gap: 8px;
  align-items: center;
}
.version-option__meta {
  display: flex;
  gap: 10px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
}
.version-option__meta code {
  font-family: var(--deploy-mono);
  font-size: 11px;
}

.danger-outline :deep(button),
.danger-outline {
  color: #b91c1c !important;
}
.danger-btn {
  --sl-primary-500: #dc2626;
  --sl-primary-600: #b91c1c;
}

.mt-2 { margin-top: 8px; }

.git-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  flex-wrap: wrap;
}
.git-summary__url {
  font-family: var(--deploy-mono);
  font-size: 12px;
  background: var(--deploy-muted);
  padding: 2px 6px;
  border-radius: 4px;
  word-break: break-all;
}
.git-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid var(--deploy-border);
}
.git-form__row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.git-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 200px;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
}
.git-select,
.git-token {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--deploy-border);
  border-radius: var(--deploy-radius);
  background: #fff;
  font-size: 13px;
  color: var(--deploy-fg);
  box-sizing: border-box;
}
.git-select:focus,
.git-token:focus {
  outline: none;
  border-color: var(--deploy-primary);
}
.git-clear {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
  cursor: pointer;
}
.agent-fix-opt {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 4px 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--deploy-border);
  border-radius: 8px;
  background: var(--deploy-muted);
  font-size: 12px;
  color: var(--deploy-fg-secondary);
  cursor: pointer;
  line-height: 1.5;
}
.agent-fix-opt input {
  margin-top: 2px;
}
.git-form__actions {
  display: flex;
  justify-content: flex-end;
}

.webhook-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border-top: 1px solid var(--deploy-border);
}
.webhook-panel__hint {
  margin: 0;
  font-size: 13px;
  color: var(--deploy-fg-secondary);
  line-height: 1.55;
}
.webhook-panel__loading {
  font-size: 13px;
  color: var(--deploy-fg-secondary);
}
.webhook-panel__url {
  display: block;
  font-family: var(--deploy-mono);
  font-size: 12px;
  background: var(--deploy-muted);
  padding: 8px 10px;
  border-radius: var(--deploy-radius);
  word-break: break-all;
  color: var(--deploy-fg);
}
.webhook-panel__row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
.webhook-panel__row .git-field {
  flex: 1;
  min-width: 240px;
}
.webhook-panel__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.source-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--deploy-border);
}
.source-tab {
  padding: 8px 14px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  font-size: 13px;
  font-weight: 650;
  color: var(--deploy-fg-secondary);
  cursor: pointer;
}
.source-tab--active {
  color: var(--deploy-primary);
  border-bottom-color: var(--deploy-primary);
}

@media (max-width: 768px) {
  .page-hero { flex-direction: column; align-items: stretch; }
  .page-hero__actions { justify-content: flex-start; flex-wrap: wrap; }
  .pkg-row, .deploy-row {
    flex-direction: column;
    align-items: stretch;
  }
  .pkg-row__actions, .deploy-row__go { align-self: flex-end; }
  .list-panel__tabs { flex-wrap: wrap; }
}

.domain-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.field-label {
  font-size: 12px;
  color: var(--deploy-fg-secondary);
  margin-top: 4px;
}
.field-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--deploy-border);
  border-radius: 8px;
  background: var(--deploy-bg-elevated, var(--deploy-bg));
  color: var(--deploy-fg);
  font-size: 13px;
}
</style>

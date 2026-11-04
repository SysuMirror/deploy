import { apiUrl } from '@/config/api-base';

const TOKEN_KEY = 'deploy-token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export class NotDeveloperError extends Error {
  joinUrl: string;
  platformUrl: string;
  constructor(message: string, joinUrl: string, platformUrl: string) {
    super(message);
    this.name = 'NotDeveloperError';
    this.joinUrl = joinUrl;
    this.platformUrl = platformUrl;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (!isForm && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(apiUrl(path), { ...options, headers });
  } catch {
    throw new Error(
      import.meta.env.DEV
        ? '无法连接后端 API，请确认 deploy-api 已在 localhost:3002 运行'
        : '无法连接后端 API'
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const body = data as { error?: string; code?: string };
    // 会话失效：清掉本地 token 回登录页（服务端已改用一次性会话 token）
    if (res.status === 401 && !path.startsWith('/auth/')) {
      clearToken();
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        const next = encodeURIComponent(
          window.location.pathname + window.location.search
        );
        window.location.href = `/login?redirect=${next}&reason=session-expired`;
      }
    }
    if (res.status === 403 && body.code === 'NOT_DEVELOPER') {
      const joinUrl =
        (data as { joinUrl?: string }).joinUrl || 'https://developer.ssemarket.cn/join';
      const platformUrl =
        (data as { platformUrl?: string }).platformUrl || 'https://developer.ssemarket.cn';
      // 保存身份信息，供门禁页展示。注意：这里返回特殊错误而非清理 token，
      // 由 App.vue / 登录回调用 Vue Router 引导到开发者门禁页，避免重置登录态。
      try {
        sessionStorage.setItem('deploy-not-dev', JSON.stringify({ joinUrl, platformUrl }));
      } catch {
        /* ignore */
      }
      throw new NotDeveloperError(body.error ?? '仅开发者可用', joinUrl, platformUrl);
    }
    throw new ApiError(body.error ?? `请求失败 (${res.status})`, res.status, body.code);
  }
  return data as T;
}

export type SessionUser = {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  oauthId?: string;
  isPlatformAdmin?: boolean;
};

export type Project = {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  visibility: string;
  quota: {
    modules: number;
    usedModules: number;
    environments: string[];
    dailyDeploy: number;
  };
  createdAt: string;
};

export type ModuleSlot = {
  deploymentId?: string;
  webPort?: number;
  apiPort?: number;
  port?: number;
  url?: string;
  apiUrl?: string;
};

export type Module = {
  id: string;
  projectId: string;
  name: string;
  repoUrl: string;
  buildCommand: string;
  appType: string;
  defaultBranch: string;
  gitProvider?: string;
  gitUsername?: string;
  hasGitToken?: boolean;
  hasWebhookSecret?: boolean;
  /** 访问模式：'root' 根路径 / 'subpath' /sdpy 前缀 / 'domain' 仅子域名 / '' 跟随平台默认 */
  pathMode?: 'root' | 'subpath' | 'domain' | '';
  /** 模块优先级：部署时注入为 PRIORITY 环境变量，sseinfra 据此排杀序 */
  priority: 'critical' | 'normal' | 'best_effort';
  packagePath?: string;
  packageVersion?: string;
  packageFileName?: string;
  createdBy?: string;
  test: ModuleSlot;
  prod: ModuleSlot;
  activePort?: number;
  activeUrl?: string;
  createdAt: string;
};

export type ModuleUrls = {
  test: string;
  testApi: string;
  prod: string;
  prodApi: string;
};

export type ModuleDomain = {
  id: string;
  moduleId: string;
  env: 'test' | 'prod';
  kind: 'subdomain' | 'custom';
  host: string;
  label: string;
  /** web=前端；api=后端 */
  routeTarget: 'web' | 'api';
  enabled: boolean;
  isPrimary: boolean;
  grayMatchType: 'none' | 'header' | 'query' | 'cookie';
  grayMatchKey: string;
  grayMatchValue: string;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
};

export type Deployment = {
  id: string;
  moduleId: string;
  branch: string;
  commitSha: string;
  env: 'test' | 'prod';
  action: 'deploy' | 'promote' | 'rollback' | 'migrate';
  status: string;
  url: string;
  apiUrl?: string;
  port: number;
  apiPort?: number;
  imageTag?: string;
  source?: 'package' | 'git';
  noCache?: boolean;
  sourceDeploymentId?: string;
  fixAttempts?: number;
  fixedByAgent?: boolean;
  useAgentFixer?: boolean;
  logs: string;
  operatorId: string;
  operatorName?: string;
  createdAt: string;
  finishedAt?: string;
};

export type PackageVersion = {
  id: string;
  moduleId: string;
  version: string;
  fileName: string;
  packagePath?: string;
  label: string;
  uploadedBy: string;
  uploadedByName?: string;
  createdAt: string;
  canDelete?: boolean;
  isCurrent?: boolean;
};

export type Application = {
  id: string;
  type: 'create_project' | 'join_project' | 'create_module' | 'join_module' | 'minio_bucket';
  status: 'pending' | 'approved' | 'rejected';
  applicantId: string;
  projectId?: string;
  moduleId?: string;
  payload: Record<string, unknown>;
  reviewNote: string;
  createdAt: string;
  reviewedAt?: string;
  applicantName?: string;
  projectName?: string;
  moduleName?: string;
};

export type AuditLogEntry = {
  id: string;
  action: string;
  actorId: string | null;
  actorName?: string;
  targetType: string;
  targetId: string;
  summary: string;
  meta: Record<string, unknown>;
  createdAt: string;
};

export type ProjectMember = {
  userId: string;
  name: string;
  email: string;
  avatarUrl?: string;
  role: string;
  joinedAt: string;
  /** null=可操作项目内全部模块；数组=仅这些模块 */
  moduleScope?: string[] | null;
};

/** 首页项目条目（含当前用户视角的归属信息） */
export type ProjectListEntry = {
  id: string;
  name: string;
  description: string;
  visibility: string;
  ownerId: string;
  ownerName: string;
  moduleCount: number;
  memberCount: number;
  isOwner: boolean;
  isMember: boolean;
  myRole: 'owner' | 'developer' | 'viewer' | null;
  createdAt: string;
};

export type DockerContainer = {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  uptimeSeconds?: number;
  lastCallAt?: string;
  composeProject?: string;
  isSdpy: boolean;
};

export type DockerImage = {
  id: string;
  repository: string;
  tag: string;
  digest?: string;
  size: string;
  sizeBytes: number;
  createdAt?: string;
  createdSince: string;
  dangling: boolean;
};

export type DockerVolume = {
  name: string;
  driver: string;
  mountpoint: string;
  labels: Record<string, string>;
  createdAt?: string;
  isSdpy: boolean;
};

export type DockerNetwork = {
  id: string;
  name: string;
  driver: string;
  scope: string;
  ipv6: boolean;
  internal: boolean;
  labels: Record<string, string>;
  createdAt?: string;
  isSdpy: boolean;
};

export type RecoveryJob = {
  id: string;
  moduleId: string;
  moduleName: string;
  env: string;
  group: string;
  target: string;
  maxMbps: number;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  phase: string;
  phaseLabel: string;
  percent: number;
  logs: string[];
  error: string;
  result: {
    matched: number;
    unmatched: number;
    orphan: number;
    dbRows: number;
    dbFile: string;
  } | null;
  startedAt: string;
  finishedAt: string | null;
};

export type DockerSystemInfo = {
  name: string;
  serverVersion: string;
  operatingSystem: string;
  architecture: string;
  ncpu: number;
  memTotalBytes: number;
  containers: number;
  containersRunning: number;
  containersStopped: number;
  images: number;
  dockerRootDir?: string;
};

export type DockerDiskUsage = {
  type: string;
  totalCount: number;
  active: number;
  size: string;
  reclaimable: string;
  sizeBytes: number;
  reclaimableBytes: number;
};

export type PlatformAdmin = {
  oauthId: string;
  userId?: string;
  name?: string;
  email?: string;
  addedBy?: string;
  addedAt?: string;
};

export type PlatformSettings = {
  agentFixerEnabled: boolean;
  agentFixerConfigured: boolean;
  baseDomain: string;
  publicBasePath: string;
  rootMode: boolean;
};

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  avatarUrl: string;
  oauthId: string;
};

export const api = {
  passwordLogin(email: string, password: string) {
    return request<{ token: string; expiresAt: string; user: SessionUser; isDeveloper: boolean }>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) }
    );
  },
  /** 静默 SSO：带共享父域 Cookie 换本地会话，失败由调用方静默回落登录表单 */
  ssoTry() {
    // 8s 超时：探测挂起不能让路由守卫（router.isReady 才 mount）挂死整页
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    return request<{ token: string; expiresAt: string; user: SessionUser; isDeveloper: boolean }>(
      '/auth/sso/try',
      { method: 'POST', signal: ac.signal }
    ).finally(() => clearTimeout(timer));
  },
  getMe() {
    return request<{ user: SessionUser }>('/auth/me');
  },
  logout() {
    return request<{ ok: boolean }>('/auth/logout', { method: 'POST' });
  },
  getBootstrap() {
    return request<{
      projects: Project[];
      baseDomain: string;
      publicBasePath?: string;
      rootMode?: boolean;
      agentFixerEnabled?: boolean;
      user?: SessionUser;
      gateRequired?: boolean;
      dev?: {
        configured: boolean;
        checked: boolean;
        isDeveloper: boolean;
        isAdmin: boolean;
        name?: string;
        effective?: boolean;
        joinUrl: string;
        platformUrl: string;
      };
    }>('/bootstrap');
  },
  listProjects() {
    return request<{ projects: Project[] }>('/v1/projects');
  },
  /** 首页「我创建的项目」 */
  listMyCreatedProjects() {
    return request<{ projects: ProjectListEntry[] }>('/v1/projects/mine');
  },
  /** 首页「全部项目」：我创建的 + 我参与的 + 公开项目，支持搜索 */
  listAllProjects(q = '') {
    const query = encodeURIComponent(q.trim());
    return request<{ projects: ProjectListEntry[] }>(
      `/v1/projects/all${query ? `?q=${query}` : ''}`
    );
  },
  searchPlatformUsers(q: string) {
    const query = encodeURIComponent(q.trim());
    return request<{
      users: Array<{ id: string; name: string; email: string; avatarUrl?: string }>;
    }>(`/v1/projects/user-search${query ? `?q=${query}` : ''}`);
  },
  setProjectMemberRole(projectId: string, userId: string, role: 'developer' | 'viewer') {
    return request<{ members: ProjectMember[] }>(
      `/v1/projects/${projectId}/members/${userId}/role`,
      { method: 'PUT', body: JSON.stringify({ role }) }
    );
  },
  setProjectMemberModules(
    projectId: string,
    userId: string,
    moduleIds: string[] | null
  ) {
    return request<{ members: ProjectMember[]; moduleScope: string[] | null }>(
      `/v1/projects/${projectId}/members/${userId}/modules`,
      { method: 'PUT', body: JSON.stringify({ moduleIds }) }
    );
  },
  setModuleAccessMode(moduleId: string, pathMode: 'root' | 'subpath' | 'domain' | '') {
    return request<{ module: Module }>(`/v1/modules/${moduleId}/path-mode`, {
      method: 'PATCH',
      body: JSON.stringify({ pathMode }),
    });
  },
  listProjectDirectory() {
    return request<{
      projects: Array<{
        id: string;
        name: string;
        description: string;
        visibility: string;
        isMember: boolean;
      }>;
    }>('/v1/projects/directory');
  },
  searchProjects(q: string) {
    const query = encodeURIComponent(q.trim());
    return request<{
      projects: Array<{
        id: string;
        name: string;
        description: string;
        visibility: string;
        isMember: boolean;
        moduleCount: number;
      }>;
    }>(`/v1/projects/search?q=${query}`);
  },
  createProject(data: {
    name: string;
    description?: string;
    visibility?: 'public' | 'private';
    direct?: boolean;
  }) {
    return request<{
      project?: Project;
      application?: Application;
      message?: string;
      direct?: boolean;
    }>('/v1/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  updateProject(
    id: string,
    data: { name?: string; description?: string; visibility?: 'public' | 'private' }
  ) {
    return request<{ project: Project }>(`/v1/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },
  getProject(id: string) {
    return request<{
      project: Project;
      modules: Module[];
      members?: ProjectMember[];
      baseDomain: string;
      publicBasePath?: string;
      rootMode?: boolean;
      canDelete?: boolean;
      canManageMembers?: boolean;
      isOwner?: boolean;
    }>(`/v1/projects/${id}`);
  },
  getProjectPreview(id: string) {
    return request<{
      project: Project;
      modules: Array<{
        id: string;
        name: string;
        testDeployed: boolean;
        prodDeployed: boolean;
      }>;
      moduleCount: number;
      readOnly: boolean;
      canJoin: boolean;
    }>(`/v1/projects/${id}/preview`);
  },
  deleteProject(id: string) {
    return request<{ ok: boolean }>(`/v1/projects/${id}`, { method: 'DELETE' });
  },
  joinProject(projectId: string, message?: string) {
    return request<{ application: Application; message?: string }>(
      `/v1/projects/${projectId}/join`,
      { method: 'POST', body: JSON.stringify({ message }) }
    );
  },
  addProjectMember(projectId: string, data: { userQuery: string; role?: string }) {
    return request<{ members: ProjectMember[] }>(`/v1/projects/${projectId}/members`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  removeProjectMember(projectId: string, userId: string) {
    return request<{ members: ProjectMember[] }>(
      `/v1/projects/${projectId}/members/${userId}`,
      { method: 'DELETE' }
    );
  },
  createModule(projectId: string, data: { name: string; direct?: boolean; pathMode?: string }) {
    return request<{
      module?: Module;
      application?: Application;
      message?: string;
      direct?: boolean;
    }>(`/v1/projects/${projectId}/modules`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  getModule(id: string) {
    return request<{
      module: Module;
      urls: ModuleUrls;
      domains?: ModuleDomain[];
      reservedSubdomains?: string[];
      members?: ProjectMember[];
      baseDomain: string;
      publicBasePath?: string;
      rootMode?: boolean;
      canDelete?: boolean;
      canWrite?: boolean;
      canManageMembers?: boolean;
    }>(`/v1/modules/${id}`);
  },
  deleteModule(id: string) {
    return request<{ ok: boolean }>(`/v1/modules/${id}`, { method: 'DELETE' });
  },
  joinModule(moduleId: string, message?: string) {
    return request<{ application: Application; message?: string }>(
      `/v1/modules/${moduleId}/join`,
      { method: 'POST', body: JSON.stringify({ message }) }
    );
  },
  addModuleMember(moduleId: string, data: { userQuery: string }) {
    return request<{ members: ProjectMember[] }>(`/v1/modules/${moduleId}/members`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  removeModuleMember(moduleId: string, userId: string) {
    return request<{ members: ProjectMember[] }>(
      `/v1/modules/${moduleId}/members/${userId}`,
      { method: 'DELETE' }
    );
  },
  listPackages(moduleId: string) {
    return request<{
      packages: PackageVersion[];
      currentVersion: string | null;
    }>(`/v1/modules/${moduleId}/packages`);
  },
  deletePackage(moduleId: string, version: string) {
    return request<{ ok: boolean; module: Module; packages: PackageVersion[] }>(
      `/v1/modules/${moduleId}/packages/${encodeURIComponent(version)}`,
      { method: 'DELETE' }
    );
  },
  uploadPackage(moduleId: string, file: File, label?: string) {
    const form = new FormData();
    form.append('package', file);
    if (label?.trim()) form.append('label', label.trim());
    return request<{
      module: Module;
      package: { version: string; fileName: string; composeFile: string; label: string };
      packages?: PackageVersion[];
    }>(`/v1/modules/${moduleId}/package`, {
      method: 'POST',
      body: form,
    });
  },
  listTemplates() {
    return request<{
      templates: Array<{ id: string; title: string; downloadPath: string }>;
    }>('/v1/templates');
  },
  async downloadTemplate(id: 'compose-module' | 'sseinfra-module') {
    const token = getToken();
    const res = await fetch(apiUrl(`/v1/templates/${id}.zip`), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error ?? `下载失败 (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${id}-template.zip`;
    a.click();
    URL.revokeObjectURL(url);
  },
  saveModuleGit(
    moduleId: string,
    data: {
      repoUrl: string;
      provider: string;
      branch: string;
      username?: string;
      token?: string;
      clearToken?: boolean;
    }
  ) {
    return request<{ module: Module }>(`/v1/modules/${moduleId}/git`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  /** 设置模块优先级（critical / normal / best_effort） */
  setModulePriority(moduleId: string, priority: 'critical' | 'normal' | 'best_effort') {
    return request<{ module: Module }>(`/v1/modules/${moduleId}/priority`, {
      method: 'PATCH',
      body: JSON.stringify({ priority }),
    });
  },
  listDeployments(moduleId: string) {
    return request<{ deployments: Deployment[] }>(`/v1/deployments/modules/${moduleId}/deployments`);
  },
  createDeployment(
    moduleId: string,
    data: {
      env?: 'test' | 'prod';
      noCache?: boolean;
      packageVersion?: string;
      source?: 'package' | 'git';
      branch?: string;
      useAgentFixer?: boolean;
      confirmAgentGenerate?: boolean;
    }
  ) {
    return request<{ deployment: Deployment }>(`/v1/deployments/modules/${moduleId}/deployments`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  promoteToProd(moduleId: string, data?: { noCache?: boolean }) {
    return request<{ deployment: Deployment }>(`/v1/deployments/modules/${moduleId}/promote`, {
      method: 'POST',
      body: JSON.stringify(data ?? {}),
    });
  },
  rollbackModule(moduleId: string, env: 'test' | 'prod', sourceDeploymentId?: string) {
    return request<{ deployment: Deployment }>(
      `/v1/deployments/modules/${moduleId}/rollback`,
      { method: 'POST', body: JSON.stringify({ env, sourceDeploymentId }) }
    );
  },
  getModuleLegacy(moduleId: string) {
    return request<{
      legacy: {
        anyLegacy: boolean;
        test: {
          env: string;
          legacy: boolean;
          reason: string;
          hostDataDir: string;
          dataExists: boolean;
          dataApproxBytes: number;
          webPort?: number;
          apiPort?: number;
        };
        prod: {
          env: string;
          legacy: boolean;
          reason: string;
          hostDataDir: string;
          dataExists: boolean;
          dataApproxBytes: number;
          webPort?: number;
          apiPort?: number;
        };
      };
      sseinfra: boolean;
    }>(`/v1/deployments/modules/${moduleId}/legacy`);
  },
  migrateModule(
    moduleId: string,
    data: {
      env: 'test' | 'prod';
      source?: 'package' | 'git';
      packageVersion?: string;
      branch?: string;
      force?: boolean;
      confirmAgentGenerate?: boolean;
    }
  ) {
    return request<{
      deployment: Deployment;
    }>(`/v1/deployments/modules/${moduleId}/migrate`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  applyMinioBucket(moduleId: string, env: 'test' | 'prod', reason?: string) {
    return request<{ application: Application; message: string }>(
      `/v1/modules/${moduleId}/minio-bucket-apply`,
      {
        method: 'POST',
        body: JSON.stringify({ env, reason: reason || '' }),
      }
    );
  },
  getModuleObjectStorage(moduleId: string, env: 'test' | 'prod') {
    return request<{
      current: {
        env: 'test' | 'prod';
        group: string;
        bucket: string;
        keyLabel: string;
        binding: {
          status: string;
          lastSyncAt: string | null;
          lastSyncBytes: number;
          lastSyncFiles: number;
          lastError: string;
          createdAt: string;
          updatedAt: string;
        } | null;
        hostDataDir: string;
        hostFiles: number;
        hostApproxBytes: number;
        policy: { deleteWithGroup: boolean; deleteWithModule: boolean; note: string };
      };
      all: Array<{
        env: string;
        bucket: string;
        keyLabel: string;
        status: string;
        lastSyncAt: string | null;
        lastSyncFiles: number;
        lastSyncBytes: number;
        lastError: string;
        createdAt: string;
        updatedAt: string;
      }>;
    }>(`/v1/modules/${moduleId}/object-storage?env=${env}`);
  },
  ensureModuleObjectStorage(moduleId: string, env: 'test' | 'prod') {
    return request<{
      bucket: string;
      keyLabel: string;
      logs: string[];
      message: string;
    }>(`/v1/modules/${moduleId}/object-storage/ensure`, {
      method: 'POST',
      body: JSON.stringify({ env }),
    });
  },
  syncModuleObjectStorage(moduleId: string, env: 'test' | 'prod', pushHostData = true) {
    return request<{
      job: {
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
      };
      message: string;
    }>(`/v1/modules/${moduleId}/object-storage/sync`, {
      method: 'POST',
      body: JSON.stringify({ env, pushHostData }),
    });
  },
  /** 列出当前环境桶内对象（需已审批开通） */
  listModuleBucketObjects(
    moduleId: string,
    env: 'test' | 'prod',
    opts?: { prefix?: string; limit?: number }
  ) {
    const q = new URLSearchParams({ env });
    if (opts?.prefix) q.set('prefix', opts.prefix);
    if (opts?.limit != null) q.set('limit', String(opts.limit));
    return request<{
      bucket: string;
      prefix: string;
      truncated: boolean;
      totalListed: number;
      objects: Array<{
        key: string;
        size: number;
        lastModified: string | null;
        etag?: string;
      }>;
    }>(`/v1/modules/${moduleId}/object-storage/objects?${q}`);
  },
  getModuleObjectStorageCredentials(moduleId: string, env: 'test' | 'prod') {
    return request<{
      keyLabel: string;
      bucket: string;
      endpoint: string;
      endpointNote: string;
      found: boolean;
      source: 'panel' | 'gpu_json' | null;
      credentials: {
        accessKey: string;
        secret: string;
        bucket: string;
      } | null;
      keysForLabel: Array<{
        label: string;
        bucket: string;
        accessKey: string;
        secret: string;
      }>;
      injectVars: Record<string, string> | null;
    }>(`/v1/modules/${moduleId}/object-storage/credentials?env=${env}`);
  },
  /** 该模块+环境下最新同步任务（含进行中，用于重进页面恢复） */
  getLatestMinioSyncJob(moduleId: string, env: 'test' | 'prod') {
    return request<{
      job: {
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
      } | null;
    }>(`/v1/modules/${moduleId}/object-storage/sync?env=${env}`);
  },
  getMinioSyncJob(moduleId: string, jobId: string) {
    return request<{
      job: {
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
      };
      status?: unknown;
    }>(`/v1/modules/${moduleId}/object-storage/sync/${jobId}`);
  },
  listAdminObjectStorage() {
    return request<{
      bindings: Array<{
        moduleId: string;
        env: string;
        bucket: string;
        keyLabel: string;
        status: string;
        lastSyncAt: string | null;
        lastSyncFiles: number;
        lastSyncBytes: number;
        updatedAt: string;
      }>;
      policy: string;
    }>('/v1/admin/object-storage');
  },
  getModuleEnvConfig(moduleId: string, env: 'test' | 'prod') {
    return request<{
      config: {
        env: 'test' | 'prod';
        vars: Record<string, string>;
        envFile: string;
        keyCount: number;
        updatedAt: string | null;
        dataDir: string;
        reservedKeys: string[];
      };
    }>(`/v1/modules/${moduleId}/env-config?env=${env}`);
  },
  saveModuleEnvConfig(
    moduleId: string,
    data: { env: 'test' | 'prod'; text?: string; vars?: Record<string, string> }
  ) {
    return request<{
      config: {
        env: 'test' | 'prod';
        vars: Record<string, string>;
        envFile: string;
        keyCount: number;
        dataDir: string;
      };
      message: string;
    }>(`/v1/modules/${moduleId}/env-config`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  listModuleDomains(moduleId: string, env?: 'test' | 'prod') {
    const q = env ? `?env=${env}` : '';
    return request<{
      domains: ModuleDomain[];
      baseDomain: string;
      reservedSubdomains: string[];
    }>(`/v1/modules/${moduleId}/domains${q}`);
  },
  addModuleDomain(
    moduleId: string,
    data: {
      env: 'test' | 'prod';
      kind: 'subdomain' | 'custom';
      value: string;
      routeTarget?: 'web' | 'api';
      isPrimary?: boolean;
      grayMatchType?: 'none' | 'header' | 'query' | 'cookie';
      grayMatchKey?: string;
      grayMatchValue?: string;
    }
  ) {
    return request<{ domain: ModuleDomain; message: string }>(`/v1/modules/${moduleId}/domains`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  updateModuleDomain(
    moduleId: string,
    domainId: string,
    data: {
      enabled?: boolean;
      isPrimary?: boolean;
      routeTarget?: 'web' | 'api';
      grayMatchType?: 'none' | 'header' | 'query' | 'cookie';
      grayMatchKey?: string;
      grayMatchValue?: string;
    }
  ) {
    return request<{ domain: ModuleDomain }>(`/v1/modules/${moduleId}/domains/${domainId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },
  deleteModuleDomain(moduleId: string, domainId: string) {
    return request<{ ok: boolean }>(`/v1/modules/${moduleId}/domains/${domainId}`, {
      method: 'DELETE',
    });
  },
  getModuleDataExport(moduleId: string, env: 'test' | 'prod') {
    return request<{
      export: {
        env: string;
        dataDir: string;
        exists: boolean;
        approxBytes: number;
        empty: boolean;
        tooLarge: boolean;
        maxBytes: number;
        fileName: string;
      };
    }>(`/v1/modules/${moduleId}/data-export?env=${env}`);
  },
  async downloadModuleData(moduleId: string, env: 'test' | 'prod', fileName?: string) {
    const token = getToken();
    const res = await fetch(apiUrl(`/v1/modules/${moduleId}/data-export.zip?env=${env}`), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error ?? `下载失败 (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || `${moduleId}-${env}-data.zip`;
    a.click();
    URL.revokeObjectURL(url);
  },
  cancelDeployment(id: string) {
    return request<{ ok: boolean; message: string }>(`/v1/deployments/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  getDeployment(id: string) {
    return request<{ deployment: Deployment }>(`/v1/deployments/${id}`);
  },
  getModuleWebhook(moduleId: string) {
    return request<{ enabled: boolean; secret: string; path: string; webhookUrl: string }>(
      `/v1/modules/${moduleId}/webhook`
    );
  },
  rotateModuleWebhook(moduleId: string) {
    return request<{ enabled: boolean; secret: string; path: string; webhookUrl: string }>(
      `/v1/modules/${moduleId}/webhook`,
      { method: 'POST', body: JSON.stringify({}) }
    );
  },

  // admin
  listApplications(mine?: boolean) {
    return request<{ applications: Application[] }>(
      `/v1/admin/applications${mine ? '?mine=1' : ''}`
    );
  },
  listAuditLogs(opts?: { limit?: number; action?: string }) {
    const q = new URLSearchParams();
    if (opts?.limit) q.set('limit', String(opts.limit));
    if (opts?.action) q.set('action', opts.action);
    const qs = q.toString();
    return request<{ logs: AuditLogEntry[] }>(`/v1/admin/audit-logs${qs ? `?${qs}` : ''}`);
  },
  reviewApplication(id: string, decision: 'approved' | 'rejected', note?: string) {
    return request<{ application: Application }>(`/v1/admin/applications/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision, note }),
    });
  },
  submitApplication(data: {
    type: Application['type'];
    projectId?: string;
    moduleId?: string;
    payload?: Record<string, unknown>;
  }) {
    return request<{ application: Application }>(`/v1/admin/applications`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  listContainers() {
    return request<{ containers: DockerContainer[] }>('/v1/admin/containers');
  },
  deleteContainers(ids: string[]) {
    return request<{ removed: string[]; errors: string[] }>('/v1/admin/containers/delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  },
  pruneContainers(data?: { onlySdpy?: boolean; includeRunning?: boolean }) {
    return request<{ removed: string[]; errors: string[] }>('/v1/admin/containers/prune', {
      method: 'POST',
      body: JSON.stringify(data ?? { onlySdpy: true }),
    });
  },
  reloadGateway() {
    return request<{ ok: boolean; message: string }>('/v1/admin/gateway/reload', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  pruneImages() {
    return request<{ message: string; reclaimed: string }>('/v1/admin/containers/prune-images', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  pruneBuilder() {
    return request<{ message: string; reclaimed: string }>('/v1/admin/containers/prune-builder', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  startContainers(ids: string[]) {
    return request<{ ok: string[]; errors: string[] }>('/v1/admin/containers/start', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  },
  stopContainers(ids: string[]) {
    return request<{ ok: string[]; errors: string[] }>('/v1/admin/containers/stop', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  },
  restartContainers(ids: string[]) {
    return request<{ ok: string[]; errors: string[] }>('/v1/admin/containers/restart', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  },
  listImages() {
    return request<{ images: DockerImage[] }>('/v1/admin/images');
  },
  deleteImages(ids: string[]) {
    return request<{ removed: string[]; errors: string[] }>('/v1/admin/images/delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  },
  listVolumes() {
    return request<{ volumes: DockerVolume[] }>('/v1/admin/volumes');
  },
  deleteVolumes(names: string[]) {
    return request<{ removed: string[]; errors: string[] }>('/v1/admin/volumes/delete', {
      method: 'POST',
      body: JSON.stringify({ names }),
    });
  },
  pruneVolumes() {
    return request<{ message: string; reclaimed: string }>('/v1/admin/volumes/prune', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  listNetworks() {
    return request<{ networks: DockerNetwork[] }>('/v1/admin/networks');
  },
  deleteNetworks(names: string[]) {
    return request<{ removed: string[]; errors: string[] }>('/v1/admin/networks/delete', {
      method: 'POST',
      body: JSON.stringify({ names }),
    });
  },
  pruneNetworks() {
    return request<{ message: string; reclaimed: string }>('/v1/admin/networks/prune', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  getSystem() {
    return request<{ info: DockerSystemInfo; disk: DockerDiskUsage[] }>('/v1/admin/system');
  },
  // —— 数据恢复任务（平台级：扫的是节点整块盘）——
  listRecoveryJobs() {
    return request<{ jobs: RecoveryJob[] }>('/v1/admin/recovery');
  },
  startRecoveryJob(data: {
    moduleId: string;
    env: 'test' | 'prod';
    target?: 'both' | 'images' | 'db';
    maxMbps?: number;
  }) {
    return request<{ job: RecoveryJob; message: string }>('/v1/admin/recovery', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  getRecoveryJob(jobId: string) {
    return request<{ job: RecoveryJob }>(`/v1/admin/recovery/${jobId}`);
  },
  cancelRecoveryJob(jobId: string) {
    return request<{ ok: boolean; message: string }>(
      `/v1/admin/recovery/${jobId}/cancel`,
      { method: 'POST' }
    );
  },
  listAdmins() {
    return request<{ admins: PlatformAdmin[] }>('/v1/admin/admins');
  },
  addAdmin(data: { oauthId?: string; userQuery?: string }) {
    return request<{ admins: PlatformAdmin[] }>('/v1/admin/admins', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  removeAdmin(oauthId: string) {
    return request<{ admins: PlatformAdmin[] }>(`/v1/admin/admins/${encodeURIComponent(oauthId)}`, {
      method: 'DELETE',
    });
  },
  listAdminUsers() {
    return request<{ users: AdminUser[] }>('/v1/admin/users');
  },
  getSettings() {
    return request<PlatformSettings>('/v1/admin/settings');
  },
  updateSettings(data: Partial<PlatformSettings>) {
    return request<PlatformSettings>('/v1/admin/settings', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  listAiEndpoints() {
    return request<{
      endpoints: AiCustomEndpointAdmin[];
      activeId: string | null;
      llmConfigured: boolean;
    }>('/v1/admin/settings/ai/custom-endpoints');
  },
  createAiEndpoint(data: {
    label: string;
    baseUrl: string;
    apiKey?: string;
    model: string;
    format: 'openai' | 'vllm';
  }) {
    return request<{ endpoint: AiCustomEndpointAdmin }>('/v1/admin/settings/ai/custom-endpoints', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  updateAiEndpoint(
    id: string,
    data: {
      label: string;
      baseUrl: string;
      apiKey?: string;
      model: string;
      format: 'openai' | 'vllm';
    }
  ) {
    return request<{ endpoint: AiCustomEndpointAdmin }>(
      `/v1/admin/settings/ai/custom-endpoints/${encodeURIComponent(id)}`,
      { method: 'PUT', body: JSON.stringify(data) }
    );
  },
  deleteAiEndpoint(id: string) {
    return request<{ ok: boolean }>(
      `/v1/admin/settings/ai/custom-endpoints/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
  },
  setActiveAiEndpoint(id: string) {
    return request<{
      endpoints: AiCustomEndpointAdmin[];
      activeId: string | null;
      llmConfigured: boolean;
    }>('/v1/admin/settings/ai/active-endpoint', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
  },
  getSseinfraSettings() {
    return request<{ sseinfra: SseinfraAdminSettings }>('/v1/admin/settings/sseinfra');
  },
  saveSseinfraSettings(data: {
    baseUrl?: string;
    username?: string;
    password?: string;
    clearPassword?: boolean;
    groupPrefix?: string;
    sshHost?: string;
    sshUser?: string;
    giteeToken?: string;
    clearGiteeToken?: boolean;
    defaultCpu?: string;
    defaultMem?: string;
    defaultStorage?: string;
  }) {
    return request<{ sseinfra: SseinfraAdminSettings }>('/v1/admin/settings/sseinfra', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  testSseinfraLogin(data?: {
    baseUrl?: string;
    username?: string;
    password?: string;
    groupPrefix?: string;
    sshHost?: string;
    sshUser?: string;
  }) {
    return request<{ ok: boolean; message?: string; error?: string; sseinfra: SseinfraAdminSettings }>(
      '/v1/admin/settings/sseinfra/test-login',
      { method: 'POST', body: JSON.stringify(data ?? {}) }
    );
  },
  generateDeploySh(
    moduleId: string,
    data?: { packageVersion?: string; apply?: boolean }
  ) {
    return request<{
      deploySh: string;
      applied: boolean;
      packagePath: string;
      hadDeploySh: boolean;
      writtenFiles: string[];
      summary: string;
      turns: number;
    }>(`/v1/modules/${moduleId}/agent/generate-deploy-sh`, {
      method: 'POST',
      body: JSON.stringify(data ?? { apply: true }),
    });
  },
};

export type AiCustomEndpointAdmin = {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  format: 'openai' | 'vllm';
  configured: boolean;
  maskedKey: string | null;
  hasApiKey: boolean;
  isActive: boolean;
};

export type SseinfraAdminSettings = {
  baseUrl: string;
  username: string;
  groupPrefix: string;
  sshHost: string;
  sshUser: string;
  defaultCpu: string;
  defaultMem: string;
  defaultStorage: string;
  cpuEnvLocked: boolean;
  memEnvLocked: boolean;
  storageEnvLocked: boolean;
  configured: boolean;
  usernameSource: 'env' | 'database' | 'none';
  usernameEnvLocked: boolean;
  passwordSource: 'env' | 'database' | 'none';
  passwordEnvLocked: boolean;
  maskedPassword: string | null;
  hasGiteeToken: boolean;
  giteeTokenEnvLocked: boolean;
  maskedGiteeToken: string | null;
};

/** 流式部署 Agent（SSE：tool_call / tool_result / assistant / done） */
export async function generateDeployShStream(
  moduleId: string,
  opts: {
    packageVersion?: string;
    apply?: boolean;
    onDelta?: (text: string) => void;
    onEvent?: (ev: Record<string, unknown>) => void;
    onDone?: (payload: {
      deploySh: string;
      applied: boolean;
      hadDeploySh: boolean;
      writtenFiles?: string[];
      summary?: string;
      turns?: number;
    }) => void;
    onError?: (message: string) => void;
  } = {}
): Promise<void> {
  const token = getToken();
  const res = await fetch(apiUrl(`/v1/modules/${moduleId}/agent/generate-deploy-sh/stream`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      packageVersion: opts.packageVersion,
      apply: opts.apply !== false,
    }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    throw new Error(t || `生成失败 (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamError: string | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const chunk of parts) {
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim()) as Record<string, unknown> & {
          type: string;
          text?: string;
          message?: string;
          deploySh?: string;
          applied?: boolean;
          hadDeploySh?: boolean;
          writtenFiles?: string[];
          summary?: string;
          turns?: number;
          name?: string;
          args?: Record<string, unknown>;
          ok?: boolean;
          preview?: string;
        };
        opts.onEvent?.(ev);
        if (ev.type === 'delta' && ev.text) opts.onDelta?.(ev.text);
        if (ev.type === 'assistant' && ev.text) opts.onDelta?.(ev.text);
        if (ev.type === 'meta' && ev.message) opts.onDelta?.(`[meta] ${ev.message}\n`);
        if (ev.type === 'tool_call') {
          opts.onDelta?.(
            `\n→ ${ev.name}(${JSON.stringify(ev.args ?? {}).slice(0, 160)})\n`
          );
        }
        if (ev.type === 'tool_result') {
          opts.onDelta?.(
            `← ${ev.ok ? 'ok' : 'fail'} ${ev.name}: ${String(ev.preview || '').slice(0, 200)}\n`
          );
        }
        if (ev.type === 'done' && ev.deploySh) {
          opts.onDone?.({
            deploySh: ev.deploySh,
            applied: Boolean(ev.applied),
            hadDeploySh: Boolean(ev.hadDeploySh),
            writtenFiles: ev.writtenFiles,
            summary: ev.summary,
            turns: ev.turns,
          });
        }
        if (ev.type === 'error') streamError = ev.message || '生成失败';
      } catch {
        // ignore
      }
    }
  }
  if (streamError) throw new Error(streamError);
}

// ===== 访问日志 / 监控 =====

export type MonitorModule = {
  id: string;
  name: string;
  projectName: string;
};

export type AccessLogEntry = {
  id: number;
  ts: string;
  host: string;
  method: string;
  path: string;
  api: string;
  moduleId: string;
  status: number;
  bytes: number;
  requestTimeMs: number;
  upstreamTimeMs: number;
  remoteAddr: string;
};

export type AggregatedApiEntry = {
  api: string;
  method: string;
  moduleId: string;
  /** 目标子域名：同 API 在不同站点分开统计 */
  host: string;
  count: number;
  errCount: number;
  avgTimeMs: number;
  lastTs: string;
  lastStatus: number;
};

export type AccessLogQueryParams = {
  moduleId?: string;
  api?: string;
  method?: string;
  statusClass?: string;
  host?: string;
  q?: string;
  from?: string;
  to?: string;
  /** 聚合粒度（分钟）；不传则后端按跨度自动选择 */
  bucket?: number;
  /** 预设窗口（分钟）；存在 from/to 时忽略 */
  minutes?: number;
  limit?: number;
  offset?: number;
};

/** 监控时间范围（后端解析结果）。from/to 为 UTC 分钟串 */
export type MonitorRange = {
  from: string;
  to: string;
  spanMinutes: number;
  bucketMinutes: number;
};

export type OverviewSeries = {
  series: Array<{
    api: string;
    statusClass: string;
    points: Array<{ minute: string; count: number }>;
  }>;
  /** 全站合计（按状态码分线），已对齐 timeline */
  global?: Array<{ statusClass: string; total: number; values: number[] }>;
  /** Top 接口摘要（含 5xx 数） */
  topApis?: Array<{ api: string; total: number; errTotal: number }>;
  range?: MonitorRange;
  /** 完整桶时间轴（覆盖整个请求区间），x 轴按此等距铺开 */
  timeline?: string[];
  /** 区间内出现过的接口总数 */
  apiTotal?: number;
};

export type TopApiEntry = {
  api: string;
  count: number;
  errCount: number;
};

export type TopApisResponse = {
  apis: TopApiEntry[];
  total: number;
  range: MonitorRange;
};

export type OverviewKpi = {
  total: number;
  errors: number;
  avgTimeMs: number;
  qps: number;
  range?: MonitorRange;
  rpsPerMinute: Array<{ minute: string; total: number; err: number }>;
};

export type ApiDetailBucket = {
  minute: string;
  total: number;
  /** 1xx（主要是 WebSocket 101 升级），由 total 减差得出 */
  s1xx: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  avgTimeMs: number;
};

export type ApiDetail = {
  api: string;
  range: MonitorRange;
  timeline: string[];
  buckets: ApiDetailBucket[];
  summary: {
    total: number;
    s1xx: number;
    s2xx: number;
    s3xx: number;
    s4xx: number;
    s5xx: number;
    errors: number;
    errorRate: number;
    avgTimeMs: number;
    peakPerBucket: number;
    peakMinute: string;
    avgPerMinute: number;
  };
  statusCodes: Array<{ code: number; count: number }>;
  methods: Array<{ method: string; count: number }>;
  hosts: Array<{ host: string; count: number }>;
  topPaths: Array<{ path: string; count: number }>;
  recentErrors: Array<{
    ts: string;
    method: string;
    path: string;
    status: number;
    requestTimeMs: number;
  }>;
  /** 明细层已过保留期（7 天）：分布为空但时序仍可用 */
  truncated: boolean;
};

export type MachineStatus = {
  current: {
    cpuPercent: number;
    memUsedMb: number;
    memTotalMb: number;
    load1: number;
    load5: number;
    load15: number;
    diskUsedGb: number;
    diskTotalGb: number;
    uptimeSec: number;
    hostname: string;
    platform: string;
  };
  history: Array<{ ts: string; cpuPercent: number; memUsedMb: number; load1: number }>;
  collector: { running: boolean; logPath: string; restartedAt: string | null };
};

export type ProcInfo = {
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  rssMb: number;
  state: string;
  startedAt: string;
  command: string;
  cmdline: string;
  protected: boolean;
};

export type ProcDaemonState = {
  lastCpu: number;
  lastMemPercent?: number;
  memUsedMb?: number;
  memTotalMb?: number;
  memWarnStreak?: number;
  lastMemWarnAt?: string | null;
  killStreak: number;
  lastKillInfo: string | null;
  warnThreshold?: number;
  killThreshold: number;
  memWarnThreshold?: number;
};

export type ProcessListResponse = {
  processes: ProcInfo[];
  total: number;
  canManage?: boolean;
  daemon: ProcDaemonState;
};

export type MailRecipientsResponse = {
  smtpConfigured: boolean;
  smtpHost: string;
  recipients: Array<{ id: string; email: string; name: string }>;
};

/* ===== 开发者平台对接（OA 审批 / 开发者身份） ===== */

export type DevIdentity = {
  configured: boolean;
  platformUrl: string;
  joinUrl: string;
  checked: boolean;
  isDeveloper: boolean;
  isAdmin: boolean;
  effective?: boolean;
  name?: string;
  reason?: string;
};

export type OaStatus = 'pending' | 'approved' | 'rejected';

export type OaItem = {
  oaid: string;
  moduleId: number;
  moduleSlug: string;
  moduleName: string;
  title: string;
  content: string;
  extra: Record<string, unknown>;
  status: OaStatus;
  currentNode: string | null;
  timeline: Array<{ action: string; viaModule?: string; by?: string | null; note?: string; at: string }>;
  submitAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
};

export type OaListEntry = {
  oaid: string;
  localTitle: string;
  createdAt: string;
  item: OaItem | null;
  online: boolean;
};

export const devApi = {
  me() {
    return request<DevIdentity>('/v1/dev/me');
  },
  oaList() {
    return request<{ items: OaListEntry[]; platformUrl: string }>('/v1/dev/oa/list');
  },
  oaSubmit(input: { title: string; content?: string }) {
    return request<{ item: OaItem }>('/v1/dev/oa/submit', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  oaQuery(oaid: string) {
    return request<{ item: OaItem }>(`/v1/dev/oa/${encodeURIComponent(oaid)}`);
  },
};

function monitorQuery(params: AccessLogQueryParams & { aggregate?: boolean }): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    // 后端以 "1" 判断聚合开关，布尔需特判序列化
    q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const monitorApi = {
  listModules() {
    return request<{ modules: MonitorModule[] }>('/v1/monitor/modules');
  },
  listLogs(params: AccessLogQueryParams & { aggregate?: boolean }) {
    return request<{ logs?: AccessLogEntry[]; groups?: AggregatedApiEntry[]; total: number }>(
      `/v1/monitor/logs${monitorQuery(params)}`
    );
  },
  listFacets(params: AccessLogQueryParams) {
    return request<{ apis: string[]; methods: string[]; hosts: string[] }>(
      `/v1/monitor/facets${monitorQuery(params)}`
    );
  },
  overview(params: AccessLogQueryParams) {
    return request<{ kpi: OverviewKpi } & OverviewSeries>(
      `/v1/monitor/overview${monitorQuery(params)}`
    );
  },
  /** 单接口详情：分桶时序 + 汇总 + 状态码/方法/host 分布 + 近期错误 */
  apiDetail(params: AccessLogQueryParams & { api: string }) {
    return request<ApiDetail>(`/v1/monitor/api-detail${monitorQuery(params)}`);
  },
  /** 区间内按流量排序的接口榜（供「按接口查看」选择器） */
  listApis(params: AccessLogQueryParams) {
    return request<TopApisResponse>(`/v1/monitor/apis${monitorQuery(params)}`);
  },
  machine(minutes = 30) {
    return request<MachineStatus>(`/v1/monitor/machine?minutes=${minutes}`);
  },
  listProcesses(q?: string, sort: 'cpu' | 'mem' | 'pid' = 'cpu') {
    const p = new URLSearchParams({ sort });
    if (q) p.set('q', q);
    return request<ProcessListResponse>(`/v1/proc?${p.toString()}`);
  },
  killProcess(pid: number, force = false) {
    return request<{ ok: boolean; message: string }>(`/v1/proc/${pid}/kill`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    });
  },
  mailTest() {
    return request<{ ok: boolean; log: string; error?: string; recipients: string[] }>('/v1/proc/mail-test', {
      method: 'POST',
      body: '{}',
    });
  },
  mailRecipients() {
    return request<MailRecipientsResponse>('/v1/proc/mail-recipients');
  },
};

/* ------------------------------------------------------------------ *
 * 脚本应用（非部署台应用）：网页下发宿主命令
 * ------------------------------------------------------------------ */

/** 命令组的参数预设：值为空即不拼接，所以「可选」就是留空 */
export type ScriptParam = {
  id: string;
  commandId: string;
  flag: string;
  label: string;
  placeholder: string;
  defaultValue: string;
  required: boolean;
  valueMode: 'value' | 'switch';
  inputType: 'text' | 'select';
  options: string[];
  sortOrder: number;
};

/** 命令组：一个应用下可有任意多个，自由命名 */
export type ScriptCommand = {
  id: string;
  appId: string;
  /** 命令组名，如「部署到测试」 */
  name: string;
  description: string;
  /** 命令主体 */
  mainCommand: string;
  sortOrder: number;
  params: ScriptParam[];
};

export type ScriptMemberRole = 'owner' | 'member';

export type ScriptAppMember = {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string;
  role: ScriptMemberRole;
  joinedAt: string;
  isSelf?: boolean;
};

export type ScriptApp = {
  id: string;
  name: string;
  description: string;
  workdir: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  commands: ScriptCommand[];
  memberCount: number;
  members?: ScriptAppMember[];
  /** 当前用户是否可执行（是成员 / 创建者 / 平台管理员） */
  canRun: boolean;
  /** 当前用户是否可改删（创建者 / 平台管理员） */
  canManage: boolean;
  /** 当前用户是否已加入 */
  joined: boolean;
};

export type ScriptRun = {
  id: string;
  appId: string;
  commandId: string;
  /** 执行时的命令组名快照 */
  commandName: string;
  commandLine: string;
  workdir: string;
  status: string;
  exitCode: number | null;
  output: string;
  operatorId: string;
  operatorName: string;
  createdAt: string;
  finishedAt: string | null;
};

/** 提交给后端的参数定义 */
export type ScriptParamInput = {
  flag: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  valueMode?: 'value' | 'switch';
  inputType?: 'text' | 'select';
  options?: string[];
};

export type ScriptCommandInput = {
  name: string;
  description?: string;
  mainCommand: string;
  params?: ScriptParamInput[];
};

export type ScriptAppInput = {
  name: string;
  description?: string;
  workdir: string;
  enabled?: boolean;
  commands?: ScriptCommandInput[];
};

export type ScriptStreamEvent = {
  type: 'meta' | 'replay' | 'start' | 'chunk' | 'end';
  runId?: string;
  status?: string;
  exitCode?: number | null;
  commandLine?: string;
  commandName?: string;
  workdir?: string;
  stream?: 'stdout' | 'stderr';
  text?: string;
};

export const scriptsApi = {
  list() {
    return request<{ apps: ScriptApp[]; running: number }>('/v1/scripts');
  },
  create(input: ScriptAppInput) {
    return request<{ app: ScriptApp }>('/v1/scripts', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  get(id: string) {
    return request<{ app: ScriptApp; runs: ScriptRun[] }>(
      `/v1/scripts/${encodeURIComponent(id)}`
    );
  },
  update(id: string, input: ScriptAppInput) {
    return request<{ app: ScriptApp }>(`/v1/scripts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },
  remove(id: string) {
    return request<{ ok: boolean }>(`/v1/scripts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  /* —— 成员 —— */
  join(id: string) {
    return request<{ app: ScriptApp; members: ScriptAppMember[] }>(
      `/v1/scripts/${encodeURIComponent(id)}/join`,
      { method: 'POST', body: '{}' }
    );
  },
  leave(id: string) {
    return request<{ app: ScriptApp; members: ScriptAppMember[] }>(
      `/v1/scripts/${encodeURIComponent(id)}/leave`,
      { method: 'POST', body: '{}' }
    );
  },
  members(id: string) {
    return request<{ members: ScriptAppMember[] }>(
      `/v1/scripts/${encodeURIComponent(id)}/members`
    );
  },
  removeMember(id: string, userId: string) {
    return request<{ members: ScriptAppMember[] }>(
      `/v1/scripts/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' }
    );
  },

  /* —— 执行 —— */
  /** 只拼接不执行：执行前预览最终命令行，避免参数拼错白跑一次 */
  preview(id: string, commandId: string, values: Record<string, string>) {
    return request<{
      commandLine: string;
      workdir: string;
      fullScript: string;
      commandName: string;
    }>(`/v1/scripts/${encodeURIComponent(id)}/preview`, {
      method: 'POST',
      body: JSON.stringify({ commandId, values }),
    });
  },
  run(id: string, commandId: string, values: Record<string, string>) {
    return request<{ runId: string; commandLine: string; workdir: string; commandName: string }>(
      `/v1/scripts/${encodeURIComponent(id)}/run`,
      { method: 'POST', body: JSON.stringify({ commandId, values }) }
    );
  },
  runs(id: string) {
    return request<{ runs: ScriptRun[] }>(`/v1/scripts/${encodeURIComponent(id)}/runs`);
  },
  getRun(runId: string) {
    return request<{ run: ScriptRun; live: boolean }>(
      `/v1/scripts/runs/${encodeURIComponent(runId)}`
    );
  },
  cancelRun(runId: string) {
    return request<{ ok: boolean; message: string }>(
      `/v1/scripts/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST', body: '{}' }
    );
  },
  /**
   * 订阅执行输出（SSE）。
   * 与 generate-deploy-sh/stream 同套路：POST + fetch 流式读，
   * 这样能带 Authorization 头（EventSource 既不能带 header 也不支持 POST）。
   * 返回 abort 函数供组件卸载 / 用户手动停止时调用。
   */
  streamRun(runId: string, onEvent: (ev: ScriptStreamEvent) => void): () => void {
    const controller = new AbortController();
    const token = getToken();
    void (async () => {
      try {
        const res = await fetch(
          apiUrl(`/v1/scripts/runs/${encodeURIComponent(runId)}/stream`),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: '{}',
            signal: controller.signal,
          }
        );
        if (!res.ok || !res.body) {
          onEvent({ type: 'end', status: 'failed', text: `连接执行输出失败 (${res.status})` });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const chunk of parts) {
            const line = chunk.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            try {
              onEvent(JSON.parse(line.slice(5).trim()) as ScriptStreamEvent);
            } catch {
              /* 心跳等非 JSON 行，忽略 */
            }
          }
        }
      } catch (e) {
        if ((e as Error)?.name !== 'AbortError') {
          onEvent({ type: 'end', status: 'failed', text: `输出流中断：${(e as Error).message}` });
        }
      }
    })();
    return () => controller.abort();
  },
};

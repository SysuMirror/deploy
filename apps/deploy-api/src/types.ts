export interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl: string;
  oauthId: string;
  /** 是否集市开发者平台确认的开发者（登录签发 token 时写入会话，鉴权中间件据此校验） */
  isDeveloper?: boolean;
}

export interface ProjectQuota {
  modules: number;
  usedModules: number;
  environments: string[];
  dailyDeploy: number;
  usedDeployToday: string;
  members: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  visibility: 'public' | 'private';
  quota: ProjectQuota;
  createdAt: string;
}

export type ProjectMemberRole = 'owner' | 'developer' | 'viewer';

/** 部署槽位：test=测试，prod=正式 */
export type DeployEnv = 'test' | 'prod';

/** 部署来源：package=上传压缩包，git=拉取 Git 仓库分支 */
export type DeploymentSource = 'package' | 'git';

export type ReleaseAction = 'deploy' | 'promote' | 'rollback' | 'migrate';

export interface ModuleSlot {
  deploymentId?: string;
  webPort?: number;
  apiPort?: number;
  /** 前端公网 URL */
  url?: string;
  /** 后端公网 URL */
  apiUrl?: string;
  /** @deprecated 兼容旧单端口 */
  port?: number;
}

export interface Module {
  id: string;
  projectId: string;
  name: string;
  /** 兼容旧字段，zip 模式下为空；Git 部署时为仓库地址 */
  repoUrl: string;
  buildCommand: string;
  appType: 'frontend' | 'backend' | 'fullstack';
  defaultBranch: string;
  /** Git 仓库来源：'' | 'gitee' | 'github' | 'generic' */
  gitProvider?: string;
  /** Git 私有仓库用户名（可选，GitHub 无需） */
  gitUsername?: string;
  /** 是否已配置 Git 访问令牌（永不回传明文） */
  hasGitToken?: boolean;
  /** 是否已配置 Git webhook 密钥 */
  hasWebhookSecret?: boolean;
  /** 挂载路径模式：'root' 根路径 / 'subpath' /sdpy 前缀 / '' 跟随平台默认 */
  /** 访问模式：root=根路径 / subpath=/sdpy 前缀 / domain=仅子域名 / ''=跟随平台默认 */
  pathMode?: 'root' | 'subpath' | 'domain' | '';
  /**
   * 模块优先级：critical(尽量不杀) / normal / best_effort(压力高时可先 checkpoint/停)。
   * 部署时作为 PRIORITY 环境变量推进 sseinfra 组，底层据此排杀序。
   */
  priority: 'critical' | 'normal' | 'best_effort';
  packagePath?: string;
  packageVersion?: string;
  packageFileName?: string;
  createdBy: string;
  createdAt: string;
  test: ModuleSlot;
  prod: ModuleSlot;
  /** @deprecated 兼容旧字段 */
  activePort?: number;
  activeUrl?: string;
}

export type DeploymentStatus =
  | 'pending'
  | 'unpacking'
  | 'building'
  | 'deploying'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'cloning';

export interface Deployment {
  id: string;
  moduleId: string;
  branch: string;
  commitSha: string;
  env: DeployEnv;
  action: ReleaseAction;
  status: DeploymentStatus;
  url: string;
  apiUrl?: string;
  port: number;
  apiPort?: number;
  imageTag: string;
  /** 部署来源：package / git */
  source: DeploymentSource;
  /** 是否 --no-cache 构建 */
  noCache?: boolean;
  sourceDeploymentId?: string;
  /** Agent 自愈重试次数 */
  fixAttempts?: number;
  /** 是否曾由 Agent 修复器介入 */
  fixedByAgent?: boolean;
  /** 本次部署是否请求了 Agent 自愈 */
  useAgentFixer?: boolean;
  /** 用户已确认缺 deploy.sh 时由 Agent 生成 */
  confirmAgentGenerate?: boolean;
  logs: string;
  operatorId: string;
  operatorName?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface ModulePublicUrls {
  test: string;
  testApi: string;
  prod: string;
  prodApi: string;
}

/** 模块上传包的版本记录（永久保留，可按版本重新部署） */
export interface PackageVersion {
  id: string;
  moduleId: string;
  version: string;
  fileName: string;
  packagePath: string;
  /** 用户标签，默认可用文件名 */
  label: string;
  uploadedBy: string;
  createdAt: string;
}

export type ApplicationType =
  | 'create_project'
  | 'join_project'
  | 'create_module'
  | 'join_module'
  | 'minio_bucket';

export type ApplicationStatus = 'pending' | 'approved' | 'rejected';

export interface Application {
  id: string;
  type: ApplicationType;
  status: ApplicationStatus;
  applicantId: string;
  projectId?: string;
  moduleId?: string;
  payload: Record<string, unknown>;
  reviewNote: string;
  reviewerId?: string;
  createdAt: string;
  reviewedAt?: string;
  /** 展示用 */
  applicantName?: string;
  projectName?: string;
  moduleName?: string;
}

export interface ProjectMember {
  userId: string;
  name: string;
  email: string;
  role: ProjectMemberRole;
  joinedAt: string;
}

export interface DockerContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  uptimeSeconds?: number;
  /** 尽力而为：来自 docker inspect / 部署记录，可能为空 */
  lastCallAt?: string;
  labels: Record<string, string>;
  composeProject?: string;
  isSdpy: boolean;
}

export interface DockerImageInfo {
  id: string;
  repository: string;
  tag: string;
  digest?: string;
  size: string;
  sizeBytes: number;
  createdAt?: string;
  createdSince: string;
  /** 悬空镜像（Repository/Tag 均为 <none>） */
  dangling: boolean;
}

export interface DockerVolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  labels: Record<string, string>;
  createdAt?: string;
  isSdpy: boolean;
}

export interface DockerNetworkInfo {
  id: string;
  name: string;
  driver: string;
  scope: string;
  ipv6: boolean;
  internal: boolean;
  labels: Record<string, string>;
  createdAt?: string;
  isSdpy: boolean;
}

/** docker info 精简出的主机 / 守护进程概况 */
export interface DockerSystemInfo {
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
}

  /** docker system df 中单类资源（Images / Containers / Local Volumes / Build Cache） */
  export interface DockerDiskUsageRow {
    type: string;
    totalCount: number;
    active: number;
    size: string;
    reclaimable: string;
    sizeBytes: number;
    reclaimableBytes: number;
  }

/* ------------------------------------------------------------------ *
 * 脚本应用（非部署台应用）：网页下发宿主命令
 * ------------------------------------------------------------------ */

/** 命令组的参数预设：flag 必填，值可留空即「可选」 */
export interface ScriptParam {
  id: string;
  commandId: string;
  /** 参数名，如 --branch */
  flag: string;
  label: string;
  placeholder: string;
  defaultValue: string;
  required: boolean;
  /** value=带值（--flag 值）；switch=开关（只拼 --flag） */
  valueMode: 'value' | 'switch';
  /** text=自由填写；select=从 options 里选 */
  inputType: 'text' | 'select';
  options: string[];
  sortOrder: number;
}

/** 命令组：一个应用下可以有任意多个，自由命名 */
export interface ScriptCommand {
  id: string;
  appId: string;
  /** 命令组名，如「部署到测试」 */
  name: string;
  /** 命令组说明（可选） */
  description: string;
  /** 命令主体，原样拼接（可写 cd .. && python3 xxx.py） */
  mainCommand: string;
  sortOrder: number;
  params: ScriptParam[];
}

export type ScriptMemberRole = 'owner' | 'member';

export interface ScriptAppMember {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string;
  role: ScriptMemberRole;
  joinedAt: string;
  /** 便于前端标注「这是当前登录用户」 */
  isSelf?: boolean;
}

export interface ScriptApp {
  id: string;
  name: string;
  description: string;
  /** 执行时 cd 到的根目录 */
  workdir: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  commands: ScriptCommand[];
  /** 成员数与成员列表（列表接口只给数量，详情接口给全量） */
  memberCount: number;
  members?: ScriptAppMember[];
  /** 当前请求者是否可执行（是成员 / 创建者 / 平台管理员） */
  canRun: boolean;
  /** 当前请求者是否可改删（创建者 / 平台管理员） */
  canManage: boolean;
  /** 当前请求者是否已加入 */
  joined: boolean;
}

export type ScriptRunStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'timeout'
  | 'interrupted';

export interface ScriptRun {
  id: string;
  appId: string;
  commandId: string;
  /** 执行时的命令组名快照 */
  commandName: string;
  /** 最终拼接的完整命令行 */
  commandLine: string;
  workdir: string;
  status: string;
  exitCode: number | null;
  output: string;
  operatorId: string;
  /** 执行人显示名（前端直接展示，避免再查一次用户表） */
  operatorName: string;
  createdAt: string;
  finishedAt: string | null;
}

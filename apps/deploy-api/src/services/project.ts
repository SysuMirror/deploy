import { nanoid } from 'nanoid';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { db } from '../db/init.js';
import { getWorkDir } from '../config/paths.js';
import type {
  Project,
  ProjectMemberRole,
  ProjectQuota,
  Module,
  Deployment,
  DeployEnv,
  ReleaseAction,
  PackageVersion,
  DeploymentSource,
} from '../types.js';
import {
  buildModulePublicUrls,
  buildPublicUrl,
  composeProjectName,
  regenerateNginxRoutes,
  RESERVED_MODULE_NAMES,
  stopComposeProject,
} from './routing.js';
import { removeModuleUploads, removePackageVersionDir, hasDeploySh } from './package-store.js';
import { getUserById } from './user.js';
import { isLegacyComposeSlot } from './legacy-migrate.js';
import { isSseinfraRuntime, sseinfraGroupName, SseinfraClient } from './sseinfra-client.js';

const DEFAULT_QUOTA: ProjectQuota = {
  modules: 2,
  usedModules: 0,
  environments: ['test', 'prod'],
  dailyDeploy: 10,
  usedDeployToday: '0',
  members: 5,
};

function parseQuota(json: string): ProjectQuota {
  try {
    return { ...DEFAULT_QUOTA, ...JSON.parse(json) };
  } catch {
    return { ...DEFAULT_QUOTA };
  }
}

type ModuleRow = {
  id: string;
  project_id: string;
  name: string;
  repo_url: string;
  build_command: string;
  app_type: string;
  default_branch: string;
  package_path: string | null;
  package_version: string | null;
  package_file_name: string | null;
  git_provider: string | null;
  git_username: string | null;
  git_token: string | null;
  git_webhook_secret: string | null;
  path_mode: string | null;
  priority: string;
  created_by: string;
  created_at: string;
  active_port: number | null;
  active_url: string | null;
  active_test_port: number | null;
  active_test_url: string | null;
  active_test_deployment_id: string | null;
  active_prod_port: number | null;
  active_prod_url: string | null;
  active_prod_deployment_id: string | null;
  active_test_web_port: number | null;
  active_test_api_port: number | null;
  active_test_api_url: string | null;
  active_prod_web_port: number | null;
  active_prod_api_port: number | null;
  active_prod_api_url: string | null;
};

function mapModuleRow(r: ModuleRow): Module {
  const testWeb = r.active_test_web_port ?? r.active_test_port ?? undefined;
  const prodWeb = r.active_prod_web_port ?? r.active_prod_port ?? undefined;
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    repoUrl: r.repo_url ?? '',
    buildCommand: r.build_command ?? '',
    appType: (r.app_type as Module['appType']) || 'fullstack',
    defaultBranch: r.default_branch,
    gitProvider: r.git_provider ?? '',
    gitUsername: r.git_username ?? '',
    hasGitToken: Boolean(r.git_token),
    hasWebhookSecret: Boolean(r.git_webhook_secret),
    pathMode: (r.path_mode ?? '') as Module['pathMode'],
    priority: (r.priority as Module['priority']) || 'normal',
    packagePath: r.package_path ?? undefined,
    packageVersion: r.package_version ?? undefined,
    packageFileName: r.package_file_name ?? undefined,
    createdBy: r.created_by,
    createdAt: r.created_at,
    test: {
      webPort: testWeb,
      apiPort: r.active_test_api_port ?? undefined,
      port: testWeb,
      url: r.active_test_url ?? undefined,
      apiUrl: r.active_test_api_url ?? undefined,
      deploymentId: r.active_test_deployment_id ?? undefined,
    },
    prod: {
      webPort: prodWeb,
      apiPort: r.active_prod_api_port ?? undefined,
      port: prodWeb,
      url: r.active_prod_url ?? undefined,
      apiUrl: r.active_prod_api_url ?? undefined,
      deploymentId: r.active_prod_deployment_id ?? undefined,
    },
    activePort: testWeb ?? r.active_port ?? undefined,
    activeUrl: r.active_test_url ?? r.active_url ?? undefined,
  };
}

type DeploymentRow = {
  id: string;
  module_id: string;
  branch: string;
  commit_sha: string;
  env: string;
  action: string;
  status: string;
  url: string;
  api_url: string;
  port: number;
  api_port: number;
  image_tag: string;
  source: string | null;
  no_cache: number | null;
  source_deployment_id: string | null;
  fix_attempts: number | null;
  fixed_by_agent: number | null;
  use_agent_fixer: number | null;
  confirm_agent_generate: number | null;
  logs: string;
  operator_id: string;
  created_at: string;
  finished_at: string | null;
};

function mapDeploymentRow(r: DeploymentRow): Deployment {
  return {
    id: r.id,
    moduleId: r.module_id,
    branch: r.branch,
    commitSha: r.commit_sha,
    env: r.env as DeployEnv,
    action: (r.action || 'deploy') as ReleaseAction,
    status: r.status as Deployment['status'],
    url: r.url,
    apiUrl: r.api_url || undefined,
    port: r.port,
    apiPort: r.api_port || undefined,
    imageTag: r.image_tag,
    source: (r.source === 'git' ? 'git' : 'package') as DeploymentSource,
    noCache: Boolean(r.no_cache),
    sourceDeploymentId: r.source_deployment_id ?? undefined,
    fixAttempts: r.fix_attempts ?? 0,
    fixedByAgent: Boolean(r.fixed_by_agent),
    useAgentFixer: Boolean(r.use_agent_fixer),
    confirmAgentGenerate: Boolean(r.confirm_agent_generate),
    logs: r.logs,
    operatorId: r.operator_id,
    operatorName: getUserById(r.operator_id)?.name,
    createdAt: r.created_at,
    finishedAt: r.finished_at ?? undefined,
  };
}

type PackageRow = {
  id: string;
  module_id: string;
  version: string;
  file_name: string;
  package_path: string;
  label: string;
  uploaded_by: string;
  created_at: string;
};

function mapPackageRow(r: PackageRow): PackageVersion {
  return {
    id: r.id,
    moduleId: r.module_id,
    version: r.version,
    fileName: r.file_name,
    packagePath: r.package_path,
    label: r.label || r.file_name,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
  };
}

function projectRow(row: {
  id: string;
  name: string;
  description: string;
  owner_id: string;
  visibility: string;
  quota_json: string;
  created_at: string;
}): Project {
  const quota = parseQuota(row.quota_json);
  const usedModules = db
    .prepare('SELECT COUNT(*) as c FROM modules WHERE project_id = ?')
    .get(row.id) as { c: number };
  quota.usedModules = usedModules.c;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerId: row.owner_id,
    visibility: row.visibility as Project['visibility'],
    quota,
    createdAt: row.created_at,
  };
}

export function getProjectRole(projectId: string, userId: string): ProjectMemberRole | null {
  const row = db
    .prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
    .get(projectId, userId) as { role: string } | undefined;
  return row ? (row.role as ProjectMemberRole) : null;
}

export function canWriteProject(projectId: string, userId: string): boolean {
  const role = getProjectRole(projectId, userId);
  return role === 'owner' || role === 'developer';
}

export function canReadProject(projectId: string, userId: string): boolean {
  return Boolean(getProjectRole(projectId, userId));
}

export function isProjectOwner(projectId: string, userId: string): boolean {
  return getProjectRole(projectId, userId) === 'owner';
}

/** 用户可读的模块名集合（项目成员可见项目下全部模块 + 直接模块成员） */
export function listAccessibleModuleNames(userId: string): string[] {
  const names = new Set<string>();
  const viaModule = db
    .prepare(
      `SELECT m.name FROM module_members mm JOIN modules m ON m.id = mm.module_id WHERE mm.user_id = ?`
    )
    .all(userId) as Array<{ name: string }>;
  const viaProject = db
    .prepare(
      `SELECT m.name FROM project_members pm JOIN modules m ON m.project_id = pm.project_id WHERE pm.user_id = ?`
    )
    .all(userId) as Array<{ name: string }>;
  for (const r of viaModule) names.add(r.name);
  for (const r of viaProject) names.add(r.name);
  return [...names];
}

export function listProjectMembers(projectId: string) {
  const rows = db
    .prepare(
      `SELECT pm.user_id as userId, pm.role, pm.joined_at as joinedAt, pm.module_scope_json as moduleScopeJson,
              u.name, u.email, u.avatar_url as avatarUrl
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ?
       ORDER BY pm.joined_at ASC`
    )
    .all(projectId) as Array<{
    userId: string;
    role: string;
    joinedAt: string;
    moduleScopeJson: string | null;
    name: string;
    email: string;
    avatarUrl: string;
  }>;
  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    email: r.email,
    avatarUrl: r.avatarUrl || '',
    role: r.role as ProjectMemberRole,
    joinedAt: r.joinedAt,
    moduleScope: parseModuleScope(r.moduleScopeJson),
  }));
}

/** module_scope_json：null=全部模块；否则为可写模块 id 列表 */
export function parseModuleScope(json: string | null | undefined): string[] | null {
  if (json === null || json === undefined || json === '') return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

export function getProjectMemberScope(projectId: string, userId: string): string[] | null {
  const row = db
    .prepare(
      'SELECT module_scope_json FROM project_members WHERE project_id = ? AND user_id = ?'
    )
    .get(projectId, userId) as { module_scope_json: string | null } | undefined;
  return parseModuleScope(row?.module_scope_json);
}

/** owner 配置成员可操作的模块范围：moduleIds=null 表示项目内全部模块 */
export function setProjectMemberScope(
  projectId: string,
  userId: string,
  moduleIds: string[] | null
) {
  if (!getProjectRole(projectId, userId)) throw new Error('该用户不是项目成员');
  const json = moduleIds === null ? null : JSON.stringify(moduleIds.map(String));
  db.prepare(
    'UPDATE project_members SET module_scope_json = ? WHERE project_id = ? AND user_id = ?'
  ).run(json, projectId, userId);
}

export function addProjectMember(
  projectId: string,
  userId: string,
  role: ProjectMemberRole = 'developer',
  moduleScope: string[] | null = null
) {
  if (!getProject(projectId)) throw new Error('项目不存在');
  if (!getUserById(userId)) throw new Error('用户不存在');
  const existing = getProjectRole(projectId, userId);
  if (existing) {
    db.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?').run(
      role,
      projectId,
      userId
    );
  } else {
    db.prepare(
      'INSERT INTO project_members (project_id, user_id, role, joined_at, module_scope_json) VALUES (?, ?, ?, ?, ?)'
    ).run(projectId, userId, role, new Date().toISOString(), JSON.stringify(moduleScope));
  }
}

export function removeProjectMember(projectId: string, userId: string) {
  const project = getProject(projectId);
  if (!project) throw new Error('项目不存在');
  if (project.ownerId === userId) throw new Error('不能移除项目创建人');
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(
    projectId,
    userId
  );
}

export function findUserByEmailOrId(query: string) {
  const q = query.trim();
  if (!q) return null;
  const byId = getUserById(q);
  if (byId) return byId;
  const row = db
    .prepare('SELECT id FROM users WHERE email = ? OR name = ? LIMIT 1')
    .get(q, q) as { id: string } | undefined;
  return row ? getUserById(row.id) : null;
}

export function addModuleMember(
  moduleId: string,
  userId: string,
  role: string = 'developer'
) {
  if (!getModule(moduleId)) throw new Error('模块不存在');
  if (!getUserById(userId)) throw new Error('用户不存在');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO module_members (module_id, user_id, role, joined_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(module_id, user_id) DO UPDATE SET role = excluded.role`
  ).run(moduleId, userId, role, now);
}

export function removeModuleMember(moduleId: string, userId: string) {
  const mod = getModule(moduleId);
  if (!mod) throw new Error('模块不存在');
  if (mod.createdBy === userId) throw new Error('不能移除模块创建人');
  db.prepare('DELETE FROM module_members WHERE module_id = ? AND user_id = ?').run(
    moduleId,
    userId
  );
}

export function listModuleMembers(moduleId: string) {
  return db
    .prepare(
      `SELECT mm.user_id as userId, mm.role, mm.joined_at as joinedAt, u.name, u.email
       FROM module_members mm
       JOIN users u ON u.id = mm.user_id
       WHERE mm.module_id = ?
       ORDER BY mm.joined_at ASC`
    )
    .all(moduleId) as Array<{
    userId: string;
    role: string;
    joinedAt: string;
    name: string;
    email: string;
  }>;
}

export function isModuleMember(moduleId: string, userId: string): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 FROM module_members WHERE module_id = ? AND user_id = ?')
      .get(moduleId, userId)
  );
}

/**
 * 可写模块：项目 owner（不限范围）/ developer（受成员模块范围限制）/ 模块直接成员。
 * 成员模块范围（project_members.module_scope_json）：null=项目内全部模块，
 * 数组=仅列表内的模块可操作（owner 用它给成员分工）。
 * 一旦 owner 显式配置了范围，就以范围为准（模块直接成员授权只对「非项目成员」生效）。
 */
export function canWriteModule(moduleId: string, userId: string): boolean {
  const mod = getModule(moduleId);
  if (!mod) return false;
  const role = getProjectRole(mod.projectId, userId);
  if (role === 'owner') return true;
  if (role === 'developer') {
    const scope = getProjectMemberScope(mod.projectId, userId);
    if (scope === null) return true;
    return scope.includes(moduleId);
  }
  if (role === 'viewer') return false;
  return isModuleMember(moduleId, userId);
}

export function canReadModule(moduleId: string, userId: string): boolean {
  const mod = getModule(moduleId);
  if (!mod) return false;
  if (canReadProject(mod.projectId, userId)) return true;
  return isModuleMember(moduleId, userId);
}

/** 仅项目创建人（owner）可删项目 */
export function canDeleteProject(projectId: string, userId: string): boolean {
  const project = getProject(projectId);
  return Boolean(project && project.ownerId === userId);
}

/** 仅模块创建人可删模块 */
export function canDeleteModule(moduleId: string, userId: string): boolean {
  const mod = getModule(moduleId);
  return Boolean(mod && mod.createdBy === userId);
}

/** 仅该版本上传者可删包版本 */
export function canDeletePackage(pkg: PackageVersion, userId: string): boolean {
  return pkg.uploadedBy === userId;
}

export function listProjectsForUser(userId: string): Project[] {
  const rows = db
    .prepare(
      `SELECT p.* FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE pm.user_id = ?
       ORDER BY p.created_at DESC`
    )
    .all(userId) as Parameters<typeof projectRow>[0][];
  return rows.map(projectRow);
}

export interface ProjectListEntry {
  id: string;
  name: string;
  description: string;
  visibility: string;
  ownerId: string;
  ownerName: string;
  moduleCount: number;
  memberCount: number;
  /** 当前用户是否项目创建人 */
  isOwner: boolean;
  /** 当前用户是否项目成员（含创建人） */
  isMember: boolean;
  myRole: ProjectMemberRole | null;
  createdAt: string;
}

function projectListEntryRow(): string {
  return `
    p.id, p.name, p.description, p.visibility, p.owner_id as ownerId, p.created_at as createdAt,
    ou.name as ownerName,
    (SELECT COUNT(*) FROM modules m WHERE m.project_id = p.id) as moduleCount,
    (SELECT COUNT(*) FROM project_members x WHERE x.project_id = p.id) as memberCount,
    CASE WHEN pm.user_id IS NULL THEN 0 ELSE 1 END as isMember,
    pm.role as myRole
  `;
}

type ProjectListEntryRow = {
  id: string;
  name: string;
  description: string;
  visibility: string;
  ownerId: string;
  ownerName: string;
  moduleCount: number;
  memberCount: number;
  isMember: number;
  myRole: string | null;
  createdAt: string;
};

function toProjectListEntry(r: ProjectListEntryRow, userId: string): ProjectListEntry {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    visibility: r.visibility,
    ownerId: r.ownerId,
    ownerName: r.ownerName || '',
    moduleCount: r.moduleCount,
    memberCount: r.memberCount,
    isOwner: r.ownerId === userId,
    isMember: Boolean(r.isMember) || r.ownerId === userId,
    myRole:
      r.ownerId === userId
        ? 'owner'
        : ((r.myRole as ProjectMemberRole | null) ?? null),
    createdAt: r.createdAt,
  };
}

/** 当前登录人「创建的项目」 */
export function listProjectsOwnedBy(userId: string): ProjectListEntry[] {
  const rows = db
    .prepare(
      `SELECT ${projectListEntryRow()}
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       JOIN users ou ON ou.id = p.owner_id
       WHERE p.owner_id = ?
       ORDER BY p.created_at DESC`
    )
    .all(userId, userId) as ProjectListEntryRow[];
  return rows.map((r) => toProjectListEntry(r, userId));
}

/**
 * 「全部项目」：我创建的 + 我参与的 + 公开项目，支持按名称/描述搜索。
 */
export function listAllVisibleProjects(userId: string, query = ''): ProjectListEntry[] {
  const like = `%${query.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const rows = db
    .prepare(
      `SELECT ${projectListEntryRow()}
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       JOIN users ou ON ou.id = p.owner_id
       WHERE (p.visibility = 'public' OR pm.user_id IS NOT NULL OR p.owner_id = ?)
         AND (? = '' OR p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')
       ORDER BY (p.owner_id = ?) DESC, pm.user_id IS NOT NULL DESC, p.created_at DESC
       LIMIT 200`
    )
    .all(userId, userId, query.trim(), like, like, userId) as ProjectListEntryRow[];
  return rows.map((r) => toProjectListEntry(r, userId));
}

/** 搜索公开项目（非成员可见、只读预览；已是成员则 isMember=true） */
export function searchPublicProjects(
  userId: string,
  query: string
): Array<{
  id: string;
  name: string;
  description: string;
  visibility: string;
  isMember: boolean;
  moduleCount: number;
}> {
  const q = query.trim();
  if (!q) return [];
  const like = `%${q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.description, p.visibility,
              CASE WHEN pm.user_id IS NULL THEN 0 ELSE 1 END as is_member,
              (SELECT COUNT(*) FROM modules m WHERE m.project_id = p.id) as module_count
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       WHERE p.visibility = 'public'
         AND (p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')
       ORDER BY p.created_at DESC
       LIMIT 30`
    )
    .all(userId, like, like) as Array<{
    id: string;
    name: string;
    description: string;
    visibility: string;
    is_member: number;
    module_count: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    visibility: r.visibility,
    isMember: Boolean(r.is_member),
    moduleCount: r.module_count,
  }));
}

/** 非成员只读预览公开项目（模块摘要，无敏感配置） */
export function getProjectPreview(projectId: string, userId: string) {
  const project = getProject(projectId);
  if (!project) return { kind: 'not_found' as const };
  const isMember = canReadProject(projectId, userId);
  if (isMember) return { kind: 'member' as const, projectId };
  if (project.visibility !== 'public') return { kind: 'forbidden' as const };
  const modules = listModules(projectId).map((m) => ({
    id: m.id,
    name: m.name,
    testDeployed: Boolean(m.test.url),
    prodDeployed: Boolean(m.prod.url),
  }));
  return {
    kind: 'preview' as const,
    project,
    modules,
    moduleCount: modules.length,
    readOnly: true,
    canJoin: true,
  };
}

/** 可供申请加入的项目目录（公开项目 + 当前用户已在的） */
export function listProjectDirectory(userId: string): Array<{
  id: string;
  name: string;
  description: string;
  visibility: string;
  isMember: boolean;
}> {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.description, p.visibility,
              CASE WHEN pm.user_id IS NULL THEN 0 ELSE 1 END as is_member
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       WHERE p.visibility = 'public' OR pm.user_id IS NOT NULL
       ORDER BY p.created_at DESC`
    )
    .all(userId) as Array<{
    id: string;
    name: string;
    description: string;
    visibility: string;
    is_member: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    visibility: r.visibility,
    isMember: Boolean(r.is_member),
  }));
}

export function getProject(id: string): Project | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    | Parameters<typeof projectRow>[0]
    | undefined;
  return row ? projectRow(row) : null;
}

export function createProject(
  userId: string,
  data: { name: string; description?: string; visibility?: string }
) {
  const id = `proj-${nanoid(10)}`;
  const now = new Date().toISOString();
  const quota = { ...DEFAULT_QUOTA };
  db.prepare(
    `INSERT INTO projects (id, name, description, owner_id, visibility, quota_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.name.trim(),
    data.description?.trim() ?? '',
    userId,
    data.visibility ?? 'private',
    JSON.stringify(quota),
    now
  );
  db.prepare(
    'INSERT INTO project_members (project_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
  ).run(id, userId, 'owner', now);
  return getProject(id)!;
}

/** 修改项目名称 / 描述（负责人或平台管理员） */
export function updateProject(
  projectId: string,
  data: { name?: string; description?: string; visibility?: string }
): Project {
  const existing = getProject(projectId);
  if (!existing) throw new Error('项目不存在');
  const name = data.name !== undefined ? data.name.trim() : existing.name;
  if (!name) throw new Error('项目名称不能为空');
  if (name.length > 64) throw new Error('项目名称过长（最多 64 字）');
  const description =
    data.description !== undefined ? data.description.trim() : existing.description;
  let visibility = existing.visibility;
  if (data.visibility !== undefined) {
    if (data.visibility !== 'public' && data.visibility !== 'private') {
      throw new Error('visibility 仅支持 public / private');
    }
    visibility = data.visibility;
  }
  db.prepare('UPDATE projects SET name = ?, description = ?, visibility = ? WHERE id = ?').run(
    name,
    description,
    visibility,
    projectId
  );
  return getProject(projectId)!;
}

const MODULE_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

export function validateModuleName(name: string): string {
  const n = name.trim();
  if (!MODULE_NAME_RE.test(n)) {
    throw new Error('模块名须为小写字母开头，仅含小写字母、数字和连字符，2-32 位');
  }
  if (RESERVED_MODULE_NAMES.has(n)) {
    throw new Error(`模块名「${n}」为平台保留字，请换一个`);
  }
  if (n.endsWith('-api')) {
    throw new Error('模块名不能以 -api 结尾（平台会自动追加 -api 作为后端路径）');
  }
  return n;
}

export function listModules(projectId: string): Module[] {
  const rows = db
    .prepare('SELECT * FROM modules WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as ModuleRow[];
  return rows.map(mapModuleRow);
}

export function getModule(id: string): Module | null {
  const r = db.prepare('SELECT * FROM modules WHERE id = ?').get(id) as ModuleRow | undefined;
  return r ? mapModuleRow(r) : null;
}

export function createModule(
  projectId: string,
  userId: string,
  data: { name: string; description?: string; pathMode?: string }
) {
  const project = getProject(projectId);
  if (!project) throw new Error('项目不存在');

  const name = validateModuleName(data.name);
  const existing = db.prepare('SELECT 1 FROM modules WHERE name = ?').get(name);
  if (existing) throw new Error('模块名已存在');

  // 挂载/访问模式：root=根路径、subpath=/sdpy 前缀、domain=仅子域名；其余（含 undefined）跟随平台默认
  const pathMode = normalizePathMode(data.pathMode);

  const id = `mod-${nanoid(10)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO modules (id, project_id, name, repo_url, build_command, app_type, default_branch, created_by, created_at, path_mode)
     VALUES (?, ?, ?, '', '', 'fullstack', 'main', ?, ?, ?)`
  ).run(id, projectId, name, userId, now, pathMode);
  // 创建人自动成为模块成员
  addModuleMember(id, userId, 'owner');
  return getModule(id)!;
}

export function setModulePackage(
  moduleId: string,
  data: { packagePath: string; packageVersion: string; packageFileName: string }
) {
  db.prepare(
    `UPDATE modules SET package_path = ?, package_version = ?, package_file_name = ? WHERE id = ?`
  ).run(data.packagePath, data.packageVersion, data.packageFileName, moduleId);
  return getModule(moduleId)!;
}

const MODULE_PRIORITIES = new Set(['critical', 'normal', 'best_effort']);

/** 设置模块优先级（部署时注入为 PRIORITY 环境变量，供 sseinfra 排杀序） */
export function setModulePriority(
  moduleId: string,
  priority: 'critical' | 'normal' | 'best_effort'
): Module {
  const mod = getModule(moduleId);
  if (!mod) throw new Error('模块不存在');
  if (!MODULE_PRIORITIES.has(priority)) {
    throw new Error(`非法优先级: ${priority}（须 critical / normal / best_effort）`);
  }
  db.prepare('UPDATE modules SET priority = ? WHERE id = ?').run(priority, moduleId);
  return getModule(moduleId)!;
}

/** 读取模块 Git 仓库原始配置（含明文令牌，仅供部署/写入内部使用，禁止回传前端） */
export function getModuleGitSource(moduleId: string): {
  repoUrl: string;
  provider: string;
  username: string;
  token: string;
  defaultBranch: string;
} | null {
  const r = db
    .prepare(
      `SELECT repo_url, default_branch, git_provider, git_username, git_token
       FROM modules WHERE id = ?`
    )
    .get(moduleId) as
    | {
        repo_url: string | null;
        default_branch: string | null;
        git_provider: string | null;
        git_username: string | null;
        git_token: string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    repoUrl: r.repo_url ?? '',
    provider: r.git_provider ?? '',
    username: r.git_username ?? '',
    token: r.git_token ?? '',
    defaultBranch: r.default_branch ?? '',
  };
}

const GIT_PROVIDERS = new Set(['', 'gitee', 'github', 'generic']);

export function setModuleGitConfig(
  moduleId: string,
  userId: string,
  data: {
    repoUrl?: string;
    provider?: string;
    branch?: string;
    username?: string;
    token?: string;
    clearToken?: boolean;
  }
): Module {
  const mod = getModule(moduleId);
  if (!mod) throw new Error('模块不存在');

  const repoUrl = (data.repoUrl ?? '').trim();
  if (repoUrl && !/^https?:\/\//i.test(repoUrl)) {
    throw new Error('仓库地址须以 http(s):// 开头');
  }

  const provider = (data.provider ?? '').trim().toLowerCase();
  if (!GIT_PROVIDERS.has(provider)) {
    throw new Error('仓库平台仅支持 gitee / github / generic');
  }

  const branch = (data.branch ?? '').trim();
  const username = (data.username ?? '').trim();

  // 令牌处理：clearToken 清除；提供新令牌则覆盖；否则保留旧令牌
  let token = getModuleGitSource(moduleId)?.token ?? '';
  if (data.clearToken) token = '';
  else if (typeof data.token === 'string' && data.token.trim()) token = data.token.trim();

  db.prepare(
    `UPDATE modules SET repo_url = ?, default_branch = ?, git_provider = ?, git_username = ?, git_token = ? WHERE id = ?`
  ).run(repoUrl, branch || 'main', provider, username, token, moduleId);

  void userId;
  return getModule(moduleId)!;
}

export function insertPackageVersion(
  moduleId: string,
  userId: string,
  data: {
    version: string;
    fileName: string;
    packagePath: string;
    label: string;
  }
): PackageVersion {
  const id = `pkg-${nanoid(12)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO packages
     (id, module_id, version, file_name, package_path, label, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    moduleId,
    data.version,
    data.fileName,
    data.packagePath,
    data.label,
    userId,
    now
  );
  return getPackageByVersion(moduleId, data.version)!;
}

export function listPackages(moduleId: string): PackageVersion[] {
  const rows = db
    .prepare(
      'SELECT * FROM packages WHERE module_id = ? ORDER BY created_at DESC'
    )
    .all(moduleId) as PackageRow[];
  return rows.map(mapPackageRow);
}

export function getPackageByVersion(moduleId: string, version: string): PackageVersion | null {
  const r = db
    .prepare('SELECT * FROM packages WHERE module_id = ? AND version = ?')
    .get(moduleId, version) as PackageRow | undefined;
  return r ? mapPackageRow(r) : null;
}

export function getPackageById(id: string): PackageVersion | null {
  const r = db.prepare('SELECT * FROM packages WHERE id = ?').get(id) as PackageRow | undefined;
  return r ? mapPackageRow(r) : null;
}

export function resolvePackageForDeploy(
  moduleId: string,
  packageVersion?: string
): PackageVersion | { version: string; packagePath: string; fileName: string; label: string } {
  if (packageVersion) {
    const pkg = getPackageByVersion(moduleId, packageVersion);
    if (!pkg) throw new Error(`包版本不存在: ${packageVersion}`);
    if (!existsSync(pkg.packagePath)) throw new Error('该版本压缩包文件已丢失，请重新上传');
    return pkg;
  }
  const mod = getModule(moduleId);
  if (!mod?.packagePath) {
    throw new Error('请先上传包含 frontend/、backend/ 与 compose.yml 的压缩包');
  }
  if (!existsSync(mod.packagePath)) {
    throw new Error('模块压缩包不存在，请重新上传');
  }
  const fromTable = mod.packageVersion
    ? getPackageByVersion(moduleId, mod.packageVersion)
    : null;
  if (fromTable) return fromTable;
  return {
    version: mod.packageVersion ?? 'unknown',
    packagePath: mod.packagePath,
    fileName: mod.packageFileName ?? 'source.zip',
    label: mod.packageFileName ?? mod.packageVersion ?? 'current',
  };
}

export function deletePackageVersion(moduleId: string, version: string, userId: string) {
  const pkg = getPackageByVersion(moduleId, version);
  if (!pkg) throw new Error('包版本不存在');
  if (!canDeletePackage(pkg, userId)) {
    throw new Error('仅该版本的上传者可以删除');
  }

  removePackageVersionDir(moduleId, version);
  db.prepare('DELETE FROM packages WHERE module_id = ? AND version = ?').run(moduleId, version);

  const mod = getModule(moduleId);
  if (mod?.packageVersion === version) {
    const latest = listPackages(moduleId)[0];
    if (latest) {
      setModulePackage(moduleId, {
        packagePath: latest.packagePath,
        packageVersion: latest.version,
        packageFileName: latest.fileName,
      });
    } else {
      db.prepare(
        `UPDATE modules SET package_path = NULL, package_version = NULL, package_file_name = NULL WHERE id = ?`
      ).run(moduleId);
    }
  }
}

export function buildModuleUrl(moduleName: string, env: DeployEnv = 'test'): string {
  return buildPublicUrl(moduleName, env, 'web', getModulePathModeByName(moduleName));
}

export function getModuleUrls(moduleName: string) {
  return buildModulePublicUrls(moduleName, getModulePathModeByName(moduleName));
}

/** 访问模式白名单：root / subpath / domain / ''（跟随平台默认） */
export function normalizePathMode(raw?: string): string {
  return raw === 'root' || raw === 'subpath' || raw === 'domain' ? raw : '';
}

/** 修改模块访问模式（root / subpath / domain / ''） */
export function setModulePathMode(moduleId: string, pathMode: string) {
  const mod = getModule(moduleId);
  if (!mod) throw new Error('模块不存在');
  const v = normalizePathMode(pathMode);
  db.prepare('UPDATE modules SET path_mode = ? WHERE id = ?').run(v, moduleId);
  return getModule(moduleId)!;
}

/** 按模块名读取其挂载路径模式（'' = 跟随平台默认） */
export function getModulePathModeByName(moduleName: string): string {
  const r = db
    .prepare('SELECT path_mode FROM modules WHERE name = ?')
    .get(moduleName) as { path_mode: string | null } | undefined;
  return r?.path_mode ?? '';
}

export function listDeployments(moduleId: string, limit = 30): Deployment[] {
  const rows = db
    .prepare(
      'SELECT * FROM deployments WHERE module_id = ? ORDER BY created_at DESC LIMIT ?'
    )
    .all(moduleId, limit) as DeploymentRow[];
  return rows.map(mapDeploymentRow);
}

export function getDeployment(id: string): Deployment | null {
  const r = db.prepare('SELECT * FROM deployments WHERE id = ?').get(id) as DeploymentRow | undefined;
  return r ? mapDeploymentRow(r) : null;
}

function parseEnv(env?: string): DeployEnv {
  if (env === 'prod') return 'prod';
  return 'test';
}

export function allocatePorts(): { webPort: number; apiPort: number } {
  const start = Number(process.env.DEPLOY_PORT_START) || 8100;
  // 占用 = 模块当前激活端口（已提交）+ 进行中部署端口（已分配未释放）
  const rows = db
    .prepare(
      `SELECT port FROM (
         SELECT active_test_web_port AS port FROM modules WHERE active_test_web_port IS NOT NULL
         UNION SELECT active_test_api_port FROM modules WHERE active_test_api_port IS NOT NULL
         UNION SELECT active_prod_web_port FROM modules WHERE active_prod_web_port IS NOT NULL
         UNION SELECT active_prod_api_port FROM modules WHERE active_prod_api_port IS NOT NULL
         UNION SELECT active_test_port FROM modules WHERE active_test_port IS NOT NULL
         UNION SELECT active_prod_port FROM modules WHERE active_prod_port IS NOT NULL
       )
       UNION SELECT port FROM deployments WHERE status NOT IN ('success','failed','cancelled') AND port > 0
       UNION SELECT api_port FROM deployments WHERE status NOT IN ('success','failed','cancelled') AND api_port > 0`
    )
    .all() as Array<{ port: number }>;

  const used = new Set<number>();
  for (const r of rows) used.add(r.port);

  // 从起始端口向上扫描第一个「web+api 均空闲」的连续对，复用历史释放的空洞
  let p = start;
  for (;;) {
    if (!used.has(p) && !used.has(p + 1)) return { webPort: p, apiPort: p + 1 };
    p += 1;
  }
}

export function createDeployment(
  moduleId: string,
  userId: string,
  data: {
    env?: string;
    noCache?: boolean;
    packageVersion?: string;
    action?: ReleaseAction;
    sourceDeploymentId?: string;
    source?: DeploymentSource;
    branch?: string;
    /** 回滚时指定目标提交（git 专用，package 忽略） */
    commitSha?: string;
    /** 本次部署是否请求 Agent 自愈（须管理员全局开启 + LLM 已配置才生效） */
    useAgentFixer?: boolean;
    /** 用户已确认：缺 deploy.sh 时由 Agent 生成（可取消部署中止） */
    confirmAgentGenerate?: boolean;
  }
) {
  const mod = getModule(moduleId);
  if (!mod) throw new Error('模块不存在');

  const source: DeploymentSource = data.source ?? 'package';
  const env = parseEnv(data.env);
  const id = `dep-${nanoid(12)}`;
  const now = new Date().toISOString();
  // sseinfra：不占本机端口；compose：分配本机端口
  const useInfraPorts = (process.env.DEPLOY_RUNTIME || 'sseinfra').toLowerCase() !== 'compose';
  const { webPort, apiPort } = useInfraPorts ? { webPort: 0, apiPort: 0 } : allocatePorts();
  const action = data.action ?? 'deploy';
  const noCache = Boolean(data.noCache);

  let branch: string;
  let commitSha: string;

  if (source === 'git') {
    const git = getModuleGitSource(moduleId);
    if (!git?.repoUrl) throw new Error('请先在模块中配置 Git 仓库地址');
    branch = data.branch?.trim() || git.defaultBranch || 'main';
    commitSha = data.commitSha?.trim() || ''; // 回滚指定提交；否则克隆后由执行器回填
  } else {
    const pkg = resolvePackageForDeploy(moduleId, data.packageVersion);
    setModulePackage(moduleId, {
      packagePath: pkg.packagePath,
      packageVersion: pkg.version,
      packageFileName: pkg.fileName,
    });
    branch = 'package';
    commitSha = pkg.version;
  }

  db.prepare(
    `INSERT INTO deployments
     (id, module_id, branch, commit_sha, env, action, status, port, api_port, image_tag, source, no_cache, source_deployment_id, use_agent_fixer, confirm_agent_generate, operator_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    moduleId,
    branch,
    commitSha,
    env,
    action,
    webPort,
    apiPort,
    source,
    noCache ? 1 : 0,
    data.sourceDeploymentId ?? null,
    data.useAgentFixer ? 1 : 0,
    data.confirmAgentGenerate ? 1 : 0,
    userId,
    now
  );

  return getDeployment(id)!;
}

/**
 * 本机 compose → K8s：同步 MODULE_DATA 后按 Git/包重新部署，成功后停旧 compose。
 * 须 DEPLOY_RUNTIME=sseinfra；优先 Git，否则用带 deploy.sh 的压缩包。
 */
export function createMigrateDeployment(
  moduleId: string,
  userId: string,
  data: {
    env: string;
    source?: DeploymentSource;
    packageVersion?: string;
    branch?: string;
    /** 非 legacy 槽位也强制迁移（仅同步数据+再部署） */
    force?: boolean;
    /** 用户已确认允许 Agent 生成 deploy.sh */
    confirmAgentGenerate?: boolean;
  }
) {
  const mod = getModule(moduleId);
  if (!mod) throw new Error('模块不存在');
  const env = parseEnv(data.env);

  if (!isSseinfraRuntime()) {
    throw new Error('迁移到 K8s 需要 DEPLOY_RUNTIME=sseinfra');
  }
  if (!data.force && !isLegacyComposeSlot(mod, env)) {
    throw new Error(
      `${env} 环境不像本机 compose 部署（无宿主端口）。若仍要同步数据并重部署，请传 force=true`
    );
  }

  const git = getModuleGitSource(moduleId);
  const source: DeploymentSource =
    data.source || (git?.repoUrl ? 'git' : 'package');

  if (source === 'git') {
    if (!git?.repoUrl) throw new Error('请先配置 Git 仓库（仓根须有 deploy.sh）');
    return createDeployment(moduleId, userId, {
      env,
      source: 'git',
      branch: data.branch?.trim() || git.defaultBranch || 'main',
      action: 'migrate',
      confirmAgentGenerate: Boolean(data.confirmAgentGenerate),
    });
  }

  const pkg = resolvePackageForDeploy(moduleId, data.packageVersion);
  // 缺脚本时由路由用 NEED_AGENT_DEPLOY_SH 提示确认；确认后带 flag 入队，worker 内生成
  if (!hasDeploySh(pkg.packagePath) && !data.confirmAgentGenerate) {
    const err = new Error(
      'NEED_AGENT_DEPLOY_SH:压缩包缺少 deploy.sh。确认后将由部署 Agent 自动生成（可随时在部署日志取消）'
    );
    (err as Error & { code?: string }).code = 'NEED_AGENT_DEPLOY_SH';
    throw err;
  }
  return createDeployment(moduleId, userId, {
    env,
    source: 'package',
    packageVersion: pkg.version,
    action: 'migrate',
    confirmAgentGenerate: Boolean(data.confirmAgentGenerate),
  });
}

/** 将测试环境当前成功部署一键晋升到正式环境（压缩包=同版本；Git=同分支重新拉取） */
export function createPromoteDeployment(moduleId: string, userId: string, noCache?: boolean) {
  const mod = getModule(moduleId);
  if (!mod) throw new Error('模块不存在');
  if (!mod.test.deploymentId) {
    throw new Error('测试环境尚未部署成功，无法晋升到正式');
  }
  const source = getDeployment(mod.test.deploymentId);
  if (!source || source.status !== 'success' || source.env !== 'test') {
    throw new Error('测试环境当前部署不可用，请先成功部署测试环境');
  }

  if (source.source === 'git') {
    if (!source.branch) throw new Error('测试环境部署缺少分支信息');
    return createDeployment(moduleId, userId, {
      env: 'prod',
      noCache: Boolean(noCache),
      source: 'git',
      branch: source.branch,
      action: 'promote',
      sourceDeploymentId: source.id,
    });
  }

  const packageVersion = source.commitSha || mod.packageVersion;
  if (!packageVersion) {
    throw new Error('找不到测试环境使用的包版本');
  }
  return createDeployment(moduleId, userId, {
    env: 'prod',
    noCache: Boolean(noCache),
    packageVersion,
    action: 'promote',
    sourceDeploymentId: source.id,
  });
}

/** 回滚：默认重发指定环境上一条（非当前激活的）成功部署；也可指定具体目标部署 */
export function createRollbackDeployment(
  moduleId: string,
  userId: string,
  env: string,
  opts?: { sourceDeploymentId?: string }
) {
  const mod = getModule(moduleId);
  if (!mod) throw new Error('模块不存在');
  const targetEnv = parseEnv(env);
  const active = targetEnv === 'test' ? mod.test.deploymentId : mod.prod.deploymentId;

  let row: { id: string } | undefined;
  if (opts?.sourceDeploymentId) {
    const target = getDeployment(opts.sourceDeploymentId);
    if (!target || target.moduleId !== moduleId || target.env !== targetEnv) {
      throw new Error('指定的回滚目标不属于该环境');
    }
    if (target.status !== 'success') {
      throw new Error('指定的回滚目标未成功部署');
    }
    row = { id: target.id };
  } else {
    row = db
      .prepare(
        `SELECT id FROM deployments
         WHERE module_id = ? AND env = ? AND status = 'success'
           AND (id != ? OR ? IS NULL)
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(moduleId, targetEnv, active ?? '', active ?? null) as { id: string } | undefined;
    if (!row) throw new Error('没有可回滚的历史成功版本');
  }

  const source = getDeployment(row.id);
  if (!source) throw new Error('回滚目标不存在');

  if (source.source === 'git') {
    if (!source.commitSha) throw new Error('回滚目标缺少提交信息');
    return createDeployment(moduleId, userId, {
      env: targetEnv,
      source: 'git',
      branch: source.branch,
      commitSha: source.commitSha,
      action: 'rollback',
      sourceDeploymentId: source.id,
    });
  }

  const packageVersion = source.commitSha;
  if (!packageVersion) throw new Error('回滚目标缺少包版本');
  return createDeployment(moduleId, userId, {
    env: targetEnv,
    packageVersion,
    action: 'rollback',
    sourceDeploymentId: source.id,
  });
}

/** 读取模块 webhook 密钥（明文，仅供配置页/校验内部使用） */
export function getModuleWebhookSecret(moduleId: string): string {
  const r = db
    .prepare('SELECT git_webhook_secret FROM modules WHERE id = ?')
    .get(moduleId) as { git_webhook_secret: string | null } | undefined;
  return r?.git_webhook_secret ?? '';
}

/** 轮换并返回新的 webhook 密钥 */
export function rotateModuleWebhookSecret(moduleId: string): string {
  const secret = `wh_${nanoid(24)}`;
  db.prepare('UPDATE modules SET git_webhook_secret = ? WHERE id = ?').run(secret, moduleId);
  return secret;
}

export function appendDeploymentLog(id: string, line: string) {
  const dep = getDeployment(id);
  if (!dep) return;
  const logs = dep.logs ? `${dep.logs}\n${line}` : line;
  db.prepare('UPDATE deployments SET logs = ? WHERE id = ?').run(logs, id);
}

export function updateDeploymentStatus(
  id: string,
  status: Deployment['status'],
  extra?: {
    url?: string;
    apiUrl?: string;
    commitSha?: string;
    port?: number;
    apiPort?: number;
    imageTag?: string;
  }
) {
  const finished = ['success', 'failed', 'cancelled'].includes(status);
  db.prepare(
    `UPDATE deployments SET status = ?,
     url = COALESCE(?, url),
     api_url = COALESCE(?, api_url),
     commit_sha = COALESCE(?, commit_sha),
     port = COALESCE(?, port),
     api_port = COALESCE(?, api_port),
     image_tag = COALESCE(?, image_tag),
     finished_at = CASE WHEN ? THEN datetime('now') ELSE finished_at END
     WHERE id = ?`
  ).run(
    status,
    extra?.url ?? null,
    extra?.apiUrl ?? null,
    extra?.commitSha ?? null,
    extra?.port ?? null,
    extra?.apiPort ?? null,
    extra?.imageTag ?? null,
    finished ? 1 : 0,
    id
  );
}

export function setModuleActiveSlot(
  moduleId: string,
  env: DeployEnv,
  data: {
    deploymentId: string;
    webPort: number;
    apiPort: number;
    url: string;
    apiUrl: string;
  }
) {
  if (env === 'test') {
    db.prepare(
      `UPDATE modules SET
         active_test_web_port = ?, active_test_api_port = ?,
         active_test_port = ?, active_test_url = ?, active_test_api_url = ?,
         active_test_deployment_id = ?
       WHERE id = ?`
    ).run(
      data.webPort,
      data.apiPort,
      data.webPort,
      data.url,
      data.apiUrl,
      data.deploymentId,
      moduleId
    );
  } else {
    db.prepare(
      `UPDATE modules SET
         active_prod_web_port = ?, active_prod_api_port = ?,
         active_prod_port = ?, active_prod_url = ?, active_prod_api_url = ?,
         active_prod_deployment_id = ?
       WHERE id = ?`
    ).run(
      data.webPort,
      data.apiPort,
      data.webPort,
      data.url,
      data.apiUrl,
      data.deploymentId,
      moduleId
    );
  }
}

async function teardownModuleRuntime(
  mod: Module,
  log?: (line: string) => void,
  actorId?: string
) {
  const workRoot = getWorkDir();
  for (const env of ['test', 'prod'] as DeployEnv[]) {
    const projectName = composeProjectName(mod.name, env);
    const slot = env === 'test' ? mod.test : mod.prod;
    const depId = slot.deploymentId;
    const cwd = depId && existsSync(join(workRoot, depId))
      ? join(workRoot, depId)
      : workRoot;
    await stopComposeProject(projectName, cwd, log);
  }

  await releaseSseinfraGroups(mod, log, actorId);

  const deps = listDeployments(mod.id, 200);
  for (const d of deps) {
    const dir = join(workRoot, d.id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  removeModuleUploads(mod.id);
}

/** 删除模块/项目时释放 sseinfra 测试+正式组（Pod/PVC/frp） */
async function releaseSseinfraGroups(
  mod: Module,
  log?: (line: string) => void,
  actorId?: string
) {
  const { getSseinfraRuntimeConfig } = await import('./sseinfra-settings.js');
  const mayHaveInfra =
    isSseinfraRuntime() ||
    listDeployments(mod.id, 50).some(
      (d) =>
        (d.imageTag || '').startsWith('infra:') ||
        (d.imageTag || '').startsWith('infra-pkg:')
    );
  if (!mayHaveInfra) return;
  if (!getSseinfraRuntimeConfig().password) {
    throw new Error(
      '模块曾部署到 K8s，删除前请在管理台配置 sseinfra 面板密码，或先在面板手动删组'
    );
  }

  const client = new SseinfraClient();
  await client.login();
  const errors: string[] = [];
  for (const env of ['test', 'prod'] as DeployEnv[]) {
    const group = sseinfraGroupName(mod.name, env);
    try {
      const r = await client.deleteGroup(group);
      log?.(
        r.deleted
          ? `[sseinfra] 已释放组 ${group}（MinIO 桶保留，不随组删除）`
          : `[sseinfra] 组 ${group} 不存在，跳过`
      );
      if (r.deleted) {
        try {
          const { writeAudit } = await import('./audit.js');
          writeAudit({
            action: 'sseinfra.group.delete',
            actorId: actorId ?? null,
            targetType: 'sseinfra_group',
            targetId: group,
            summary: `释放 K8s 组 ${group}（模块 ${mod.name}）`,
            meta: { moduleId: mod.id, moduleName: mod.name, env },
          });
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      errors.push(`${group}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (errors.length) {
    throw new Error(`释放 K8s 组失败：${errors.join('; ')}`);
  }
}

export async function deleteModule(moduleId: string, userId: string) {
  const mod = getModule(moduleId);
  if (!mod) throw new Error('模块不存在');
  if (!canDeleteModule(moduleId, userId)) {
    throw new Error('仅模块创建人可以删除');
  }
  try {
    const { markModuleBucketsOrphaned } = await import('./module-object-storage.js');
    markModuleBucketsOrphaned(moduleId);
  } catch {
    /* ignore */
  }
  await teardownModuleRuntime(mod, undefined, userId);
  db.prepare('DELETE FROM modules WHERE id = ?').run(moduleId);
  regenerateNginxRoutes();
}

export async function deleteProject(projectId: string, userId: string) {
  const project = getProject(projectId);
  if (!project) throw new Error('项目不存在');
  if (!canDeleteProject(projectId, userId)) {
    throw new Error('仅项目创建人可以删除');
  }
  const modules = listModules(projectId);
  for (const mod of modules) {
    await teardownModuleRuntime(mod, undefined, userId);
  }
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  regenerateNginxRoutes();
}

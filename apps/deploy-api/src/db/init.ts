import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DEPLOY_DATA_DIR ?? join(__dirname, '../../data');
mkdirSync(dataDir, { recursive: true });

const dbPath = join(dataDir, 'deploy.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// 库已到 20GB 量级，默认 2MB 页缓存太小：监控聚合/明细查询会反复读盘。
// 128MB 对宿主机（16GB 内存）无压力，能显著降低重复查询的 I/O。
db.pragma('cache_size = -131072');
// 采集器每 30s 落一次分钟聚合，与分析/备份等维护操作会抢写锁。
// 不设 busy_timeout 时 better-sqlite3 立刻抛 SQLITE_BUSY，进程直接崩（2026-10-24 已发生两次）。
db.pragma('busy_timeout = 10000');

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      oauth_id TEXT UNIQUE,
      email TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS platform_admins (
      oauth_id TEXT PRIMARY KEY,
      added_by TEXT REFERENCES users(id),
      added_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL REFERENCES users(id),
      visibility TEXT NOT NULL DEFAULT 'private',
      quota_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (project_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS modules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL UNIQUE,
      repo_url TEXT NOT NULL DEFAULT '',
      build_command TEXT NOT NULL DEFAULT '',
      app_type TEXT NOT NULL DEFAULT 'fullstack',
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      active_port INTEGER,
      active_url TEXT
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      branch TEXT NOT NULL DEFAULT 'package',
      commit_sha TEXT NOT NULL DEFAULT '',
      env TEXT NOT NULL DEFAULT 'test',
      status TEXT NOT NULL DEFAULT 'pending',
      url TEXT NOT NULL DEFAULT '',
      port INTEGER NOT NULL DEFAULT 0,
      logs TEXT NOT NULL DEFAULT '',
      operator_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_deployments_module ON deployments(module_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

    CREATE TABLE IF NOT EXISTS packages (
      id TEXT PRIMARY KEY,
      module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      file_name TEXT NOT NULL,
      package_path TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      UNIQUE(module_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_packages_module ON packages(module_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      applicant_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      module_id TEXT REFERENCES modules(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL DEFAULT '{}',
      review_note TEXT NOT NULL DEFAULT '',
      reviewer_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_applications_project ON applications(project_id, status);

    CREATE TABLE IF NOT EXISTS module_members (
      module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL DEFAULT 'developer',
      joined_at TEXT NOT NULL,
      PRIMARY KEY (module_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS deploy_locks (
      key TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      locked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS module_env_configs (
      module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      env TEXT NOT NULL CHECK (env IN ('test', 'prod')),
      vars_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      PRIMARY KEY (module_id, env)
    );

    CREATE TABLE IF NOT EXISTS module_object_storage (
      module_id TEXT NOT NULL,
      env TEXT NOT NULL CHECK (env IN ('test', 'prod')),
      bucket TEXT NOT NULL,
      key_label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'none',
      last_sync_at TEXT,
      last_sync_bytes INTEGER NOT NULL DEFAULT 0,
      last_sync_files INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (module_id, env)
    );

    CREATE TABLE IF NOT EXISTS module_domains (
      id TEXT PRIMARY KEY,
      module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      env TEXT NOT NULL CHECK (env IN ('test', 'prod')),
      kind TEXT NOT NULL CHECK (kind IN ('subdomain', 'custom')),
      host TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      route_target TEXT NOT NULL DEFAULT 'web',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_primary INTEGER NOT NULL DEFAULT 0,
      gray_match_type TEXT NOT NULL DEFAULT 'none',
      gray_match_key TEXT NOT NULL DEFAULT '',
      gray_match_value TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_module_domains_host ON module_domains(host);
    CREATE INDEX IF NOT EXISTS idx_module_domains_module ON module_domains(module_id, env);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      actor_id TEXT,
      target_type TEXT NOT NULL DEFAULT '',
      target_id TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id, created_at DESC);
  `);

  ensureModuleEnvColumns();
  ensureModulePackageColumns();
  ensureDeploymentReleaseColumns();
  ensureGitColumns();
  ensureWebhookColumn();
  ensureDeployFixColumns();
  ensureModulePathModeColumn();
  ensureModulePriorityColumn();
  ensureModuleDomainsRouteTargetColumn();
  ensureProjectMemberScopeColumn();
  ensureSessionsTable();
  ensureScriptTables();
  backfillPackagesFromModules();

  const baseDomain = process.env.BASE_DOMAIN ?? 'ssemarket.cn';
  const existing = db
    .prepare('SELECT 1 FROM platform_settings WHERE key = ?')
    .get('base_domain');
  if (!existing) {
    db.prepare(
      'INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)'
    ).run('base_domain', baseDomain, new Date().toISOString());
  }

  // 默认挂载路径（路径模式）：首次从环境变量 PUBLIC_BASE_PATH 引导，之后可在管理台修改
  const hasBasePath = db
    .prepare('SELECT 1 FROM platform_settings WHERE key = ?')
    .get('public_base_path');
  if (!hasBasePath) {
    const envBase = (process.env.PUBLIC_BASE_PATH ?? '').trim();
    const basePathSeed = !envBase || envBase === '/'
      ? ''
      : envBase.startsWith('/')
        ? envBase.replace(/\/+$/, '')
        : `/${envBase.replace(/\/+$/, '')}`;
    db.prepare(
      'INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)'
    ).run('public_base_path', basePathSeed, new Date().toISOString());
  }
}

export function getBaseDomain(): string {
  const row = db
    .prepare('SELECT value FROM platform_settings WHERE key = ?')
    .get('base_domain') as { value: string } | undefined;
  return row?.value ?? process.env.BASE_DOMAIN ?? 'ssemarket.cn';
}

export function getPlatformSetting(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM platform_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setPlatformSetting(key: string, value: string, updatedBy?: string) {
  db.prepare(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(key, value, new Date().toISOString(), updatedBy ?? null);
}

function columnExists(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function ensureModuleEnvColumns() {
  const adds: [string, string][] = [
    ['active_test_port', 'INTEGER'],
    ['active_test_url', 'TEXT'],
    ['active_test_deployment_id', 'TEXT'],
    ['active_prod_port', 'INTEGER'],
    ['active_prod_url', 'TEXT'],
    ['active_prod_deployment_id', 'TEXT'],
    ['active_test_web_port', 'INTEGER'],
    ['active_test_api_port', 'INTEGER'],
    ['active_test_api_url', 'TEXT'],
    ['active_prod_web_port', 'INTEGER'],
    ['active_prod_api_port', 'INTEGER'],
    ['active_prod_api_url', 'TEXT'],
  ];
  for (const [col, type] of adds) {
    if (!columnExists('modules', col)) {
      db.exec(`ALTER TABLE modules ADD COLUMN ${col} ${type}`);
    }
  }
  if (columnExists('modules', 'active_port')) {
    db.exec(`
      UPDATE modules SET
        active_test_port = COALESCE(active_test_port, active_port),
        active_test_url = COALESCE(active_test_url, active_url),
        active_test_web_port = COALESCE(active_test_web_port, active_test_port, active_port)
      WHERE active_port IS NOT NULL AND active_test_web_port IS NULL
    `);
  }
}

/** 模块挂载路径模式：'root' 根路径 / 'subpath' /sdpy 前缀 / '' 跟随平台默认 */
function ensureModulePathModeColumn() {
  if (!columnExists('modules', 'path_mode')) {
    db.exec(`ALTER TABLE modules ADD COLUMN path_mode TEXT NOT NULL DEFAULT ''`);
  }
}

/**
 * 模块优先级：critical / normal / best_effort。
 * 部署时作为 PRIORITY 环境变量推进 sseinfra 组，底层据此排杀序（压力降级分层）。
 */
function ensureModulePriorityColumn() {
  if (!columnExists('modules', 'priority')) {
    db.exec(`ALTER TABLE modules ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`);
  }
}

/** 域名用途：web=前端 / api=后端（旧库补列） */
function ensureModuleDomainsRouteTargetColumn() {
  if (!columnExists('module_domains', 'route_target')) {
    db.exec(`ALTER TABLE module_domains ADD COLUMN route_target TEXT NOT NULL DEFAULT 'web'`);
    console.log('[db] module_domains.route_target 已补列');
  }
}

/**
 * 项目成员的模块授权范围：NULL=可操作项目内全部模块；
 * 填 JSON 数组（模块 id 列表）=仅这些模块可写。
 */
function ensureProjectMemberScopeColumn() {
  if (!columnExists('project_members', 'module_scope_json')) {
    db.exec(`ALTER TABLE project_members ADD COLUMN module_scope_json TEXT`);
    console.log('[db] project_members.module_scope_json 已补列');
  }
}

/** 服务端会话：登录签发随机 token，杜绝「token=用户 id」被冒用 */
function ensureSessionsTable() {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'")
    .get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_developer INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    `);
  // 旧表补 is_developer 列
  if (exists && !columnExists('sessions', 'is_developer')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN is_developer INTEGER NOT NULL DEFAULT 0`);
    console.log('[db] sessions.is_developer 已补列');
  }
}

/**
 * 「脚本应用」：非部署台应用 —— 不参与容器化部署流水线，只是一组可在 Web 下发的命令。
 *
 * 用途：把宿主机上已有的脚本（如 iWiki 的 iwiki.py 一键部署）搬到网页执行，
 * 用户在页面上填参数，后端拼成完整命令行后在配置的根目录执行。
 *
 * 层级：应用 → 命令组（任意多个，自由命名）→ 参数预设
 *
 *   五张表：
 *     script_apps     应用（名字 + 根目录 + 创建者）
 *     script_commands 命令组（name = 命令名，如「部署到测试」；main_command = 命令主体）
 *     script_params   命令组的参数预设（flag + 取值方式，支持可选、默认值、下拉）
 *     script_app_members 成员（加入后才能执行该应用的命令）
 *     script_runs     执行记录（完整命令行 + 输出 + 退出码）
 *
 * 注：早期版本用 kind（deploy/test）标识命令且每类只允许一条，现改为自由命名的命令组。
 *     老库的 kind / script_runs.kind 会被迁移成 name / command_name（见下方 rename 段）。
 */
function ensureScriptTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS script_apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      /** 执行时 cd 到的根目录（必须落在 SCRIPT_ALLOWED_ROOTS 之内） */
      workdir TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS script_commands (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES script_apps(id) ON DELETE CASCADE,
      /** 命令组名（自由命名，如「部署到测试」）；同一应用内不允许重名 */
      name TEXT NOT NULL,
      /** 命令组说明（可选） */
      description TEXT NOT NULL DEFAULT '',
      /** 命令主体，原样拼接执行（允许写 cd .. && python3 xxx.py） */
      main_command TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_script_commands_app ON script_commands(app_id, sort_order);

    CREATE TABLE IF NOT EXISTS script_params (
      id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL REFERENCES script_commands(id) ON DELETE CASCADE,
      /** 参数名，如 --branch / -b */
      flag TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      placeholder TEXT NOT NULL DEFAULT '',
      default_value TEXT NOT NULL DEFAULT '',
      required INTEGER NOT NULL DEFAULT 0,
      /** value=带值（--flag 值）；switch=开关（只拼 --flag） */
      value_mode TEXT NOT NULL DEFAULT 'value',
      /** text=自由填写；select=从 options 里选 */
      input_type TEXT NOT NULL DEFAULT 'text',
      options_json TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_script_params_command ON script_params(command_id, sort_order);

    CREATE TABLE IF NOT EXISTS script_app_members (
      app_id TEXT NOT NULL REFERENCES script_apps(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      /** owner=创建者（建应用时自动写入）；member=自助加入者 */
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL,
      PRIMARY KEY (app_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_script_members_user ON script_app_members(user_id);

    CREATE TABLE IF NOT EXISTS script_runs (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      /** 执行时的命令组名快照（命令组改名/删除后，历史仍能看懂跑的是什么） */
      command_name TEXT NOT NULL DEFAULT '',
      /** 最终拼接的命令行（展示 + 追溯） */
      command_line TEXT NOT NULL DEFAULT '',
      param_values_json TEXT NOT NULL DEFAULT '{}',
      workdir TEXT NOT NULL DEFAULT '',
      /** running | success | failed | canceled | timeout | interrupted */
      status TEXT NOT NULL DEFAULT 'running',
      exit_code INTEGER,
      output TEXT NOT NULL DEFAULT '',
      operator_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_script_runs_app ON script_runs(app_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_script_runs_status ON script_runs(status);
  `);

  migrateScriptCommandNaming();
  ensureScriptCommandColumns();
  backfillScriptAppOwners();
}

/**
 * 迁移：早期的 kind（deploy/test）→ 自由命名的 name。
 * 只跑一次（有 name 列就跳过），老值按语义映射成中文命令名。
 */
function migrateScriptCommandNaming() {
  if (columnExists('script_commands', 'kind') && !columnExists('script_commands', 'name')) {
    db.exec(`ALTER TABLE script_commands RENAME COLUMN kind TO name`);
    db.exec(`UPDATE script_commands SET name = '部署' WHERE name = 'deploy'`);
    db.exec(`UPDATE script_commands SET name = '测试' WHERE name = 'test'`);
    console.log('[db] script_commands.kind → name 迁移完成');
  }
  if (columnExists('script_runs', 'kind') && !columnExists('script_runs', 'command_name')) {
    db.exec(`ALTER TABLE script_runs RENAME COLUMN kind TO command_name`);
    db.exec(`UPDATE script_runs SET command_name = '部署' WHERE command_name = 'deploy'`);
    db.exec(`UPDATE script_runs SET command_name = '测试' WHERE command_name = 'test'`);
    console.log('[db] script_runs.kind → command_name 迁移完成');
  }
}

function ensureScriptCommandColumns() {
  const adds: [string, string][] = [['description', "TEXT NOT NULL DEFAULT ''"]];
  for (const [col, type] of adds) {
    if (!columnExists('script_commands', col)) {
      db.exec(`ALTER TABLE script_commands ADD COLUMN ${col} ${type}`);
    }
  }
}

/** 老应用没有成员记录：把创建者补成 owner，避免升级后创建者自己反而执行不了 */
function backfillScriptAppOwners() {
  db.exec(`
    INSERT OR IGNORE INTO script_app_members (app_id, user_id, role, joined_at)
    SELECT id, created_by, 'owner', created_at FROM script_apps
  `);
}

function ensureModulePackageColumns() {
  const adds: [string, string][] = [
    ['package_path', 'TEXT'],
    ['package_version', 'TEXT'],
    ['package_file_name', 'TEXT'],
  ];
  for (const [col, type] of adds) {
    if (!columnExists('modules', col)) {
      db.exec(`ALTER TABLE modules ADD COLUMN ${col} ${type}`);
    }
  }
}

function ensureDeploymentReleaseColumns() {
  const adds: [string, string][] = [
    ['action', "TEXT NOT NULL DEFAULT 'deploy'"],
    ['image_tag', "TEXT NOT NULL DEFAULT ''"],
    ['source_deployment_id', 'TEXT'],
    ['api_port', 'INTEGER NOT NULL DEFAULT 0'],
    ['api_url', "TEXT NOT NULL DEFAULT ''"],
    ['source', "TEXT NOT NULL DEFAULT 'package'"],
    ['no_cache', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [col, type] of adds) {
    if (!columnExists('deployments', col)) {
      db.exec(`ALTER TABLE deployments ADD COLUMN ${col} ${type}`);
    }
  }
  db.exec(`UPDATE deployments SET env = 'test' WHERE env = 'dev' OR env NOT IN ('test', 'prod')`);
}

/** Agent 自愈部署的构建重试记录 */
function ensureDeployFixColumns() {
  const adds: [string, string][] = [
    ['fix_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['fixed_by_agent', 'INTEGER NOT NULL DEFAULT 0'],
    ['use_agent_fixer', 'INTEGER NOT NULL DEFAULT 0'],
    /** 用户已确认：缺 deploy.sh 时允许 Agent 生成 */
    ['confirm_agent_generate', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [col, type] of adds) {
    if (!columnExists('deployments', col)) {
      db.exec(`ALTER TABLE deployments ADD COLUMN ${col} ${type}`);
    }
  }
}

/** Git 分支部署：模块仓库配置 + 部署来源/构建标记 */
function ensureGitColumns() {
  const adds: [string, string][] = [
    ['git_provider', "TEXT NOT NULL DEFAULT ''"],
    ['git_username', "TEXT NOT NULL DEFAULT ''"],
    ['git_token', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [col, type] of adds) {
    if (!columnExists('modules', col)) {
      db.exec(`ALTER TABLE modules ADD COLUMN ${col} ${type}`);
    }
  }
}

/** Git webhook 自动部署密钥（HMAC 校验用） */
function ensureWebhookColumn() {
  if (!columnExists('modules', 'git_webhook_secret')) {
    db.exec(`ALTER TABLE modules ADD COLUMN git_webhook_secret TEXT NOT NULL DEFAULT ''`);
  }
}

/** 将旧版「仅当前包」记录迁入 packages 表，便于版本列表展示 */
function backfillPackagesFromModules() {
  const rows = db
    .prepare(
      `SELECT id, package_path, package_version, package_file_name, created_by, created_at
       FROM modules
       WHERE package_path IS NOT NULL AND package_version IS NOT NULL
         AND package_version != ''`
    )
    .all() as Array<{
    id: string;
    package_path: string;
    package_version: string;
    package_file_name: string | null;
    created_by: string;
    created_at: string;
  }>;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO packages
     (id, module_id, version, file_name, package_path, label, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const r of rows) {
    const exists = db
      .prepare('SELECT 1 FROM packages WHERE module_id = ? AND version = ?')
      .get(r.id, r.package_version);
    if (exists) continue;
    insert.run(
      `pkg-${r.package_version}`,
      r.id,
      r.package_version,
      r.package_file_name ?? 'source.zip',
      r.package_path,
      r.package_file_name ?? r.package_version,
      r.created_by,
      r.created_at
    );
  }
}

/**
 * 脚本应用：非部署台应用 —— 用户在网页上注册「一组可在宿主根目录执行的命令」。
 *
 * 层级：应用 → 命令组（任意多个，自由命名）→ 参数预设
 *
 * 权限模式（成员制）：
 *   - 全体开发者可见应用列表与执行历史
 *   - **执行**需要先加入应用（自助加入）；创建者与平台管理员天然可执行
 *   - 改 / 删 / 管成员：仅创建者与平台管理员
 *
 * 命令行拼接规则（按需求约定）：
 *   命令主体 + 参数flag1 + 值1 + 参数flag2 + 值2 ...
 *   - 命令主体原样保留（用户可写 `cd .. && python3 xxx.py`）
 *   - value 模式：` flag value`（值做 shell 转义，含空格也安全）
 *   - switch 模式：` flag`（只拼开关，不带值）
 */
import { nanoid } from 'nanoid';
import { db } from '../db/init.js';
import {
  /**
   * 平台管理员判断。
   * 复用 services/platform-admin.ts 的实现（读 platform_admins 表），
   * 不要在这里重新推导一遍 —— 两处逻辑漂移会导致「同一个人在一处是管理员、另一处不是」。
   */
    isPlatformAdmin,
  } from './platform-admin.js';
  import { resolveWorkdirOnHost } from './host-exec.js';
import type {
  ScriptApp,
  ScriptAppMember,
  ScriptCommand,
  ScriptMemberRole,
  ScriptParam,
  ScriptRun,
} from '../types.js';

/** 校验失败：路由层转成 400，带明确文案 */
export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptError';
  }
}

/* ------------------------------------------------------------------ *
 * 输入类型
 * ------------------------------------------------------------------ */

export type ParamInput = {
  flag: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  valueMode?: 'value' | 'switch';
  inputType?: 'text' | 'select';
  options?: string[];
};

export type CommandInput = {
  /** 命令组名 */
  name: string;
  description?: string;
  mainCommand: string;
  params?: ParamInput[];
};

export type AppInput = {
  name: string;
  description?: string;
  workdir: string;
  enabled?: boolean;
  commands?: CommandInput[];
};

/* ------------------------------------------------------------------ *
 * 路径与参数校验
 * ------------------------------------------------------------------ */

/** 允许执行脚本的根目录白名单（逗号分隔），默认 /root/SSE_Market */
export function allowedRoots(): string[] {
  const raw = process.env.SCRIPT_ALLOWED_ROOTS ?? '/root/SSE_Market';
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * 根目录必须绝对路径且落在白名单内。
 * 做路径规范化后再比较，避免 `/root/SSE_Market/../etc` 这类绕过。
 */
export function validateWorkdir(workdir: string): string {
  const dir = (workdir ?? '').trim();
  if (!dir) throw new ScriptError('请填写根目录（执行命令时先 cd 到这里）');
  if (!dir.startsWith('/')) throw new ScriptError('根目录必须是绝对路径');
  const normalized = normalizePath(dir);
  const roots = allowedRoots();
  const ok = roots.some((r) => normalized === r || normalized.startsWith(`${r}/`));
  if (!ok) {
    throw new ScriptError(`根目录必须位于允许范围内：${roots.join('、')}`);
  }
  return normalized;
}

/** 纯字符串规范化（不触碰文件系统，避免路径不存在时误判） */
function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

/**
 * 在宿主机上再校验一次根目录，返回**解析后的真实路径**（落库用）。
 *
 * `validateWorkdir` 只做纯字符串判断，挡得住 `/root/SSE_Market/../etc` 这类穿越，
 * 但挡不住白名单目录内的软链指向外面。这里进宿主命名空间 `readlink -f` 解析，
 * 确保「字符串上在范围内」等价于「真实路径也在范围内」。
 *
 * 落库解析后的路径而不是用户原始输入：这样列表/详情里展示的 `宿主机 <目录>`
 * 与执行时 `cd` 进去的目录严格一致，不会有「看着在 A、其实在 B」。
 */
async function resolveWorkdir(normalized: string): Promise<string> {
  try {
    return await resolveWorkdirOnHost(normalized, allowedRoots());
  } catch (e) {
    // 宿主校验器的报错已经是给用户看的中文，包装成 ScriptError 以便路由按 400 返回
    throw new ScriptError(e instanceof Error ? e.message : '根目录校验失败');
  }
}

/** 参数名只允许 -x / --xxx / xxx 形式，避免把用户输入当命令注入 */
function validateFlag(flag: string): string {
  const f = (flag ?? '').trim();
  if (!f) throw new ScriptError('参数名不能为空');
  if (!/^-{0,2}[A-Za-z0-9][A-Za-z0-9_-]*$/.test(f)) {
    throw new ScriptError(`参数名不合法：${f}（只允许字母数字与 - _ ，如 --branch）`);
  }
  return f;
}

/** 参数值做 shell 单引号转义，含空格 / 引号 / $ 都不会被解释 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/* ------------------------------------------------------------------ *
 * 命令行拼接
 * ------------------------------------------------------------------ */

/**
 * 按「命令主体 + flag1 值1 + flag2 值2」拼接最终命令行。
 * 值为空的参数直接跳过（这就是「参数可选」的实现方式）。
 */
export function assembleCommandLine(
  mainCommand: string,
  params: ScriptParam[],
  values: Record<string, string>
): { commandLine: string; used: ScriptParam[] } {
  const main = (mainCommand ?? '').trim();
  if (!main) throw new ScriptError('命令主体为空，请先在应用里配置命令');

  const parts: string[] = [main];
  const used: ScriptParam[] = [];
  for (const p of params) {
    const mode = p.valueMode === 'switch' ? 'switch' : 'value';
    if (mode === 'switch') {
      // 开关：勾选（值非空且不是 '0'/'false'）才拼接
      const raw = (values[p.id] ?? '').trim();
      if (!raw || raw === '0' || raw === 'false') continue;
      parts.push(p.flag);
      used.push(p);
      continue;
    }
    const value = (values[p.id] ?? '').trim();
    if (!value) {
      if (p.required) throw new ScriptError(`参数「${p.label || p.flag}」为必填`);
      continue; // 可选参数留空 → 不拼接
    }
    parts.push(p.flag, shellQuote(value));
    used.push(p);
  }
  return { commandLine: parts.join(' '), used };
}

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

type AppRow = {
  id: string;
  name: string;
  description: string;
  workdir: string;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type CommandRow = {
  id: string;
  app_id: string;
  name: string;
  description: string;
  main_command: string;
  sort_order: number;
};

type ParamRow = {
  id: string;
  command_id: string;
  flag: string;
  label: string;
  placeholder: string;
  default_value: string;
  required: number;
  value_mode: string;
  input_type: string;
  options_json: string;
  sort_order: number;
};

function rowToParam(r: ParamRow): ScriptParam {
  let options: string[] = [];
  try {
    const parsed = JSON.parse(r.options_json || '[]');
    if (Array.isArray(parsed)) options = parsed.map((x) => String(x));
  } catch {
    options = [];
  }
  return {
    id: r.id,
    commandId: r.command_id,
    flag: r.flag,
    label: r.label,
    placeholder: r.placeholder,
    defaultValue: r.default_value,
    required: Boolean(r.required),
    valueMode: r.value_mode === 'switch' ? 'switch' : 'value',
    inputType: r.input_type === 'select' ? 'select' : 'text',
    options,
    sortOrder: r.sort_order,
  };
}

function rowToCommand(r: CommandRow, params: ScriptParam[]): ScriptCommand {
  return {
    id: r.id,
    appId: r.app_id,
    name: r.name,
    description: r.description ?? '',
    mainCommand: r.main_command,
    sortOrder: r.sort_order,
    params: params.filter((p) => p.commandId === r.id),
  };
}

/**
 * 组装应用列表。
 * viewerId 用于标注 canRun / canManage / joined；不传则全部按"不可操作"返回。
 */
export function listApps(opts?: { includeDisabled?: boolean; viewerId?: string }): ScriptApp[] {
  const rows = db
    .prepare(
      `SELECT * FROM script_apps ${opts?.includeDisabled ? '' : 'WHERE enabled = 1'}
       ORDER BY updated_at DESC`
    )
    .all() as AppRow[];
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const cmdRows = db
    .prepare(
      `SELECT * FROM script_commands WHERE app_id IN (${placeholders}) ORDER BY sort_order, rowid`
    )
    .all(...ids) as CommandRow[];
  const cmdIds = cmdRows.map((c) => c.id);
  const paramRows = cmdIds.length
    ? (db
        .prepare(
          `SELECT * FROM script_params WHERE command_id IN (${cmdIds
            .map(() => '?')
            .join(',')}) ORDER BY sort_order, rowid`
        )
        .all(...cmdIds) as ParamRow[])
    : [];
  const params = paramRows.map(rowToParam);
  const commands = cmdRows.map((c) => rowToCommand(c, params));

  const memberRows = db
    .prepare(
      `SELECT app_id, user_id, role FROM script_app_members WHERE app_id IN (${placeholders})`
    )
    .all(...ids) as { app_id: string; user_id: string; role: string }[];
  const memberCount = new Map<string, number>();
  const owners = new Map<string, string>();
  const joinedApps = new Set<string>();
  for (const m of memberRows) {
    memberCount.set(m.app_id, (memberCount.get(m.app_id) ?? 0) + 1);
    if (m.role === 'owner') owners.set(m.app_id, m.user_id);
    if (opts?.viewerId && m.user_id === opts.viewerId) joinedApps.add(m.app_id);
  }

  return rows.map((r) => {
    const viewer = opts?.viewerId;
    const isAdmin = viewer ? isPlatformAdmin(viewer) : false;
    const isCreator = viewer === r.created_by;
    const joined = joinedApps.has(r.id);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      workdir: r.workdir,
      enabled: Boolean(r.enabled),
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      commands: commands.filter((c) => c.appId === r.id),
      memberCount: memberCount.get(r.id) ?? 0,
      canRun: Boolean(viewer) && (joined || isCreator || isAdmin),
      canManage: Boolean(viewer) && (isCreator || isAdmin),
      joined,
    };
  });
}

export function getApp(id: string, viewerId?: string): ScriptApp | null {
  return listApps({ includeDisabled: true, viewerId }).find((a) => a.id === id) ?? null;
}

export function listMembers(appId: string, viewerId?: string): ScriptAppMember[] {
  const rows = db
    .prepare(
      `SELECT m.user_id, m.role, m.joined_at, u.name, u.email, u.avatar_url
       FROM script_app_members m JOIN users u ON u.id = m.user_id
       WHERE m.app_id = ?
       ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.joined_at`
    )
    .all(appId) as {
    user_id: string;
    role: string;
    joined_at: string;
    name: string;
    email: string;
    avatar_url: string;
  }[];
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    avatarUrl: r.avatar_url,
    role: (r.role === 'owner' ? 'owner' : 'member') as ScriptMemberRole,
    joinedAt: r.joined_at,
    isSelf: viewerId ? r.user_id === viewerId : false,
  }));
}

export function isMember(appId: string, userId: string): boolean {
  const r = db
    .prepare('SELECT 1 FROM script_app_members WHERE app_id = ? AND user_id = ?')
    .get(appId, userId);
  return Boolean(r);
}

export function listRuns(appId: string, limit = 30): ScriptRun[] {
  const rows = db
    .prepare(
      `SELECT r.*, u.name AS operator_name
       FROM script_runs r LEFT JOIN users u ON u.id = r.operator_id
       WHERE r.app_id = ? ORDER BY r.created_at DESC LIMIT ?`
    )
    .all(appId, Math.min(Math.max(limit, 1), 100)) as {
    id: string;
    app_id: string;
    command_id: string;
    command_name: string;
    command_line: string;
    param_values_json: string;
    workdir: string;
    status: string;
    exit_code: number | null;
    output: string;
    operator_id: string;
    operator_name: string | null;
    created_at: string;
    finished_at: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    appId: r.app_id,
    commandId: r.command_id,
    commandName: r.command_name,
    commandLine: r.command_line,
    workdir: r.workdir,
    status: r.status,
    exitCode: r.exit_code,
    output: r.output,
    operatorId: r.operator_id,
    operatorName: r.operator_name ?? '（已注销）',
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  }));
}

export function getRun(runId: string): {
  id: string;
  appId: string;
  commandId: string;
  commandName: string;
  status: string;
  commandLine: string;
  workdir: string;
  output: string;
  exitCode: number | null;
  operatorId: string;
  operatorName: string;
  createdAt: string;
  finishedAt: string | null;
} | null {
  const r = db
    .prepare(
      `SELECT r.*, u.name AS operator_name
       FROM script_runs r LEFT JOIN users u ON u.id = r.operator_id
       WHERE r.id = ?`
    )
    .get(runId) as
    | {
        id: string;
        app_id: string;
        command_id: string;
        command_name: string;
        status: string;
        command_line: string;
        workdir: string;
        output: string;
        exit_code: number | null;
        operator_id: string;
        operator_name: string | null;
        created_at: string;
        finished_at: string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    appId: r.app_id,
    commandId: r.command_id,
    commandName: r.command_name,
    status: r.status,
    commandLine: r.command_line,
    workdir: r.workdir,
    output: r.output,
    exitCode: r.exit_code,
    operatorId: r.operator_id,
    operatorName: r.operator_name ?? '（已注销）',
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

/* ------------------------------------------------------------------ *
 * 写入：应用
 * ------------------------------------------------------------------ */

export async function createApp(input: AppInput, userId: string): Promise<ScriptApp> {
  const name = (input.name ?? '').trim();
  if (!name) throw new ScriptError('应用名不能为空');
  const workdir = await resolveWorkdir(validateWorkdir(input.workdir));
  const dup = db.prepare('SELECT 1 FROM script_apps WHERE name = ?').get(name);
  if (dup) throw new ScriptError(`应用名「${name}」已存在`);

  const id = `sapp-${nanoid(10)}`;
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO script_apps (id, name, description, workdir, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      name,
      (input.description ?? '').trim(),
      workdir,
      input.enabled === false ? 0 : 1,
      userId,
      now,
      now
    );
    replaceCommands(id, input.commands ?? [], now);
    // 创建者自动成为 owner，否则「创建完自己执行不了」很反直觉
    db.prepare(
      `INSERT OR REPLACE INTO script_app_members (app_id, user_id, role, joined_at)
       VALUES (?, ?, 'owner', ?)`
    ).run(id, userId, now);
  });
  tx();
  return getApp(id, userId)!;
}

export async function updateApp(id: string, input: AppInput, viewerId?: string): Promise<ScriptApp> {
  const existing = db.prepare('SELECT * FROM script_apps WHERE id = ?').get(id) as
    | AppRow
    | undefined;
  if (!existing) throw new ScriptError('应用不存在');

  const name = (input.name ?? '').trim() || existing.name;
  const dup = db.prepare('SELECT id FROM script_apps WHERE name = ?').get(name) as
    | { id: string }
    | undefined;
  if (dup && dup.id !== id) throw new ScriptError(`应用名「${name}」已存在`);
  const workdir = await resolveWorkdir(validateWorkdir(input.workdir ?? existing.workdir));

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE script_apps SET name = ?, description = ?, workdir = ?, enabled = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      name,
      (input.description ?? existing.description).trim(),
      workdir,
      input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
      now,
      id
    );
    // 命令与参数整组替换：编辑弹窗提交的是完整定义，整替比增量 diff 更不易出错
    if (input.commands) replaceCommands(id, input.commands, now);
  });
  tx();
  return getApp(id, viewerId)!;
}

/** 删除应用（成员/命令/参数靠外键级联；执行记录保留为历史，app_id 不加外键） */
export function deleteApp(id: string): void {
  const r = db.prepare('DELETE FROM script_apps WHERE id = ?').run(id);
  if (!r.changes) throw new ScriptError('应用不存在');
}

function replaceCommands(appId: string, commands: CommandInput[], now: string): void {
  // 先整体校验再落库，避免校验失败留下半截数据（外层有事务兜底，这里仍按顺序校验）
  const prepared = commands.map((c, i) => {
    const name = (c.name ?? '').trim();
    if (!name) throw new ScriptError('命令组名不能为空');
    if (name.length > 40) throw new ScriptError(`命令组名过长：${name}`);
    const mainCommand = (c.mainCommand ?? '').trim();
    if (!mainCommand) throw new ScriptError(`命令组「${name}」的命令主体不能为空`);
    const params = (c.params ?? []).map((p, j) => ({
      flag: validateFlag(p.flag),
      label: (p.label ?? '').trim(),
      placeholder: (p.placeholder ?? '').trim(),
      defaultValue: (p.defaultValue ?? '').trim(),
      required: p.required ? 1 : 0,
      valueMode: p.valueMode === 'switch' ? 'switch' : 'value',
      inputType: p.inputType === 'select' ? 'select' : 'text',
      options: (p.options ?? []).map((o) => String(o).trim()).filter(Boolean),
      sortOrder: j,
    }));
    return { name, description: (c.description ?? '').trim(), mainCommand, sortOrder: i, params };
  });

  // 同应用内命令组重名会让「执行」无法区分，直接拒绝
  const names = prepared.map((p) => p.name);
  const dupName = names.find((n, i) => names.indexOf(n) !== i);
  if (dupName) throw new ScriptError(`命令组名重复：${dupName}`);

  db.prepare('DELETE FROM script_commands WHERE app_id = ?').run(appId);
  for (const c of prepared) {
    const cmdId = `scmd-${nanoid(10)}`;
    db.prepare(
      `INSERT INTO script_commands
         (id, app_id, name, description, main_command, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(cmdId, appId, c.name, c.description, c.mainCommand, c.sortOrder, now, now);
    for (const p of c.params) {
      db.prepare(
        `INSERT INTO script_params
           (id, command_id, flag, label, placeholder, default_value, required, value_mode, input_type, options_json, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `spar-${nanoid(10)}`,
        cmdId,
        p.flag,
        p.label,
        p.placeholder,
        p.defaultValue,
        p.required,
        p.valueMode,
        p.inputType,
        JSON.stringify(p.options),
        p.sortOrder
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * 写入：成员
 * ------------------------------------------------------------------ */

export function joinApp(appId: string, userId: string): void {
  const app = db.prepare('SELECT id FROM script_apps WHERE id = ?').get(appId);
  if (!app) throw new ScriptError('应用不存在');
  if (isMember(appId, userId)) return; // 幂等：重复加入不报错
  db.prepare(
    `INSERT INTO script_app_members (app_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`
  ).run(appId, userId, new Date().toISOString());
}

/** 退出应用；创建者不允许退出（否则应用会变成无人可管） */
export function leaveApp(appId: string, userId: string): void {
  const m = db
    .prepare('SELECT role FROM script_app_members WHERE app_id = ? AND user_id = ?')
    .get(appId, userId) as { role: string } | undefined;
  if (!m) throw new ScriptError('你不在该应用中');
  if (m.role === 'owner') throw new ScriptError('创建者不能退出应用，可先转让或删除应用');
  db.prepare('DELETE FROM script_app_members WHERE app_id = ? AND user_id = ?').run(appId, userId);
}

/** 创建者移除成员（不能移除 owner） */
export function removeMember(appId: string, userId: string): void {
  const m = db
    .prepare('SELECT role FROM script_app_members WHERE app_id = ? AND user_id = ?')
    .get(appId, userId) as { role: string } | undefined;
  if (!m) throw new ScriptError('该用户不在应用中');
  if (m.role === 'owner') throw new ScriptError('不能移除创建者');
  db.prepare('DELETE FROM script_app_members WHERE app_id = ? AND user_id = ?').run(appId, userId);
}

/* ------------------------------------------------------------------ *
 * 执行记录的持久化（供 script-runner 调用）
 * ------------------------------------------------------------------ */

export function createRunRecord(input: {
  id: string;
  appId: string;
  commandId: string;
  commandName: string;
  commandLine: string;
  paramValues: Record<string, string>;
  workdir: string;
  operatorId: string;
}): void {
  db.prepare(
    `INSERT INTO script_runs
       (id, app_id, command_id, command_name, command_line, param_values_json, workdir, status, output, operator_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', '', ?, ?)`
  ).run(
    input.id,
    input.appId,
    input.commandId,
    input.commandName,
    input.commandLine,
    JSON.stringify(input.paramValues),
    input.workdir,
    input.operatorId,
    new Date().toISOString()
  );
}

export function finishRunRecord(
  id: string,
  patch: { status: string; exitCode: number | null; output: string }
): void {
  db.prepare(
    `UPDATE script_runs SET status = ?, exit_code = ?, output = ?, finished_at = ? WHERE id = ?`
  ).run(patch.status, patch.exitCode, patch.output, new Date().toISOString(), id);
}

/** 服务重启时把遗留的 running 记录标记为 interrupted（进程已随容器消失） */
export function markStaleRunsInterrupted(): number {
  const r = db
    .prepare(
      `UPDATE script_runs
         SET status = 'interrupted', finished_at = ?, output = output || '\n[系统] 服务重启，执行中断'
       WHERE status = 'running'`
    )
    .run(new Date().toISOString());
  return r.changes;
}

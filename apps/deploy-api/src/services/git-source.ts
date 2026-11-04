import { spawn } from 'child_process';

export type GitProvider = 'gitee' | 'github' | 'generic';

export interface GitSourceConfig {
  repoUrl: string;
  provider: GitProvider;
  username: string;
  token: string;
}

/** 识别仓库平台：gitee.com / github.com，其余按 generic 处理 */
export function detectGitProvider(url: string): GitProvider {
  const raw = url.trim();
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (host === 'gitee.com' || host.endsWith('.gitee.com')) return 'gitee';
    if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  } catch {
    // 无法解析则按 generic
  }
  return 'generic';
}

/** 去除 URL 中的凭证，用于日志/回写 origin，避免令牌泄露 */
export function redactCredentials(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    return u.toString().replace(/\/+$/, '');
  } catch {
    return url;
  }
}

function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

/**
 * 构造 clone URL：公开仓库直接返回；私有仓库按平台嵌入令牌。
 * - github: x-access-token:<token>（PAT 通用写法，无需真实用户名）
 * - gitee / generic: <username|oauth2>:<token>
 */
export function buildCloneUrl(rawUrl: string, cfg: GitSourceConfig): string {
  const url = normalizeUrl(rawUrl);
  const token = cfg.token?.trim();
  if (!token) return url;
  try {
    const u = new URL(url);
    const user = cfg.provider === 'github' ? 'x-access-token' : cfg.username?.trim() || 'oauth2';
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(token);
    return u.toString();
  } catch {
    return url;
  }
}

function runGit(
  args: string[],
  cwd: string,
  log: (line: string) => void,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let stdout = '';
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (line.trim()) log(line);
      }
    });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (aborted) {
        reject(new Error('已取消'));
        return;
      }
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args[0]} 退出码 ${code}`));
    });
  });
}

export async function assertGitAvailable(log: (line: string) => void): Promise<void> {
  try {
    await runGit(['--version'], process.cwd(), log);
  } catch {
    throw new Error(
      '本机未检测到 git（git --version 失败）。请安装 git 并确保当前用户可执行后再使用 Git 部署。'
    );
  }
}

/**
 * 浅克隆指定分支到 dest，返回解析出的短提交 SHA（8 位）。
 * clone 完成后回写 origin，去除工作目录 .git/config 里的令牌。
 */
export async function cloneBranch(
  cfg: GitSourceConfig,
  branch: string,
  dest: string,
  log: (line: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const cloneUrl = buildCloneUrl(cfg.repoUrl, cfg);
  const cleanUrl = redactCredentials(cloneUrl);

  log(`git clone --depth 1 --branch ${branch} ${cleanUrl}`);
  await runGit(['clone', '--depth', '1', '--branch', branch, cloneUrl, dest], process.cwd(), log, signal);

  try {
    await runGit(['-C', dest, 'remote', 'set-url', 'origin', cleanUrl], process.cwd(), log, signal);
  } catch {
    // 回写失败不影响部署
  }

  const sha = (await runGit(['-C', dest, 'rev-parse', '--short=8', 'HEAD'], process.cwd(), log, signal)).trim();
  if (!sha) throw new Error('无法解析提交 SHA');
  return sha;
}

/**
 * 按指定提交 SHA 浅拉取并检出（用于回滚）。GitHub / Gitee 支持 `fetch <sha>`。
 * 无法取到该 SHA 时抛出，交由上层标记失败。
 */
export async function cloneCommit(
  cfg: GitSourceConfig,
  sha: string,
  dest: string,
  log: (line: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const cloneUrl = buildCloneUrl(cfg.repoUrl, cfg);
  const cleanUrl = redactCredentials(cloneUrl);

  log(`git init ${dest}`);
  await runGit(['init', dest], process.cwd(), log, signal);
  await runGit(['-C', dest, 'remote', 'add', 'origin', cloneUrl], process.cwd(), log, signal);
  log(`git fetch --depth 1 origin ${sha}`);
  await runGit(['-C', dest, 'fetch', '--depth', '1', 'origin', sha], process.cwd(), log, signal);
  await runGit(['-C', dest, 'checkout', 'FETCH_HEAD'], process.cwd(), log, signal);

  try {
    await runGit(['-C', dest, 'remote', 'set-url', 'origin', cleanUrl], process.cwd(), log, signal);
  } catch {
    // 回写失败不影响部署
  }

  const out = (await runGit(['-C', dest, 'rev-parse', '--short=8', 'HEAD'], process.cwd(), log, signal)).trim();
  if (!out) throw new Error('无法解析提交 SHA');
  return out;
}

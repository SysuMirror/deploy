/**
 * Agent 自愈修复器：构建失败后，把上下文（compose / 文件树 / 构建日志尾部）丢给 LLM，
 * 由它生成或修补 compose.yml / Dockerfile，再重试部署。
 * 目标：用户只需上传代码，无需自写 Dockerfile。
 *
 * 说明：修复器只会改写白名单内的构建文件（compose.yml、frontend/backend 的 Dockerfile
 * 与 .dockerignore），不会触碰业务源码，也不会写出 buildDir 之外。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import { getPlatformSetting } from '../db/init.js';
import { agentFixerConfig, chatCompletion, isLlmConfigured } from './llm.js';

const COMPOSE_CANDIDATES = ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml'];

const ALLOWED_WRITE_TARGETS = new Set([
  'compose.yml',
  'compose.yaml',
  'docker-compose.yml',
  'docker-compose.yaml',
  'Dockerfile',
  'frontend/Dockerfile',
  'backend/Dockerfile',
  '.dockerignore',
  'frontend/.dockerignore',
  'backend/.dockerignore',
]);

const SYSTEM_PROMPT = [
  '你是一个 DevOps 构建修复助手。用户把代码上传到云部署平台，平台用 docker compose 构建部署。',
  '约定：compose 必须包含 web（前端）与 api（后端）两个服务；宿主端口用 ${WEB_HOST_PORT} 与 ${API_HOST_PORT} 环境变量注入，禁止写死端口。',
  '你会收到：当前 compose.yml 内容、项目文件树、以及构建失败的日志尾部。',
  '你的任务：找出失败原因（缺少 Dockerfile、依赖安装失败、构建上下文错误、路径错误等），',
  '生成修复后的 compose.yml，以及/或补全 frontend/Dockerfile、backend/Dockerfile。',
  '前端通常是静态站点（nginx 提供）或 Node 构建后静态托管；后端通常是 Node 服务，端口 3000。',
  '只输出一个 JSON 对象，不要输出任何解释文字或代码块标记，格式如下：',
  '{"summary":"一句话说明改了什么","files":[{"path":"compose.yml","content":"<完整文件内容>"}]}',
  'files 里的 path 只允许：compose.yml / docker-compose.yml / frontend/Dockerfile / backend/Dockerfile / .dockerignore 等。',
  '如果你无法确定如何修复，输出 {"summary":"无法自动修复：<原因>","files":[]}。',
].join('\n');

export interface BuildFixContext {
  buildDir: string;
  logTail: string;
}

export interface FixResult {
  changed: boolean;
  summary: string;
}

export function isAgentFixerEnabled(): boolean {
  return isLlmConfigured();
}

export function maxAutoFixAttempts(): number {
  return Math.max(0, Number(process.env.AGENT_MAX_ATTEMPTS) || 1);
}

/** 管理员是否已在平台设置中全局开启 Agent 自愈（默认关闭） */
export function isAgentFixerGloballyEnabled(): boolean {
  const v = getPlatformSetting('agent_fixer_enabled');
  return v === '1' || v === 'true';
}

/**
 * 三条件同时满足才启用 Agent 自愈：
 *  1. 服务端已配置 LLM（AGENT_FIXER_* 且可调用）；
 *  2. 管理员已在平台设置中全局开启；
 *  3. 本次部署用户勾选了「Agent 自动修复」。
 */
export function shouldUseAgentFixer(dep: { useAgentFixer?: boolean }): boolean {
  if (!isLlmConfigured()) return false;
  if (!isAgentFixerGloballyEnabled()) return false;
  return Boolean(dep.useAgentFixer);
}

function findCompose(buildDir: string): { path: string; content: string } | null {
  for (const name of COMPOSE_CANDIDATES) {
    const p = join(buildDir, name);
    if (existsSync(p)) {
      return { path: name, content: readFileSync(p, 'utf8') };
    }
  }
  return null;
}

function listTree(buildDir: string, maxDepth = 4, maxEntries = 200): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || out.length >= maxEntries) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
      const p = join(dir, name);
      const rel = relative(buildDir, p).split(sep).join('/');
      if (out.length >= maxEntries) return;
      try {
        const st = statSync(p);
        out.push(st.isDirectory() ? `${rel}/` : rel);
        if (st.isDirectory()) walk(p, depth + 1);
      } catch {
        // 忽略权限/损坏条目
      }
    }
  };
  walk(buildDir, 0);
  return out;
}

function parseFixJson(raw: string): { summary: string; files: { path: string; content: string }[] } {
  let text = raw.trim();
  // 剥离可能的 ```json ... ``` 代码块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Agent 修复器未返回合法 JSON');
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    summary?: string;
    files?: { path?: string; content?: string }[];
  };
  return {
    summary: parsed.summary ?? '',
    files: (parsed.files ?? [])
      .filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string')
      .map((f) => ({ path: f.path!, content: f.content! })),
  };
}

function sanitizeFiles(buildDir: string, files: { path: string; content: string }[]) {
  const root = resolve(buildDir);
  const safe: { path: string; content: string }[] = [];
  for (const f of files) {
    const normalized = f.path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!ALLOWED_WRITE_TARGETS.has(normalized)) continue;
    const abs = resolve(root, normalized);
    if (abs !== resolve(root, normalized) || !abs.startsWith(root + sep)) continue;
    safe.push({ path: normalized, content: f.content });
  }
  return safe;
}

export async function fixBuild(ctx: BuildFixContext): Promise<FixResult> {
  const compose = findCompose(ctx.buildDir);
  const tree = listTree(ctx.buildDir);
  const parts = [
    '### 当前 compose.yml',
    compose ? `文件：${compose.path}\n${compose.content}` : '（未找到 compose 文件）',
    '',
    '### 项目文件树',
    tree.length ? tree.join('\n') : '（空目录）',
    '',
    '### 构建日志尾部',
    ctx.logTail || '（无日志）',
  ];
  const userPrompt = parts.join('\n');

  const raw = await chatCompletion(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0.2 }
  );

  const parsed = parseFixJson(raw);
  if (!parsed.files.length) {
    return { changed: false, summary: parsed.summary || 'Agent 未给出文件改动' };
  }

  const safeFiles = sanitizeFiles(ctx.buildDir, parsed.files);
  for (const f of safeFiles) {
    writeFileSync(join(ctx.buildDir, f.path), f.content, 'utf8');
  }
  if (!safeFiles.length) {
    return { changed: false, summary: parsed.summary || 'Agent 的改动被拒绝（路径不在白名单）' };
  }
  return { changed: true, summary: parsed.summary || '已应用 Agent 修复' };
}

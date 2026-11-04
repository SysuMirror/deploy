/**
 * 部署 Agent 工具：可读包内任意文本；写入仅限配置与部署脚本白名单。
 * 禁止改动业务源码（*.ts/js/py/vue 等）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import type { ChatToolDefinition } from './llm.js';

/** 相对包根、posix 风格 */
export function normalizeRel(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** 写入白名单：配置 + 部署脚本（不含业务源码） */
const WRITE_EXACT = new Set([
  'deploy.sh',
  'start.sh',
  'run.sh',
  'entrypoint.sh',
  'bootstrap.sh',
  'compose.yml',
  'compose.yaml',
  'docker-compose.yml',
  'docker-compose.yaml',
  'Dockerfile',
  '.dockerignore',
  'nginx.conf',
  'supervisord.conf',
  'Procfile',
  '.env.example',
  '.env.sdpy.example',
  'package.json',
  'requirements.txt',
  'pyproject.toml',
]);

const WRITE_PREFIX_FILES = [
  /^frontend\/Dockerfile$/,
  /^backend\/Dockerfile$/,
  /^api\/Dockerfile$/,
  /^web\/Dockerfile$/,
  /^frontend\/\.dockerignore$/,
  /^backend\/\.dockerignore$/,
  /^frontend\/nginx\.conf$/,
  /^backend\/nginx\.conf$/,
  /^conf\/nginx\.conf$/,
  /^frontend\/package\.json$/,
  /^backend\/package\.json$/,
  /^frontend\/requirements\.txt$/,
  /^backend\/requirements\.txt$/,
];

/** 明确禁止写入的源码扩展名（即使误入白名单也拦） */
const SOURCE_EXT =
  /\.(tsx?|jsx?|vue|svelte|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|m|mm|scala|dart)$/i;

export function isWritableDeployPath(relPath: string): boolean {
  const p = normalizeRel(relPath);
  if (!p || p.includes('..') || p.startsWith('.git/') || p.includes('/.git/')) return false;
  // 业务源码扩展名一律禁止写入
  if (SOURCE_EXT.test(p)) return false;
  if (WRITE_EXACT.has(p)) return true;
  return WRITE_PREFIX_FILES.some((re) => re.test(p));
}

export function describeWriteBoundary(): string {
  return [
    '可写（配置/部署脚本）：',
    '- deploy.sh / start.sh / run.sh / entrypoint.sh / bootstrap.sh',
    '- compose.yml | docker-compose.yml',
    '- Dockerfile、frontend|backend|api|web/Dockerfile、.dockerignore',
    '- nginx.conf、supervisord.conf、Procfile',
    '- .env.example、.env.sdpy.example',
    '- 根或 frontend|backend 的 package.json、requirements.txt；根 pyproject.toml',
    '禁止：任何业务源码（.ts/.js/.vue/.py/.go 等）、src/ 下文件、密钥类 .env（仅 .env.example 可写）',
  ].join('\n');
}

export const DEPLOY_AGENT_TOOLS: ChatToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出包内某目录（相对包根）。用于了解项目结构。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径，默认 "."' },
          max_entries: { type: 'integer', description: '最多条目，默认 80' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取包内文本文件（可含源码，只读）。用于判断如何写部署脚本。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对包根路径' },
          max_chars: { type: 'integer', description: '最多字符，默认 12000' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_write_boundary',
      description: '返回允许写入的路径规则。改文件前应先了解边界。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        '写入配置或部署脚本。路径必须在白名单内；禁止写业务源码。内容为完整文件正文。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对包根，如 deploy.sh' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description:
        '完成任务：确认已写好必要部署文件（通常含 deploy.sh）。summary 简述做了什么。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
        },
        required: ['summary'],
      },
    },
  },
];

export type DeployAgentToolContext = {
  packageRoot: string;
  /** false 时写入只进内存 staging */
  apply: boolean;
  staging: Map<string, string>;
  written: string[];
};

function safeResolve(root: string, relPath: string): string | null {
  const p = normalizeRel(relPath);
  if (!p || p.includes('..')) return null;
  const abs = resolve(root, p);
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
  return abs;
}

function toolJson(obj: unknown): string {
  return JSON.stringify(obj);
}

export function runDeployAgentTool(
  name: string,
  args: Record<string, unknown>,
  ctx: DeployAgentToolContext
): { ok: boolean; result: string; finished?: boolean; summary?: string } {
  try {
    switch (name) {
      case 'list_dir': {
        const rel = normalizeRel(String(args.path ?? '.')) || '.';
        const max = Math.min(200, Math.max(1, Number(args.max_entries) || 80));
        const abs = rel === '.' ? resolve(ctx.packageRoot) : safeResolve(ctx.packageRoot, rel);
        if (!abs || !existsSync(abs) || !statSync(abs).isDirectory()) {
          return { ok: false, result: toolJson({ error: `目录不存在: ${rel}` }) };
        }
        const entries = readdirSync(abs)
          .filter((n) => n !== 'node_modules' && n !== '.git' && n !== '__MACOSX')
          .slice(0, max)
          .map((n) => {
            const p = join(abs, n);
            try {
              return statSync(p).isDirectory() ? `${n}/` : n;
            } catch {
              return n;
            }
          });
        return { ok: true, result: toolJson({ path: rel, entries }) };
      }
      case 'read_file': {
        const rel = normalizeRel(String(args.path ?? ''));
        const max = Math.min(50_000, Math.max(500, Number(args.max_chars) || 12_000));
        const abs = safeResolve(ctx.packageRoot, rel);
        if (!abs || !existsSync(abs) || !statSync(abs).isFile()) {
          return { ok: false, result: toolJson({ error: `文件不存在: ${rel}` }) };
        }
        // staging 优先
        if (ctx.staging.has(rel)) {
          let t = ctx.staging.get(rel)!;
          const truncated = t.length > max;
          if (truncated) t = t.slice(0, max);
          return { ok: true, result: toolJson({ path: rel, content: t, truncated, staged: true }) };
        }
        let content = readFileSync(abs, 'utf8');
        const truncated = content.length > max;
        if (truncated) content = content.slice(0, max);
        return { ok: true, result: toolJson({ path: rel, content, truncated }) };
      }
      case 'get_write_boundary':
        return {
          ok: true,
          result: toolJson({
            rules: describeWriteBoundary(),
            examples: [...WRITE_EXACT].slice(0, 20),
          }),
        };
      case 'write_file': {
        const rel = normalizeRel(String(args.path ?? ''));
        const content = String(args.content ?? '');
        if (!isWritableDeployPath(rel)) {
          return {
            ok: false,
            result: toolJson({
              error: `拒绝写入（非配置/部署脚本或不在白名单）: ${rel}`,
              hint: describeWriteBoundary(),
            }),
          };
        }
        if (!content.trim()) {
          return { ok: false, result: toolJson({ error: 'content 为空' }) };
        }
        let body = content;
        if (rel.endsWith('.sh') && !body.startsWith('#!')) {
          body = `#!/usr/bin/env bash\n${body}`;
        }
        if (!body.endsWith('\n')) body += '\n';

        ctx.staging.set(rel, body);
        if (!ctx.written.includes(rel)) ctx.written.push(rel);

        if (ctx.apply) {
          const abs = safeResolve(ctx.packageRoot, rel);
          if (!abs) {
            return { ok: false, result: toolJson({ error: '非法路径' }) };
          }
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, body, 'utf8');
          if (rel.endsWith('.sh')) {
            try {
              chmodSync(abs, 0o755);
            } catch {
              // Windows 可忽略
            }
          }
        }
        return {
          ok: true,
          result: toolJson({
            written: rel,
            bytes: Buffer.byteLength(body, 'utf8'),
            applied: ctx.apply,
          }),
        };
      }
      case 'done': {
        const summary = String(args.summary ?? '').trim() || '完成';
        return { ok: true, result: toolJson({ done: true, summary, written: ctx.written }), finished: true, summary };
      }
      default:
        return { ok: false, result: toolJson({ error: `未知工具: ${name}` }) };
    }
  } catch (e) {
    return { ok: false, result: toolJson({ error: e instanceof Error ? e.message : String(e) }) };
  }
}

export function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

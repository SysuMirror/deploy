/**
 * 部署 Agent（tool-calling）：自行探索压缩包并写入配置/部署脚本。
 * 硬边界：不可改业务源码，只能 write 白名单内配置与 deploy 脚本。
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { chatCompletionWithTools, isLlmConfigured, type ChatMessage } from './llm.js';
import {
  DEPLOY_AGENT_TOOLS,
  describeWriteBoundary,
  parseToolArgs,
  runDeployAgentTool,
  type DeployAgentToolContext,
} from './deploy-agent-tools.js';
import { resolvePackageForDeploy } from './project.js';
import { hasDeploySh } from './package-store.js';

const MAX_TURNS = Math.max(4, Number(process.env.DEPLOY_AGENT_MAX_TURNS) || 12);

const SYSTEM = `你是软工学院 SDPY 平台的**部署 Agent**。目标运行时是 sseinfra 学生组容器（Ubuntu，**无 Docker**）。

## 工作方式
- 用工具自行探索项目（list_dir / read_file），再决定如何部署，不要假设单一模板。
- 用 write_file 写入配置或部署脚本；完成后调用 done。
- 有 tool_calls 时平台会执行工具并续轮；你必须通过工具落地文件，不要只在对话里贴长脚本却不 write_file。

## 运行时约定（sseinfra）
- 平台用 supervisord 执行仓根可执行脚本 deploy.sh
- deploy.sh 必须监听 0.0.0.0:$PORT（默认 8080），前台常驻（优先 exec），勿后台后立即退出
- 可用环境变量：PORT、SDPY_DATA_DIR、DATA_DIR、MINIO_*、MYSQL_*、REDIS_*
- 禁止在脚本里依赖 docker / docker-compose / kubectl

## 写入边界（硬约束，平台会强制校验）
${describeWriteBoundary()}
- 可读任意文本以作判断；不可写业务源码
- 通常至少应写出可用的 deploy.sh；必要时可改 compose/Dockerfile（给本机 compose 路径用），但 K8s 主路径仍靠 deploy.sh

## 策略提示
- 先 list_dir，再按需读 compose、package.json、入口文件
- 若已有合格 deploy.sh，可读后微调，勿无故重写
- 前后端分离：脚本内装依赖、构建前端，并由后端或静态服务统一对外 $PORT`;

export type DeployAgentEvent =
  | { type: 'meta'; message: string }
  | { type: 'assistant'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; id: string }
  | { type: 'tool_result'; name: string; ok: boolean; preview: string; id: string }
  | { type: 'delta'; text: string };

export function assertAgentLlmReady() {
  if (!isLlmConfigured()) {
    throw new Error('未配置 LLM：请在管理台「AI / vLLM」添加端点并设为当前，或配置 AGENT_FIXER_API_KEY');
  }
}

function previewToolResult(raw: string, max = 400): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Tool Agent 循环。有 tool_calls 必须执行并续轮；done 或无工具且已写入 deploy.sh 可结束。
 */
export async function generateDeployShForModule(
  moduleId: string,
  opts?: {
    packageVersion?: string;
    apply?: boolean;
    onEvent?: (ev: DeployAgentEvent) => void;
    /** @deprecated 兼容旧流式：映射为 assistant/delta 文本 */
    onDelta?: (text: string) => void;
    signal?: AbortSignal;
  }
): Promise<{
  deploySh: string;
  applied: boolean;
  packagePath: string;
  hadDeploySh: boolean;
  writtenFiles: string[];
  summary: string;
  turns: number;
}> {
  assertAgentLlmReady();
  if (opts?.signal?.aborted) throw new Error('已取消');
  const pkg = resolvePackageForDeploy(moduleId, opts?.packageVersion);
  if (!pkg.packagePath || !existsSync(pkg.packagePath)) {
    throw new Error('模块尚无压缩包，请先上传包或改用 Git 仓自带 deploy.sh');
  }

  const apply = opts?.apply !== false;
  const emit = (ev: DeployAgentEvent) => {
    opts?.onEvent?.(ev);
    if (ev.type === 'delta' || ev.type === 'assistant') {
      opts?.onDelta?.(ev.type === 'delta' ? ev.text : ev.text);
    }
    if (ev.type === 'tool_call') {
      opts?.onDelta?.(`\n[tool] ${ev.name}(${JSON.stringify(ev.args).slice(0, 120)})\n`);
    }
    if (ev.type === 'tool_result') {
      opts?.onDelta?.(`[result] ${ev.ok ? 'ok' : 'fail'}: ${ev.preview}\n`);
    }
  };

  const had = hasDeploySh(pkg.packagePath);
  const ctx: DeployAgentToolContext = {
    packageRoot: pkg.packagePath,
    apply,
    staging: new Map(),
    written: [],
  };

  emit({ type: 'meta', message: '部署 Agent 启动（tool-calling）' });

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        '请为当前压缩包准备 sseinfra 可运行的部署配置。',
        '先用工具查看结构，再写入必要文件（至少 deploy.sh），最后调用 done。',
        `包根路径（容器内逻辑）：${pkg.packagePath}`,
        `当前是否已有 deploy.sh：${had ? '是' : '否'}`,
        apply ? '本次会实际写入包内文件。' : '本次仅演练写入（staging，不落盘）。',
      ].join('\n'),
    },
  ];

  let summary = '';
  let finished = false;
  let turns = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (opts?.signal?.aborted) throw new Error('已取消');
    turns = turn + 1;
    const result = await chatCompletionWithTools(messages, {
      temperature: 0.15,
      tools: DEPLOY_AGENT_TOOLS,
      tool_choice: 'auto',
    });
    if (opts?.signal?.aborted) throw new Error('已取消');

    if (result.reasoning_content.trim()) {
      emit({ type: 'reasoning', text: result.reasoning_content.trim() });
      emit({
        type: 'delta',
        text: `[thinking]\n${result.reasoning_content.trim().slice(0, 800)}${
          result.reasoning_content.length > 800 ? '…' : ''
        }\n`,
      });
    }
    if (result.content.trim()) {
      emit({ type: 'assistant', text: result.content.trim() + '\n' });
    }

    if (result.tool_calls.length) {
      // DeepSeek 思考+tools：必须回传 reasoning_content，否则后续请求 400
      messages.push({
        role: 'assistant',
        content: result.content || null,
        reasoning_content: result.reasoning_content || null,
        tool_calls: result.tool_calls,
      });

      for (const call of result.tool_calls) {
        const name = call.function?.name || '';
        const args = parseToolArgs(call.function?.arguments || '{}');
        emit({ type: 'tool_call', name, args, id: call.id });
        const out = runDeployAgentTool(name, args, ctx);
        emit({
          type: 'tool_result',
          name,
          ok: out.ok,
          preview: previewToolResult(out.result),
          id: call.id,
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name,
          content: out.result,
        });
        if (out.finished) {
          finished = true;
          summary = out.summary || summary;
        }
      }
      if (finished) break;
      continue;
    }

    // 无工具：若已写过 deploy.sh 可结束，否则提示继续
    if (ctx.staging.has('deploy.sh') || hasDeploySh(pkg.packagePath)) {
      summary = summary || result.content.trim() || 'Agent 结束（无更多工具调用）';
      finished = true;
      break;
    }
    messages.push({
      role: 'assistant',
      content: result.content || null,
      reasoning_content: result.reasoning_content || null,
    });
    messages.push({
      role: 'user',
      content: '请继续：用 write_file 写出 deploy.sh（或必要配置），完成后调用 done。不要只描述不做写入。',
    });
  }

  if (!finished && !ctx.staging.has('deploy.sh') && !hasDeploySh(pkg.packagePath)) {
    // 兜底：强制无工具要说明
    const final = await chatCompletionWithTools(messages, {
      temperature: 0.1,
      tool_choice: 'none',
    });
    if (final.content.trim()) emit({ type: 'assistant', text: final.content.trim() });
    throw new Error(
      `Agent 超过 ${MAX_TURNS} 轮仍未写出 deploy.sh。请检查模型是否支持 tools，或手动上传模板。`
    );
  }

  const deployPath = join(pkg.packagePath, 'deploy.sh');
  const deploySh =
    ctx.staging.get('deploy.sh') ||
    (existsSync(deployPath) ? readFileSync(deployPath, 'utf8') : '');

  if (!deploySh.trim()) {
    throw new Error('Agent 未产生 deploy.sh 内容');
  }

  return {
    deploySh,
    applied: apply && ctx.written.length > 0,
    packagePath: pkg.packagePath,
    hadDeploySh: had,
    writtenFiles: [...ctx.written],
    summary: summary || `已写入: ${ctx.written.join(', ') || '(无变更)'}`,
    turns,
  };
}

/**
 * 压缩包缺少 deploy.sh 时自动跑部署 Agent 生成并写入。
 * 已有则跳过。用于迁移 / K8s 包部署前的兜底。
 */
export async function ensurePackageHasDeploySh(
  moduleId: string,
  opts?: {
    packageVersion?: string;
    onEvent?: (ev: DeployAgentEvent) => void;
    signal?: AbortSignal;
  }
): Promise<{ generated: boolean; hadDeploySh: boolean; summary: string }> {
  if (opts?.signal?.aborted) throw new Error('已取消');
  const pkg = resolvePackageForDeploy(moduleId, opts?.packageVersion);
  if (!pkg.packagePath || !existsSync(pkg.packagePath)) {
    throw new Error('模块尚无压缩包，无法自动生成 deploy.sh');
  }
  if (hasDeploySh(pkg.packagePath)) {
    return { generated: false, hadDeploySh: true, summary: '压缩包已有 deploy.sh' };
  }
  if (!isLlmConfigured()) {
    throw new Error(
      '压缩包缺少根目录 deploy.sh（组内无 Docker）。请在管理台配置 AI/vLLM 以便确认后自动生成，或手动上传含 deploy.sh 的包 / 改用 Git'
    );
  }
  opts?.onEvent?.({ type: 'meta', message: '用户已确认：启动部署 Agent 生成 deploy.sh…' });
  const result = await generateDeployShForModule(moduleId, {
    packageVersion: opts?.packageVersion,
    apply: true,
    onEvent: opts?.onEvent,
    signal: opts?.signal,
  });
  if (opts?.signal?.aborted) throw new Error('已取消');
  if (!hasDeploySh(pkg.packagePath)) {
    throw new Error(
      `Agent 未能写出 deploy.sh（${result.summary || '无摘要'}）。请手动补脚本或改用 Git 迁移`
    );
  }
  return {
    generated: true,
    hadDeploySh: false,
    summary: result.summary || `已自动生成: ${(result.writtenFiles || []).join(', ')}`,
  };
}

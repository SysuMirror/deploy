/**
 * OpenAI 兼容聊天客户端：支持管理台自定义端点（含 vLLM）与 AGENT_FIXER_* 环境变量回退。
 * 支持 tools / tool_calls（部署 Agent）；流式协议对齐 iWiki。
 */
import {
  normalizeChatCompletionsUrl,
  resolveActiveCustomEndpoint,
  type AiCustomEndpoint,
} from './ai-custom-endpoints.js';

export type ChatToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ChatToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** DeepSeek 思考模式：有 tool_calls 时后续轮次必须原样回传，否则 API 400 */
  reasoning_content?: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export type ChatCompletionResult = {
  content: string;
  reasoning_content: string;
  tool_calls: ChatToolCall[];
  finish_reason: string | null;
};

export type ResolvedLlm = {
  apiUrl: string;
  apiKey: string | null;
  model: string;
  label: string;
  requireAuth: boolean;
};

const DEFAULT_BASE_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-v4-flash';

function envFallback(): ResolvedLlm | null {
  const baseUrl = process.env.AGENT_FIXER_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const apiKey =
    process.env.AGENT_FIXER_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim() || '';
  const model = process.env.AGENT_FIXER_MODEL?.trim() || DEFAULT_MODEL;
  if (!apiKey && !process.env.AGENT_FIXER_BASE_URL) return null;
  if (!apiKey && !/127\.0\.0\.1|localhost|vllm/i.test(baseUrl)) return null;
  return {
    apiUrl: normalizeChatCompletionsUrl(baseUrl),
    apiKey: apiKey || null,
    model,
    label: 'env AGENT_FIXER',
    requireAuth: Boolean(apiKey),
  };
}

function fromCustom(ep: AiCustomEndpoint): ResolvedLlm {
  return {
    apiUrl: normalizeChatCompletionsUrl(ep.baseUrl),
    apiKey: ep.apiKey.trim() || null,
    model: ep.model,
    label: ep.label,
    requireAuth: ep.format === 'openai',
  };
}

export function resolveLlmEndpoint(): ResolvedLlm {
  const custom = resolveActiveCustomEndpoint();
  if (custom) return fromCustom(custom);
  const env = envFallback();
  if (env) return env;
  throw new Error(
    '未配置 LLM：请在管理台添加 OpenAI/vLLM 端点，或设置 AGENT_FIXER_API_KEY / DEEPSEEK_API_KEY'
  );
}

export function isLlmConfigured(): boolean {
  try {
    const r = resolveLlmEndpoint();
    if (r.requireAuth && !r.apiKey) return false;
    return Boolean(r.apiUrl && r.model);
  } catch {
    return false;
  }
}

/** @deprecated 兼容旧调用名 */
export function agentFixerConfig() {
  try {
    const r = resolveLlmEndpoint();
    return {
      baseUrl: r.apiUrl,
      apiKey: r.apiKey || '',
      model: r.model,
      enabled: isLlmConfigured(),
    };
  } catch {
    return { baseUrl: DEFAULT_BASE_URL, apiKey: '', model: DEFAULT_MODEL, enabled: false };
  }
}

async function fetchChat(
  apiUrl: string,
  apiKey: string | null,
  body: Record<string, unknown>,
  requireAuth: boolean,
  label: string
): Promise<Response> {
  if (requireAuth && !apiKey) {
    throw new Error(`${label} 需要 apiKey`);
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = `${label} 请求失败 (${res.status})`;
    try {
      const j = JSON.parse(raw) as { error?: { message?: string }; message?: string };
      message = j.error?.message ?? j.message ?? message;
    } catch {
      if (raw.trim()) message = `${message}: ${raw.slice(0, 200)}`;
    }
    throw new Error(message);
  }
  return res;
}

/** 简单补全（无 tools），供 build-fixer 等使用 */
export async function chatCompletion(
  messages: ChatMessage[],
  opts?: { temperature?: number }
): Promise<string> {
  const result = await chatCompletionWithTools(messages, {
    temperature: opts?.temperature,
  });
  if (!result.content.trim()) throw new Error('LLM 返回内容为空');
  return result.content.trim();
}

function isDeepSeekEndpoint(ep: ResolvedLlm): boolean {
  return /api\.deepseek\.com/i.test(ep.apiUrl) || /^deepseek-/i.test(ep.model);
}

/** 序列化 messages：保留 reasoning_content（DeepSeek tools 续轮必需） */
function serializeMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    const out: Record<string, unknown> = {
      role: m.role,
      content: m.content,
    };
    if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
    // 有 tools 时 DeepSeek 要求回传；无值也勿传空串干扰其它厂商
    if (typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0) {
      out.reasoning_content = m.reasoning_content;
    } else if (m.reasoning_content === null && m.tool_calls?.length) {
      // 部分回合模型返回 null，仍需带字段以满足「完整回传」
      out.reasoning_content = null;
    }
    return out;
  });
}

/** 支持 tools；若返回 tool_calls，调用方必须执行并续轮 */
export async function chatCompletionWithTools(
  messages: ChatMessage[],
  opts?: {
    temperature?: number;
    tools?: ChatToolDefinition[];
    tool_choice?: 'auto' | 'none' | 'required';
    /** DeepSeek：默认对官方端点开启思考；可显式关闭 */
    thinking?: boolean;
    reasoning_effort?: 'low' | 'high' | 'max';
  }
): Promise<ChatCompletionResult> {
  const ep = resolveLlmEndpoint();
  const useThinking = opts?.thinking ?? isDeepSeekEndpoint(ep);
  const body: Record<string, unknown> = {
    model: ep.model,
    messages: serializeMessages(messages),
    stream: false,
  };
  // 思考模式下 temperature 等无效；非 DeepSeek 仍传以兼容 vLLM
  if (!useThinking) {
    body.temperature = opts?.temperature ?? 0.2;
  } else {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = opts?.reasoning_effort ?? 'high';
  }
  if (opts?.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.tool_choice ?? 'auto';
  }

  const res = await fetchChat(ep.apiUrl, ep.apiKey, body, ep.requireAuth, ep.label);
  const json = (await res.json()) as {
    choices?: {
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        tool_calls?: ChatToolCall[];
      };
      finish_reason?: string | null;
    }[];
  };

  const choice = json.choices?.[0];
  const message = choice?.message;
  const tool_calls = Array.isArray(message?.tool_calls) ? message!.tool_calls! : [];
  const content = typeof message?.content === 'string' ? message.content : '';
  const reasoning_content =
    typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';

  if (!content.trim() && !tool_calls.length) {
    throw new Error('LLM 返回内容为空且无 tool_calls');
  }

  return {
    content: content.trim(),
    reasoning_content,
    tool_calls,
    finish_reason: choice?.finish_reason ?? null,
  };
}

function parseSseLines(buffer: string, onData: (payload: string) => void): string {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    onData(payload);
  }
  return rest;
}

/** 流式补全；handlers.onContent 收到增量文本 */
export async function streamChatCompletion(
  messages: ChatMessage[],
  handlers: { onContent: (text: string) => void },
  opts?: { temperature?: number }
): Promise<string> {
  const ep = resolveLlmEndpoint();
  const res = await fetchChat(
    ep.apiUrl,
    ep.apiKey,
    {
      model: ep.model,
      messages,
      stream: true,
      temperature: opts?.temperature ?? 0.2,
    },
    ep.requireAuth,
    ep.label
  );

  if (!res.body) throw new Error('上游未返回流式 body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = parseSseLines(buffer, (payload) => {
      try {
        const j = JSON.parse(payload) as {
          choices?: { delta?: { content?: string | null } }[];
        };
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          handlers.onContent(delta);
        }
      } catch {
        // ignore malformed chunk
      }
    });
  }

  if (!full.trim()) throw new Error('流式 LLM 返回为空');
  return full.trim();
}

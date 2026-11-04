/**
 * 自定义 OpenAI 兼容 / vLLM 端点（对齐 iWiki ai_custom_endpoints）。
 * 存 platform_settings.ai_custom_endpoints；密钥不回传明文。
 */
import { nanoid } from 'nanoid';
import { db } from '../db/init.js';
import { getPlatformSetting, setPlatformSetting } from '../db/init.js';

const SETTINGS_KEY = 'ai_custom_endpoints';
const ACTIVE_KEY = 'agent_llm_endpoint_id';

export type AiApiFormat = 'openai' | 'vllm';

export type AiCustomEndpoint = {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  format: AiApiFormat;
};

export type AiCustomEndpointInput = {
  label: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  format: AiApiFormat;
};

export type AiCustomEndpointAdminView = Omit<AiCustomEndpoint, 'apiKey'> & {
  configured: boolean;
  maskedKey: string | null;
  hasApiKey: boolean;
  isActive: boolean;
};

function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 3)}****${trimmed.slice(-4)}`;
}

function parseFormat(value: unknown): AiApiFormat | null {
  if (value === 'openai' || value === 'vllm') return value;
  return null;
}

function readRaw(): AiCustomEndpoint[] {
  const row = db.prepare('SELECT value FROM platform_settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value?.trim()) return [];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: AiCustomEndpoint[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const raw = item as Record<string, unknown>;
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      const label = typeof raw.label === 'string' ? raw.label.trim() : '';
      const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
      const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : '';
      const model = typeof raw.model === 'string' ? raw.model.trim() : '';
      const format = parseFormat(raw.format);
      if (!id || !label || !baseUrl || !model || !format) continue;
      out.push({ id, label, baseUrl, apiKey, model, format });
    }
    return out;
  } catch {
    return [];
  }
}

function writeAll(list: AiCustomEndpoint[], updatedBy: string | null) {
  setPlatformSetting(SETTINGS_KEY, JSON.stringify(list), updatedBy ?? undefined);
}

export function normalizeChatCompletionsUrl(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/$/, '');
  // DeepSeek / OpenAI：允许填 https://api.deepseek.com 或 .../v1 或已带 /chat/completions
  base = base.replace(/\/chat\/completions$/i, '');
  // DeepSeek 文档 base_url 不含 /v1；若用户误填 /v1 也兼容
  if (/api\.deepseek\.com$/i.test(base)) {
    return `${base}/chat/completions`;
  }
  return `${base}/chat/completions`;
}

export function isCustomEndpointConfigured(endpoint: AiCustomEndpoint): boolean {
  if (!endpoint.baseUrl.trim() || !endpoint.model.trim()) return false;
  if (endpoint.format === 'openai' && !endpoint.apiKey.trim()) return false;
  return true;
}

export function listCustomEndpoints(): AiCustomEndpoint[] {
  return readRaw();
}

export function getCustomEndpoint(id: string): AiCustomEndpoint | undefined {
  return readRaw().find((item) => item.id === id);
}

export function getActiveEndpointId(): string {
  return (getPlatformSetting(ACTIVE_KEY) || '').trim();
}

export function setActiveEndpointId(id: string, updatedBy?: string) {
  setPlatformSetting(ACTIVE_KEY, id.trim(), updatedBy);
}

/** 当前 Agent 使用的端点：显式激活 → 第一个已配置 → undefined */
export function resolveActiveCustomEndpoint(): AiCustomEndpoint | undefined {
  const list = readRaw().filter(isCustomEndpointConfigured);
  if (!list.length) return undefined;
  const active = getActiveEndpointId();
  if (active) {
    const hit = list.find((e) => e.id === active);
    if (hit) return hit;
  }
  return list[0];
}

export function toAdminView(endpoint: AiCustomEndpoint): AiCustomEndpointAdminView {
  const key = endpoint.apiKey.trim();
  const active = getActiveEndpointId();
  return {
    id: endpoint.id,
    label: endpoint.label,
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
    format: endpoint.format,
    configured: isCustomEndpointConfigured(endpoint),
    hasApiKey: Boolean(key),
    maskedKey: key ? maskApiKey(key) : null,
    isActive: active === endpoint.id || (!active && resolveActiveCustomEndpoint()?.id === endpoint.id),
  };
}

export function listCustomEndpointsForAdmin(): AiCustomEndpointAdminView[] {
  return readRaw().map(toAdminView);
}

function normalizeInput(input: AiCustomEndpointInput, existingKey?: string): AiCustomEndpointInput {
  const format = parseFormat(input.format);
  if (!format) throw new Error('format 须为 openai 或 vllm');
  const label = input.label?.trim();
  const baseUrl = input.baseUrl?.trim();
  const model = input.model?.trim();
  if (!label) throw new Error('缺少显示名称');
  if (!baseUrl) throw new Error('缺少 baseUrl');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('baseUrl 须以 http:// 或 https:// 开头');
  if (!model) throw new Error('缺少 model');
  const apiKeyRaw = input.apiKey?.trim() ?? '';
  const apiKey = apiKeyRaw || existingKey || '';
  if (format === 'openai' && !apiKey) throw new Error('OpenAI 兼容格式需要 apiKey');
  return { label, baseUrl, apiKey, model, format };
}

export function createCustomEndpoint(
  input: AiCustomEndpointInput,
  updatedBy: string | null
): AiCustomEndpointAdminView {
  const normalized = normalizeInput(input);
  const endpoint: AiCustomEndpoint = {
    id: `custom-${nanoid(8)}`,
    label: normalized.label,
    baseUrl: normalized.baseUrl,
    apiKey: normalized.apiKey ?? '',
    model: normalized.model,
    format: normalized.format,
  };
  const list = readRaw();
  list.push(endpoint);
  writeAll(list, updatedBy);
  if (!getActiveEndpointId()) setActiveEndpointId(endpoint.id, updatedBy ?? undefined);
  return toAdminView(endpoint);
}

export function updateCustomEndpoint(
  id: string,
  input: AiCustomEndpointInput,
  updatedBy: string | null
): AiCustomEndpointAdminView {
  const list = readRaw();
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) throw new Error('自定义 AI 配置不存在');
  const existing = list[index]!;
  const normalized = normalizeInput(input, existing.apiKey);
  const next: AiCustomEndpoint = {
    id: existing.id,
    label: normalized.label,
    baseUrl: normalized.baseUrl,
    apiKey: normalized.apiKey ?? '',
    model: normalized.model,
    format: normalized.format,
  };
  list[index] = next;
  writeAll(list, updatedBy);
  return toAdminView(next);
}

export function deleteCustomEndpoint(id: string, updatedBy: string | null): void {
  const list = readRaw();
  const next = list.filter((item) => item.id !== id);
  if (next.length === list.length) throw new Error('自定义 AI 配置不存在');
  writeAll(next, updatedBy);
  if (getActiveEndpointId() === id) {
    setActiveEndpointId(next[0]?.id || '', updatedBy ?? undefined);
  }
}

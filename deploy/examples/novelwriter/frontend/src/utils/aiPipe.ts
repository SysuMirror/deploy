/**
 * aiPipe — Standalone AI call pipeline.
 *
 * Every "AI button" across the app flows through here:
 *   1. Creates a tab in the aiLog store (auto-appears in /ai-chat).
 *   2. Calls POST /api/ai/stream with the skill-constructed message.
 *   3. Streams SSE events into the tab's messages in real time.
 *   4. Dispatches CustomEvents so the calling page can react to results.
 *
 * Usage:
 *   import { executeSkill } from '@/utils/aiPipe';
 *   await executeSkill('suggest_titles', '', { genre: [...], background: '...' }, '建议书名');
 */

import { API_URL, extractErrorMessage } from '@/api/client';
import { useAiLogStore } from '@/stores/aiLog';
import { toast } from 'vue-sonner';

// ── Helpers ──────────────────────────────────────────────────────────────────

let _id = 0;
function uid(p = 'm'): string { _id += 1; return `${p}_${Date.now()}_${_id}`; }

export interface AiPipeMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool_call' | 'tool_result' | 'action';
  content: string;
  reasoningContent: string;
  isStreaming: boolean;
  metadata: Record<string, unknown> | null;
}

export interface AiPipeTab {
  taskId: string;
  skillId: string;
  novelId: string;
  title: string;
  status: 'queued' | 'running' | 'awaiting_input' | 'completed' | 'failed';
  messages: AiPipeMessage[];
  error: string;
  sessionId: string;
  createdAt: number;
  abortController: AbortController | null;
  pendingQuestion: { question: string; options: string[] } | null;
}

function buildSkillMessage(skillId: string, params: Record<string, unknown>): string {
  if (params.message) return params.message as string;

  switch (skillId) {
    case 'suggest_titles': {
      const genre = (params.genre as string[]) || [];
      const background = (params.background as string) || '';
      const count = (params.count as number) || 5;
      let msg = `请为以下小说建议${count}个书名`;
      if (genre.length) msg += `\n- 题材：${genre.join('、')}`;
      if (background) msg += `\n- 背景设定：${background}`;
      return msg;
    }
    case 'expand_background': {
      const title = (params.title as string) || '';
      const genre = (params.genre as string[]) || [];
      const background = (params.background as string) || '';
      let msg = '请扩写以下小说的背景设定';
      if (title) msg += `\n- 书名：${title}`;
      if (genre.length) msg += `\n- 题材：${genre.join('、')}`;
      if (background) msg += `\n- 当前设定：${background}`;
      return msg;
    }
    case 'detect_ai':
      return `请检测以下文本的AI生成率：\n\n${params.content || ''}`;
    default:
      return (params.message as string) || JSON.stringify(params);
  }
}

// ── CustomEvent dispatch ─────────────────────────────────────────────────────

function dispatchAction(action: Record<string, unknown>) {
  const type = action.type as string;

  if (type === 'suggest_titles') {
    const detail = (action.params || action) as Record<string, unknown>;
    window.dispatchEvent(new CustomEvent('ai:title-selected', { detail }));
  } else if (type === 'expand_background') {
    const detail = (action.params || action) as Record<string, unknown>;
    window.dispatchEvent(new CustomEvent('ai:background-expanded', { detail }));
  } else if (type === 'create_novel') {
    window.dispatchEvent(new CustomEvent('ai:create-novel', { detail: action.params || action }));
  }

  window.dispatchEvent(new CustomEvent('ai:action', { detail: action }));
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Execute an AI skill.
 *
 * @param skillId   - Backend skill identifier (e.g. 'suggest_titles', 'free_chat', 'tool_agent')
 * @param novelId   - Novel ID (can be empty string)
 * @param params    - Skill parameters. Must include `message` for chat skills.
 * @param title     - Display title for the tab (defaults to skillId)
 * @param isAnswer  - If true, don't add a user message (continuation of existing conversation)
 * @returns taskId  - The tab's taskId for tracking
 */
export async function executeSkill(
  skillId: string,
  novelId: string,
  params: Record<string, unknown>,
  title?: string,
  isAnswer?: boolean,
): Promise<string> {
  const store = useAiLogStore();

  // ── Find or create tab ──────────────────────────────────────────────────
  const existingSessionId = params.sessionId as string | undefined;
  let taskId: string;

  if (existingSessionId && store.tabs[existingSessionId]) {
    taskId = existingSessionId;
  } else {
    taskId = `task_${Date.now()}_${uid()}`;
  }

  // Ensure tab exists
  if (!store.tabs[taskId]) {
    store.tabs[taskId] = {
      taskId,
      skillId,
      novelId,
      title: title || skillId,
      status: 'running',
      messages: [],
      error: '',
      sessionId: existingSessionId || '',
      createdAt: Date.now(),
      abortController: null,
      pendingQuestion: null,
    };
  }

  const tab = store.tabs[taskId];
  tab.status = 'running';
  tab.error = '';
  if (existingSessionId && !tab.sessionId) tab.sessionId = existingSessionId;

  store.activeTabId = taskId;

  const message = buildSkillMessage(skillId, params);

  // Add user message
  if (!isAnswer && message) {
    tab.messages.push({
      id: uid(),
      role: 'user',
      content: message,
      reasoningContent: '',
      isStreaming: false,
      metadata: null,
    });
  }

  // Add empty assistant message for streaming
  tab.messages.push({
    id: uid(),
    role: 'assistant',
    content: '',
    reasoningContent: '',
    isStreaming: true,
    metadata: null,
  });

  const ctrl = new AbortController();
  tab.abortController = ctrl;

  try {
    const token = localStorage.getItem('token') || '';
    const body: Record<string, unknown> = { message, skill: skillId };
    if (novelId) body.novelId = novelId;
    if (tab.sessionId) body.sessionId = tab.sessionId;

    const resp = await fetch(`${API_URL}/api/ai/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      credentials: 'include',
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(extractErrorMessage(err, '请求失败'));
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        if (!part.trim()) continue;
        const lines = part.split('\n');
        let eventType = '';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim();
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);
          switch (eventType) {
            case 'meta':
              if (!tab.sessionId && parsed.sessionId) {
                tab.sessionId = parsed.sessionId;
              }
              break;

            case 'reasoning': {
              const last = tab.messages[tab.messages.length - 1];
              if (last && last.role === 'assistant') {
                last.reasoningContent += (parsed.content || '');
              }
              break;
            }

            case 'tool_call':
              tab.messages.push({
                id: uid(),
                role: 'tool_call',
                content: '',
                reasoningContent: '',
                isStreaming: false,
                metadata: { toolCall: parsed },
              });
              break;

            case 'tool_result':
              tab.messages.push({
                id: uid(),
                role: 'tool_result',
                content: '',
                reasoningContent: '',
                isStreaming: false,
                metadata: { toolResult: parsed },
              });
              break;

            case 'question':
              tab.pendingQuestion = {
                question: parsed.question || '',
                options: parsed.options || [],
              };
              tab.status = 'awaiting_input';
              tab.messages.push({
                id: uid(),
                role: 'system',
                content: parsed.question || '',
                reasoningContent: '',
                isStreaming: false,
                metadata: { question: parsed },
              });
              return taskId;

            case 'action':
              dispatchAction(parsed as Record<string, unknown>);
              tab.messages.push({
                id: uid(),
                role: 'action',
                content: '',
                reasoningContent: '',
                isStreaming: false,
                metadata: { action: parsed },
              });
              break;

            case 'error':
              tab.status = 'failed';
              tab.error = parsed.message || '未知错误';
              toast.error(tab.error);
              { const last = tab.messages[tab.messages.length - 1];
              if (last) last.isStreaming = false; }
              return taskId;

            case 'done':
              tab.status = 'completed';
              { const last = tab.messages[tab.messages.length - 1];
              if (last) last.isStreaming = false; }
              if (parsed.summary) {
                tab.messages.push({
                  id: uid(),
                  role: 'system',
                  content: parsed.summary as string,
                  reasoningContent: '',
                  isStreaming: false,
                  metadata: null,
                });
              }
              return taskId;

            default: {
              const last = tab.messages[tab.messages.length - 1];
              if (last && last.role === 'assistant') {
                last.content += (parsed.content || '');
              }
            }
          }
        } catch { /* parse error */ }
      }
    }

    tab.status = 'completed';
    { const last = tab.messages[tab.messages.length - 1];
    if (last) last.isStreaming = false; }
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      tab.status = 'completed';
      tab.error = '已取消';
    } else {
      tab.status = 'failed';
      tab.error = (e as Error).message;
      toast.error(tab.error || 'AI 请求失败');
    }
    const last = tab.messages[tab.messages.length - 1];
    if (last) last.isStreaming = false;
  } finally {
    tab.abortController = null;
  }

  return taskId;
}

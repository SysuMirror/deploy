import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { API_URL } from '@/api/client';
import router from '@/router';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool_call' | 'tool_result' | 'action';
  content: string;
  reasoningContent: string;
  isStreaming: boolean;
  metadata: Record<string, unknown> | null;
}

export interface PendingQuestion {
  question: string;
  options: string[];
}

export interface AiTab {
  taskId: string;
  skillId: string;
  novelId: string;
  title: string;
  status: 'queued' | 'running' | 'awaiting_input' | 'completed' | 'failed';
  messages: AiMessage[];
  error: string;
  sessionId: string;
  createdAt: number;
  abortController: AbortController | null;
  pendingQuestion: PendingQuestion | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let _id = 0;
function uid(p = 'm'): string { _id += 1; return `${p}_${Date.now()}_${_id}`; }

function dispatchAction(action: Record<string, unknown>) {
  const type = action.type as string;
  if (type === 'navigate') {
    const route = action.route as string;
    if (route) {
      router.push(route).catch(() => { window.location.href = route; });
    }
  } else if (type === 'create_novel') {
    window.dispatchEvent(new CustomEvent('ai:create-novel', { detail: action.params || action }));
  } else if (type === 'draft_chapter') {
    const chapterId = ((action.params || action) as Record<string, unknown>).chapter_id as string;
    if (chapterId) {
      router.push(`/chapters/edit?id=${chapterId}`).catch(() => {
        window.location.href = `/chapters/edit?id=${chapterId}`;
      });
    }
  } else if (type === 'suggest_titles') {
    const titles = (action.params || action) as Record<string, unknown>;
    window.dispatchEvent(new CustomEvent('ai:title-selected', { detail: titles }));
  } else if (type === 'expand_background') {
    const bg = (action.params || action) as Record<string, unknown>;
    window.dispatchEvent(new CustomEvent('ai:background-expanded', { detail: bg }));
  }
  window.dispatchEvent(new CustomEvent('ai:action', { detail: action }));
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
      let msg = '请扩写以下背景设定';
      if (title) msg += `\n- 书名：${title}`;
      if (genre.length) msg += `\n- 题材：${genre.join('、')}`;
      if (background) msg += `\n- 当前设定：${background}`;
      return msg;
    }
    case 'detect_ai':
      return `请检测以下文本的AI生成率：\n\n${params.content || ''}`;
    default:
      return JSON.stringify(params);
  }
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useAiLogStore = defineStore('aiLog', () => {
  // ── Legacy state (for AiLogPanel backward compat) ─────────────────────
  const sessionId = ref('');
  const messages = ref<AiMessage[]>([]);
  const status = ref<'idle' | 'running' | 'awaiting' | 'done'>('idle');
  const error = ref('');
  const pendingQuestion = ref<PendingQuestion | null>(null);
  const abortController = ref<AbortController | null>(null);

  // ── Tab state ─────────────────────────────────────────────────────────
  const tabs = ref<Record<string, AiTab>>({});
  const activeTabId = ref<string | null>(null);
  const isPanelOpen = ref(false);
  const isOpen = ref(false); // legacy alias

  // ── Computed ──────────────────────────────────────────────────────────
  const isRunning = computed(() => status.value === 'running');
  const isAwaiting = computed(() => status.value === 'awaiting');
  const lastMessage = computed(() => messages.value[messages.value.length - 1] || null);
  const activeTab = computed(() => tabs.value[activeTabId.value] || null);
  const tabList = computed(() =>
    Object.values(tabs.value).sort((a, b) => b.createdAt - a.createdAt),
  );
  const runningCount = computed(() =>
    Object.values(tabs.value).filter((t) => t.status === 'running').length,
  );

  // ── Legacy message helpers ────────────────────────────────────────────

  function addMsg(role: AiMessage['role'], content: string, metadata?: Record<string, unknown>) {
    messages.value.push({
      id: uid(),
      role,
      content,
      reasoningContent: '',
      isStreaming: false,
      metadata: metadata ?? null,
    });
  }

  function appendToLast(type: string, content: string) {
    const last = lastMessage.value;
    if (!last || last.role !== 'assistant') {
      messages.value.push({
        id: uid(),
        role: 'assistant',
        content: type === 'content' ? content : '',
        reasoningContent: type === 'reasoning' ? content : '',
        isStreaming: true,
        metadata: null,
      });
      return;
    }
    if (type === 'reasoning') {
      last.reasoningContent += content;
    } else {
      last.content += content;
    }
  }

  function finishStreaming() {
    const last = lastMessage.value;
    if (last && last.isStreaming) last.isStreaming = false;
  }

  // ── Legacy SSE stream ─────────────────────────────────────────────────

  async function send(message: string) {
    if (!message.trim() || isRunning.value) return;

    // Remove pending question cards (user is answering)
    for (let i = messages.value.length - 1; i >= 0; i--) {
      if (messages.value[i].role === 'system' && messages.value[i].metadata?.question) {
        messages.value.splice(i, 1);
      }
    }

    if (!isAwaiting.value) {
      addMsg('user', message);
    }

    status.value = 'running';
    error.value = '';
    pendingQuestion.value = null;

    const ctrl = new AbortController();
    abortController.value = ctrl;

    try {
      const token = localStorage.getItem('token') || '';
      const body: Record<string, unknown> = { message };
      if (sessionId.value) body.sessionId = sessionId.value;

      const resp = await fetch(`${API_URL}/api/ai/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        credentials: 'include',
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error((err.detail as string) || '请求失败');
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
                if (!sessionId.value && parsed.sessionId) {
                  sessionId.value = parsed.sessionId;
                }
                break;

              case 'reasoning':
                appendToLast('reasoning', parsed.content || '');
                break;

              case 'tool_call':
                addMsg('tool_call', '', { toolCall: parsed });
                break;

              case 'tool_result':
                // Mark last tool_call as completed (stop spinner → show checkmark)
                for (let i = messages.value.length - 1; i >= 0; i--) {
                  if (messages.value[i].role === 'tool_call') {
                    messages.value[i].metadata = { ...messages.value[i].metadata, completed: true };
                    break;
                  }
                }
                addMsg('tool_result', '', { toolResult: parsed });
                break;

              case 'question':
                pendingQuestion.value = {
                  question: parsed.question || '',
                  options: parsed.options || [],
                };
                addMsg('system', parsed.question || '', { question: parsed });
                break;

              case 'action':
                dispatchAction(parsed as Record<string, unknown>);
                break;

              case 'error':
                error.value = parsed.message || '未知错误';
                status.value = 'done';
                finishStreaming();
                return;

              case 'done':
                if (parsed.awaitingInput) {
                  status.value = 'awaiting';
                  finishStreaming();
                  return;
                }
                status.value = 'done';
                finishStreaming();
                if (parsed.summary) {
                  addMsg('system', parsed.summary);
                }
                return;

              default:
                appendToLast('content', parsed.content || '');
            }
          } catch { /* parse error */ }
        }
      }

      status.value = 'done';
      finishStreaming();
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        error.value = '已取消';
      } else {
        error.value = (e as Error).message;
      }
      status.value = 'done';
      finishStreaming();
    } finally {
      abortController.value = null;
    }
  }

  function cancel() {
    if (abortController.value) {
      abortController.value.abort();
      abortController.value = null;
    }
    finishStreaming();
    status.value = 'done';
  }

  // ── Legacy session management ─────────────────────────────────────────

  function newSession() {
    cancel();
    sessionId.value = '';
    messages.value = [];
    status.value = 'idle';
    error.value = '';
    pendingQuestion.value = null;
  }

  async function loadSession(sid: string) {
    try {
      const token = localStorage.getItem('token') || '';
      const resp = await fetch(`${API_URL}/api/ai/sessions/${sid}/history`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      if (!resp.ok) return;
      const data = await resp.json();
      sessionId.value = sid;
      messages.value = [];
      const msgs = data.messages as Array<Record<string, unknown>>;
      if (msgs) {
        for (const m of msgs) {
          const role = m.role as AiMessage['role'];
          const extra = m.extra as Record<string, unknown> | undefined;
          let metadata: Record<string, unknown> | null = null;
          if (extra && role === 'tool_result') metadata = { toolResult: extra };
          else if (extra && role === 'tool_call') metadata = { toolCall: extra };
          addMsg(role, (m.content as string) || '', metadata || undefined);
        }
      }
      status.value = 'done';
    } catch { /* ignore */ }
  }

  async function listSessions(): Promise<Array<Record<string, unknown>>> {
    try {
      const token = localStorage.getItem('token') || '';
      const resp = await fetch(`${API_URL}/api/ai/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      if (!resp.ok) return [];
      return (await resp.json()) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  }

  async function deleteSession(sid: string): Promise<boolean> {
    try {
      const token = localStorage.getItem('token') || '';
      const resp = await fetch(`${API_URL}/api/ai/sessions/${sid}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      if (!resp.ok) return false;
      if (sessionId.value === sid) newSession();
      return true;
    } catch {
      return false;
    }
  }

  function open() { isOpen.value = true; }
  function close() { isOpen.value = false; }
  function toggle() { isOpen.value = !isOpen.value; }

  // ═══════════════════════════════════════════════════════════════════════
  // ── Tab API ───────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════

  function createTab(skillId: string, novelId: string, title?: string): string {
    const taskId = `task_${Date.now()}_${_id + 1}`;
    _id += 1;
    tabs.value[taskId] = {
      taskId,
      skillId,
      novelId,
      title: title || skillId,
      status: 'queued',
      messages: [],
      error: '',
      sessionId: '',
      createdAt: Date.now(),
      abortController: null,
      pendingQuestion: null,
    };
    return taskId;
  }

  function closeTab(taskId: string) {
    const tab = tabs.value[taskId];
    if (tab?.abortController) {
      tab.abortController.abort();
    }
    delete tabs.value[taskId];
    if (activeTabId.value === taskId) {
      const remaining = Object.keys(tabs.value);
      activeTabId.value = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
    if (Object.keys(tabs.value).length === 0) {
      isPanelOpen.value = false;
    }
  }

  function appendUserMessage(taskId: string, content: string) {
    const tab = tabs.value[taskId];
    if (!tab) return;
    tab.messages.push({
      id: uid(),
      role: 'user',
      content,
      reasoningContent: '',
      isStreaming: false,
      metadata: null,
    });
  }

  function appendAssistantMessage(taskId: string) {
    const tab = tabs.value[taskId];
    if (!tab) return;
    tab.messages.push({
      id: uid(),
      role: 'assistant',
      content: '',
      reasoningContent: '',
      isStreaming: true,
      metadata: null,
    });
  }

  function appendChunk(taskId: string, chunkType: 'content' | 'reasoning', text: string) {
    const tab = tabs.value[taskId];
    if (!tab) return;
    const msgs = tab.messages;
    if (msgs.length === 0) return;
    const last = msgs[msgs.length - 1];
    if (last.role !== 'assistant') return;
    if (chunkType === 'reasoning') {
      last.reasoningContent += text;
    } else {
      last.content += text;
    }
  }

  function finishMessage(taskId: string, finalStatus: 'completed' | 'failed', errMsg?: string) {
    const tab = tabs.value[taskId];
    if (!tab) return;
    tab.status = finalStatus;
    if (finalStatus === 'failed' && errMsg) {
      tab.error = errMsg;
    }
    const msgs = tab.messages;
    if (msgs.length > 0) {
      msgs[msgs.length - 1].isStreaming = false;
    }
  }

  function openPanel(taskId?: string) {
    if (taskId) activeTabId.value = taskId;
    isPanelOpen.value = true;
  }

  function togglePanel() {
    isPanelOpen.value = !isPanelOpen.value;
  }

  function cancelTask(taskId?: string) {
    const tid = taskId || activeTabId.value;
    if (!tid) return;
    const tab = tabs.value[tid];
    if (tab?.abortController) {
      tab.abortController.abort();
      tab.abortController = null;
    }
    finishMessage(tid, 'completed');
  }

  // ── Tab session loading ───────────────────────────────────────────────

  async function loadSessions(novelId?: string) {
    try {
      const token = localStorage.getItem('token') || '';
      let url = `${API_URL}/api/ai/sessions`;
      if (novelId) url += `?novel_id=${encodeURIComponent(novelId)}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as Array<Record<string, unknown>>;
      // Populate tabs from session list
      for (const s of data) {
        const sid = s.id as string;
        if (!tabs.value[sid]) {
          tabs.value[sid] = {
            taskId: sid,
            skillId: (s.skill_id as string) || 'tool_agent',
            novelId: (s.novel_id as string) || '',
            title: (s.title as string) || '对话',
            status: 'completed',
            messages: [],
            error: '',
            sessionId: sid,
            createdAt: new Date(s.created_at as string).getTime(),
            abortController: null,
            pendingQuestion: null,
          };
        }
      }
      return data;
    } catch {
      return [];
    }
  }

  async function loadSessionHistory(sessionId: string) {
    try {
      const token = localStorage.getItem('token') || '';
      const resp = await fetch(`${API_URL}/api/ai/sessions/${sessionId}/history`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
      if (!resp.ok) return;
      const data = await resp.json();
      const msgs = data.messages as Array<Record<string, unknown>>;
      if (!msgs) return;

      // Use existing tab or create one
      if (!tabs.value[sessionId]) {
        tabs.value[sessionId] = {
          taskId: sessionId,
          skillId: 'tool_agent',
          novelId: '',
          title: (data.session as Record<string, unknown>)?.title as string || '对话',
          status: 'completed',
          messages: [],
          error: '',
          sessionId,
          createdAt: Date.now(),
          abortController: null,
          pendingQuestion: null,
        };
      }
      const tab = tabs.value[sessionId];
      tab.messages = [];
      for (const m of msgs) {
        const role = m.role as AiMessage['role'];
        const extra = m.extra as Record<string, unknown> | undefined;
        let metadata: Record<string, unknown> | null = null;
        if (extra && role === 'tool_result') metadata = { toolResult: extra };
        else if (extra && role === 'tool_call') metadata = { toolCall: extra };
        tab.messages.push({
          id: uid(),
          role,
          content: (m.content as string) || '',
          reasoningContent: (m.reasoning_content as string) || '',
          isStreaming: false,
          metadata,
        });
      }
    } catch { /* ignore */ }
  }

  // ── WebSocket handlers ────────────────────────────────────────────────

  function handleWsChunk(data: Record<string, unknown>) {
    const taskId = data.taskId as string || data.task_id as string;
    const type = (data.type as string) || 'content';
    const content = (data.content as string) || '';
    if (!taskId) return;
    if (type === 'reasoning') {
      appendChunk(taskId, 'reasoning', content);
    } else {
      appendChunk(taskId, 'content', content);
    }
  }

  function handleWsStatus(data: Record<string, unknown>) {
    const taskId = data.taskId as string || data.task_id as string;
    const newStatus = (data.status as string) || 'completed';
    if (!taskId) return;
    const tab = tabs.value[taskId];
    if (!tab) return;
    if (newStatus === 'running') tab.status = 'running';
    else if (newStatus === 'awaiting' || newStatus === 'awaiting_input') tab.status = 'awaiting_input';
    else if (newStatus === 'failed') finishMessage(taskId, 'failed', data.error as string);
    else finishMessage(taskId, 'completed');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ── executeSkill ──────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════

  async function executeSkill(
    skillId: string,
    novelId: string,
    params: Record<string, unknown>,
    isNew: boolean,
    title?: string,
    isAnswer?: boolean,
  ): Promise<string> {
    // Determine if reusing an existing session
    const existingSessionId = params.sessionId as string | undefined;

    let taskId: string;
    let tab: AiTab;

    if (existingSessionId && tabs.value[existingSessionId]) {
      taskId = existingSessionId;
      tab = tabs.value[taskId];
      tab.status = 'running';
      tab.error = '';
    } else if (isNew || !activeTabId.value || !tabs.value[activeTabId.value]) {
      taskId = createTab(skillId, novelId, title);
      tab = tabs.value[taskId];
      tab.status = 'running';
      if (existingSessionId) tab.sessionId = existingSessionId;
    } else {
      taskId = activeTabId.value;
      tab = tabs.value[taskId];
      tab.status = 'running';
      tab.error = '';
    }

    activeTabId.value = taskId;

    const message = buildSkillMessage(skillId, params);

    // Add user message to the tab
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

    // Also update legacy state for backward compat
    status.value = 'running';
    error.value = '';

    try {
      const token = localStorage.getItem('token') || '';
      const body: Record<string, unknown> = {
        message,
        novelId: novelId || undefined,
        skill: skillId,
      };
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
        throw new Error((err.detail as string) || '请求失败');
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
                  if (!sessionId.value) sessionId.value = parsed.sessionId;
                }
                break;

              case 'reasoning':
                appendChunk(taskId, 'reasoning', parsed.content || '');
                break;

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
                finishMessage(taskId, 'failed', parsed.message || '未知错误');
                return taskId;

              case 'done':
                finishMessage(taskId, 'completed');
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

              default:
                appendChunk(taskId, 'content', parsed.content || '');
            }
          } catch { /* parse error */ }
        }
      }

      finishMessage(taskId, 'completed');
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        finishMessage(taskId, 'completed');
      } else {
        finishMessage(taskId, 'failed', (e as Error).message);
      }
    } finally {
      tab.abortController = null;
      if (status.value === 'running') status.value = 'done';
    }

    return taskId;
  }

  return {
    // Legacy state
    sessionId, messages, status, error, isOpen, pendingQuestion,
    // Legacy computed
    isRunning, isAwaiting, lastMessage,
    // Legacy actions
    send, cancel, newSession,
    loadSession, listSessions, deleteSession,
    open, close, toggle,
    // Tab state
    tabs, activeTabId, isPanelOpen,
    // Tab computed
    activeTab, tabList, runningCount,
    // Tab actions
    createTab, closeTab,
    executeSkill, cancelTask,
    openPanel, togglePanel,
    appendUserMessage, appendAssistantMessage,
    appendChunk, finishMessage,
    handleWsChunk, handleWsStatus,
    loadSessions, loadSessionHistory,
  };
});

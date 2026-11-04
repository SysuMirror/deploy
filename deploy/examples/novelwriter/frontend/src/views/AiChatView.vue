<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import {
  Bot, X, Sparkles, Plus, ChevronDown, ChevronUp,
  Loader2, Send, Square, Wrench, CheckCircle2, AlertCircle,
  PanelLeft, MessageSquare, Trash2, ArrowLeft,
  BookOpen, Lightbulb, BookMarked, GitBranch, Navigation,
  PenLine, Users, Save, Flag,
} from 'lucide-vue-next';
import { marked } from 'marked';
import { useAiLogStore } from '@/stores/aiLog';
import type { AiMessage } from '@/stores/aiLog';
import { executeSkill } from '@/utils/aiPipe';

const router = useRouter();
const store = useAiLogStore();

// ── Local state ───────────────────────────────────────────────

const composerInput = ref('');
const composerLoading = ref(false);
const showSidebar = ref(true);
const sessions = ref<Array<Record<string, unknown>>>([]);
const expandedReasoning = ref<Record<string, boolean>>({});
const messagesContainer = ref<HTMLElement | null>(null);

// ── Computed ──────────────────────────────────────────────────

const hasActive = computed(() => store.runningCount > 0);
const activeMessages = computed(() => store.activeTab?.messages || []);
const isAwaitingInput = computed(() => store.activeTab?.status === 'awaiting_input');
const pendingQuestion = computed(() => store.activeTab?.pendingQuestion);

// ── Auto-scroll to bottom ─────────────────────────────────────

watch(activeMessages, async () => {
  await nextTick();
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
}, { deep: true });

// ── Keyboard shortcuts ────────────────────────────────────────

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    router.push('/novels');
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  loadSessions();
  // Auto-focus composer
  nextTick(() => {
    const input = document.querySelector('.composer-input') as HTMLInputElement;
    input?.focus();
  });
});
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

// ── Session management ────────────────────────────────────────

async function loadSessions() {
  sessions.value = await store.loadSessions();
}

function openSession(sessionId: string) {
  store.loadSessionHistory(sessionId);
}

async function newChat() {
  store.activeTabId = null;
  composerInput.value = '';
  showSidebar.value = false;
  nextTick(() => {
    const input = document.querySelector('.composer-input') as HTMLInputElement;
    input?.focus();
  });
}

// ── Composer ──────────────────────────────────────────────────

async function sendMessage() {
  const text = composerInput.value.trim();
  if (!text || composerLoading.value) return;

  // Answer mode — agent is waiting for user response
  if (isAwaitingInput.value && store.activeTab) {
    composerInput.value = '';
    composerLoading.value = true;
    try {
      const tab = store.activeTab;
      await executeSkill(
        'tool_agent', tab.novelId,
        { message: text, sessionId: tab.sessionId },
        undefined, true,
      );
      loadSessions();
    } finally {
      composerLoading.value = false;
    }
    return;
  }

  // Normal message
  if (store.activeTab?.status === 'running') return;
  composerInput.value = '';
  composerLoading.value = true;
  try {
    const tab = store.activeTab;
    if (tab && tab.sessionId) {
      await executeSkill(
        'tool_agent', tab.novelId,
        { message: text, sessionId: tab.sessionId },
        undefined, false,
      );
    } else {
      await executeSkill('tool_agent', '', { message: text }, '新对话');
    }
    loadSessions();
  } finally {
    composerLoading.value = false;
  }
}

function selectOption(opt: string) {
  composerInput.value = opt;
  sendMessage();
}

// ── Markdown ──────────────────────────────────────────────────

function renderMd(text: string): string {
  if (!text) return '';
  return marked.parse(text, { async: false }) as string;
}

function toggleReasoning(msgId: string) {
  expandedReasoning.value[msgId] = !expandedReasoning.value[msgId];
}

// ── Tool helpers ──────────────────────────────────────────────

const toolMeta: Record<string, { icon: unknown; label: string; color: string }> = {
  create_novel: { icon: BookOpen, label: '创建小说', color: 'blue' },
  suggest_titles: { icon: Lightbulb, label: '生成书名', color: 'amber' },
  expand_background: { icon: BookMarked, label: '扩展背景', color: 'indigo' },
  generate_outline: { icon: GitBranch, label: '生成大纲', color: 'teal' },
  navigate: { icon: Navigation, label: '页面跳转', color: 'gray' },
  write_chapter_content: { icon: PenLine, label: '撰写章节', color: 'emerald' },
  generate_characters: { icon: Users, label: '生成角色', color: 'purple' },
  save_content: { icon: Save, label: '保存内容', color: 'green' },
  ask_user: { icon: MessageSquare, label: '提问', color: 'violet' },
  done: { icon: Flag, label: '完成', color: 'emerald' },
};

function tMeta(name: string) {
  return toolMeta[name] || { icon: Wrench, label: name, color: 'gray' };
}

function toolName(msg: AiMessage): string {
  return ((msg.metadata?.toolCall || msg.metadata?.toolResult) as Record<string, unknown>)?.name as string || '';
}

function toolArgs(msg: AiMessage): Record<string, unknown> {
  return ((msg.metadata?.toolCall as Record<string, unknown>)?.arguments as Record<string, unknown>) || {};
}

function toolResultData(msg: AiMessage): Record<string, unknown> {
  const tr = msg.metadata?.toolResult as Record<string, unknown>;
  return (tr?.result as Record<string, unknown>) || {};
}

function isToolError(msg: AiMessage): boolean {
  return !!((msg.metadata?.toolResult as Record<string, unknown>)?.error);
}

function toolErrorMsg(msg: AiMessage): string {
  return ((msg.metadata?.toolResult as Record<string, unknown>)?.error as string) || '';
}

function actionName(msg: AiMessage): string {
  const a = msg.metadata?.action as Record<string, unknown>;
  return (a?.type as string) || '';
}

// ── Navigation ────────────────────────────────────────────────

function navigateTo(novelId: string) {
  router.push(`/novels/detail?id=${novelId}`);
}

function goBack() {
  router.push('/novels');
}
</script>

<template>
  <div class="h-screen flex flex-col bg-background">
    <!-- Header -->
    <header class="h-12 shrink-0 border-b border-border bg-card flex items-center px-3 gap-2 z-10">
      <button
        type="button"
        class="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
        title="返回藏书阁"
        @click="goBack"
      >
        <ArrowLeft class="h-4 w-4" />
      </button>
      <button
        type="button"
        class="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
        :class="{ 'text-primary': showSidebar }"
        title="会话历史"
        @click="showSidebar = !showSidebar"
      >
        <PanelLeft class="h-4 w-4" />
      </button>
      <div class="flex items-center gap-2 flex-1 ml-1">
        <div class="flex items-center justify-center h-7 w-7 rounded-lg bg-gradient-ai text-white">
          <Sparkles class="h-3.5 w-3.5" />
        </div>
        <span class="font-semibold text-sm">{{ store.activeTab?.title || 'AI 写作助手' }}</span>
        <span v-if="hasActive" class="flex items-center gap-1 text-xs text-primary">
          <span class="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
          运行中
        </span>
      </div>
      <button
        type="button"
        class="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg hover:bg-muted transition-colors"
        @click="newChat"
      >
        <Plus class="h-3.5 w-3.5" /> 新对话
      </button>
    </header>

    <!-- Body -->
    <div class="flex-1 flex min-h-0">
      <!-- Mobile sidebar backdrop -->
      <div
        v-if="showSidebar"
        class="md:hidden fixed inset-0 z-20 bg-black/40"
        @click="showSidebar = false"
      />

      <!-- Sidebar -->
      <div
        v-if="showSidebar"
        class="fixed md:static inset-y-0 left-0 z-30 w-[min(16rem,85vw)] md:w-56 shrink-0 border-r border-border bg-card flex flex-col transition-all duration-300"
      >
        <div class="p-2.5">
          <button
            type="button"
            class="w-full flex items-center justify-center gap-2 text-xs py-2 rounded-xl btn-primary"
            @click="newChat"
          >
            <Plus class="h-3.5 w-3.5" /> 新对话
          </button>
        </div>
        <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
          <p class="text-[11px] font-medium text-muted-foreground px-2 py-1 uppercase tracking-wider">
            历史会话
          </p>
          <button
            v-for="s in sessions"
            :key="s.id as string"
            type="button"
            class="w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors flex items-center gap-2 group/session"
            :class="store.activeTab?.sessionId === s.id
              ? 'bg-primary/10 text-primary font-medium'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'"
            @click="openSession(s.id as string)"
          >
            <MessageSquare class="h-3.5 w-3.5 shrink-0 opacity-50" />
            <span class="truncate flex-1">{{ s.title || '对话' }}</span>
            <button
              type="button"
              class="opacity-0 group-hover/session:opacity-100 p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive shrink-0 transition-all"
              title="删除"
              @click.stop="store.deleteSession(s.id as string); loadSessions();"
            >
              <Trash2 class="h-3 w-3" />
            </button>
          </button>
          <p v-if="sessions.length === 0" class="text-xs text-muted-foreground px-3 py-8 text-center">
            暂无历史会话
          </p>
        </div>
      </div>

      <!-- Main chat area -->
      <div class="flex-1 flex flex-col min-w-0">
        <!-- Messages -->
        <div ref="messagesContainer" class="flex-1 overflow-y-auto">
          <!-- Empty state -->
          <div
            v-if="!store.activeTab"
            class="flex flex-col items-center justify-center h-full text-center p-8"
          >
            <div class="flex items-center justify-center h-20 w-20 rounded-3xl bg-gradient-subtle mb-6 shadow-glow">
              <Sparkles class="h-10 w-10 gradient-text-ai" />
            </div>
            <h2 class="text-xl font-bold gradient-text-ai mb-2">AI 写作助手</h2>
            <p class="text-sm text-muted-foreground max-w-md mb-8">
              输入创作需求，AI 将自动使用工具完成：创建小说、生成大纲、撰写章节、管理角色等
            </p>
            <div class="grid grid-cols-2 gap-2 max-w-sm">
              <button
                v-for="q in ['帮我创建一本玄幻修仙小说', '为我的小说生成详细大纲', '检查小说角色是否OOC', '分析这段文字的AI生成率']"
                :key="q"
                type="button"
                class="text-xs px-3 py-2 rounded-xl border border-border hover:border-primary/40 hover:bg-primary/5 text-left text-muted-foreground hover:text-foreground transition-all"
                @click="composerInput = q; sendMessage()"
              >
                {{ q }}
              </button>
            </div>
          </div>

          <!-- Message list -->
          <div v-else class="max-w-3xl mx-auto px-4 py-4 space-y-4">
            <template v-for="msg in activeMessages" :key="msg.id">
              <!-- ── User message ────────────────────────────── -->
              <div v-if="msg.role === 'user'" class="flex justify-end">
                <div class="max-w-[80%] rounded-2xl rounded-br-md px-4 py-2.5 bg-primary text-primary-foreground text-sm leading-relaxed">
                  {{ msg.content }}
                </div>
              </div>

              <!-- ── Tool call ───────────────────────────────── -->
              <div v-else-if="msg.role === 'tool_call'" class="flex items-center gap-2.5 pl-2">
                <div
                  class="flex items-center justify-center h-7 w-7 rounded-lg shrink-0"
                  :class="`bg-${tMeta(toolName(msg)).color}-100 dark:bg-${tMeta(toolName(msg)).color}-900/20 text-${tMeta(toolName(msg)).color}-600 dark:text-${tMeta(toolName(msg)).color}-400`"
                >
                  <component :is="tMeta(toolName(msg)).icon" class="h-4 w-4" />
                </div>
                <span class="text-sm font-medium">{{ tMeta(toolName(msg)).label }}</span>
                <span class="text-xs text-muted-foreground">
                  {{ toolName(msg) === 'write_chapter_content' ? (toolArgs(msg).title || toolArgs(msg).chapter_id || '章节') :
                     toolName(msg) === 'create_novel' ? (toolArgs(msg).title || '') :
                     toolName(msg) === 'ask_user' ? toolArgs(msg).question || '' :
                     toolName(msg) === 'navigate' ? toolArgs(msg).route || '' : '' }}
                </span>
                <Loader2 class="h-3 w-3 animate-spin text-muted-foreground ml-1" />
              </div>

              <!-- ── Tool result ─────────────────────────────── -->
              <div v-else-if="msg.role === 'tool_result'" class="flex items-center gap-2.5 pl-2">
                <div
                  class="flex items-center justify-center h-7 w-7 rounded-lg shrink-0"
                  :class="isToolError(msg)
                    ? 'bg-red-100 dark:bg-red-900/20 text-red-600 dark:text-red-400'
                    : `bg-${tMeta(toolName(msg)).color}-100 dark:bg-${tMeta(toolName(msg)).color}-900/20 text-${tMeta(toolName(msg)).color}-600 dark:text-${tMeta(toolName(msg)).color}-400`"
                >
                  <CheckCircle2 v-if="!isToolError(msg)" class="h-4 w-4" />
                  <AlertCircle v-else class="h-4 w-4" />
                </div>
                <span class="text-sm">{{ isToolError(msg) ? `${tMeta(toolName(msg)).label} 失败: ${toolErrorMsg(msg)}` : `${tMeta(toolName(msg)).label} 完成` }}</span>
                <!-- Action button for create_novel -->
                <button
                  v-if="toolName(msg) === 'create_novel' && toolResultData(msg).novel_id"
                  type="button"
                  class="ml-auto text-xs px-2.5 py-1 rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
                  @click="navigateTo(toolResultData(msg).novel_id as string)"
                >
                  查看小说 →
                </button>
                <!-- Action button for save_content chapter -->
                <button
                  v-if="toolName(msg) === 'save_content' && toolResultData(msg).chapter_id"
                  type="button"
                  class="ml-auto text-xs px-2.5 py-1 rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
                  @click="router.push(`/chapters/edit?id=${toolResultData(msg).chapter_id}`)"
                >
                  查看章节 →
                </button>
              </div>

              <!-- ── Action ──────────────────────────────────── -->
              <div v-else-if="msg.role === 'action'" class="flex items-center gap-2 pl-2">
                <div class="flex items-center justify-center h-6 w-6 rounded-lg bg-blue-100 dark:bg-blue-900/20 shrink-0">
                  <Navigation class="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                </div>
                <span class="text-xs text-muted-foreground">
                  {{ actionName(msg) === 'create_novel' ? '正在创建小说…' :
                     actionName(msg) === 'navigate' ? '正在跳转…' :
                     actionName(msg) === 'draft_chapter' ? '正在打开章节编辑器…' : '执行操作…' }}
                </span>
              </div>

              <!-- ── System message ──────────────────────────── -->
              <div v-else-if="msg.role === 'system'" class="flex justify-center">
                <template v-if="msg.metadata?.question">
                  <div class="rounded-2xl px-5 py-3.5 bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900/15 dark:to-purple-900/15 border border-blue-200/50 dark:border-blue-800/30 max-w-sm">
                    <p class="font-medium text-sm text-blue-700 dark:text-blue-300 mb-2.5 flex items-center gap-1.5">
                      <Sparkles class="h-4 w-4" />
                      {{ (msg.metadata.question as Record<string, unknown>).question }}
                    </p>
                    <div
                      v-if="(msg.metadata.question as Record<string, unknown>).options"
                      class="flex flex-wrap gap-1.5"
                    >
                      <button
                        v-for="opt in ((msg.metadata.question as Record<string, unknown>).options as string[])"
                        :key="opt"
                        type="button"
                        class="px-3.5 py-1.5 text-xs rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:border-primary hover:bg-primary/5 transition-all font-medium"
                        @click="selectOption(opt)"
                      >
                        {{ opt }}
                      </button>
                    </div>
                  </div>
                </template>
                <div v-else class="rounded-full px-4 py-1.5 bg-muted text-xs text-muted-foreground">
                  {{ msg.content }}
                </div>
              </div>

              <!-- ── Assistant message ───────────────────────── -->
              <div v-else class="flex flex-col max-w-[85%]">
                <!-- Reasoning -->
                <div v-if="msg.reasoningContent" class="mb-2">
                  <button
                    type="button"
                    class="flex items-center gap-1.5 text-[11px] text-violet-500 hover:text-violet-600 dark:text-violet-400 mb-1.5 transition-colors font-medium"
                    @click="toggleReasoning(msg.id)"
                  >
                    <ChevronDown v-if="!expandedReasoning[msg.id]" class="h-3 w-3" />
                    <ChevronUp v-else class="h-3 w-3" />
                    <span class="inline-block w-1 h-3 rounded-full bg-violet-400" />
                    思考过程
                  </button>
                  <div
                    v-if="expandedReasoning[msg.id]"
                    class="rounded-lg px-3 py-2 text-xs bg-violet-50/50 dark:bg-violet-950/20 text-gray-500 dark:text-gray-400 font-mono leading-relaxed whitespace-pre-wrap border-l-2 border-violet-300 dark:border-violet-700"
                  >
                    {{ msg.reasoningContent }}
                  </div>
                </div>
                <!-- Content -->
                <div v-if="msg.content" class="rounded-2xl rounded-tl-md px-4 py-2.5 bg-muted text-sm leading-relaxed">
                  <div
                    class="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0"
                    v-html="renderMd(msg.content)"
                  />
                  <span
                    v-if="msg.isStreaming"
                    class="inline-block w-2 h-4 bg-primary animate-pulse ml-0.5 align-middle rounded-sm"
                  />
                </div>
              </div>
            </template>

            <!-- Error banner -->
            <div
              v-if="store.activeTab?.status === 'failed' && store.activeTab.error && activeMessages.length === 0"
              class="rounded-lg px-4 py-3 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800 text-sm text-red-600 dark:text-red-400"
            >
              {{ store.activeTab.error }}
            </div>
          </div>
        </div>

        <!-- Composer -->
        <div class="border-t border-border bg-card p-3 shrink-0">
          <div class="max-w-3xl mx-auto">
            <!-- Quick options when question pending -->
            <div
              v-if="pendingQuestion?.options?.length"
              class="flex flex-wrap gap-2 mb-2.5"
            >
              <button
                v-for="opt in (pendingQuestion.options || [])"
                :key="opt"
                type="button"
                class="px-3.5 py-1.5 text-xs rounded-xl border border-primary/30 bg-primary/5 text-primary hover:bg-primary/15 hover:border-primary/50 transition-all font-medium"
                @click="selectOption(opt)"
              >
                {{ opt }}
              </button>
            </div>
            <form class="flex gap-2" @submit.prevent="sendMessage">
              <button
                v-if="store.activeTab?.status === 'running'"
                type="button"
                class="p-2.5 rounded-xl bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors shrink-0"
                title="停止"
                @click="store.cancelTask(store.activeTab?.taskId || '')"
              >
                <Square class="h-4 w-4" />
              </button>
              <div class="flex-1 relative">
                <input
                  v-model="composerInput"
                  class="composer-input w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all"
                  :placeholder="isAwaitingInput ? '输入你的回答…' : '告诉 AI 你想做什么…'"
                  :disabled="composerLoading"
                />
              </div>
              <button
                type="submit"
                class="p-2.5 rounded-xl btn-primary shrink-0 disabled:opacity-40 transition-all"
                :disabled="composerLoading || !composerInput.trim()"
              >
                <Loader2 v-if="composerLoading" class="h-4 w-4 animate-spin" />
                <Send v-else class="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.prose :deep(p) { margin-top: 0.25rem; margin-bottom: 0.25rem; }
.prose :deep(ul), .prose :deep(ol) { margin-top: 0.25rem; margin-bottom: 0.25rem; padding-left: 1.25rem; }
.prose :deep(pre) { margin: 0.5rem 0; border-radius: 0.5rem; font-size: 0.8rem; }
.prose :deep(code) { font-size: 0.8rem; background: rgba(0,0,0,0.05); padding: 0.1rem 0.3rem; border-radius: 0.25rem; }
.dark .prose :deep(code) { background: rgba(255,255,255,0.08); }
</style>

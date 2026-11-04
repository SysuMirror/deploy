<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue';
import {
  Bot, X, Sparkles, Plus, ChevronDown, ChevronUp,
  Loader2, Send, Square, CheckCircle2, AlertCircle,
  PanelRightOpen, PanelRightClose, MessageSquare, Trash2,
  BookOpen, Lightbulb, BookMarked, GitBranch, Navigation,
  PenLine, Users, Save, Flag, Wrench,
} from 'lucide-vue-next';
import { marked } from 'marked';
import { useAiLogStore } from '@/stores/aiLog';
import type { AiMessage } from '@/stores/aiLog';
import { useRouter } from 'vue-router';

const store = useAiLogStore();
const router = useRouter();

const input = ref('');
const loading = ref(false);
const showSidebar = ref(false);
const sessions = ref<Array<Record<string, unknown>>>([]);
const expanded = ref<Record<string, boolean>>({});
const scrollEl = ref<HTMLElement | null>(null);

// ── Auto scroll ─────────────────────────────────────────────────────

watch(() => store.messages.length, async () => {
  await nextTick();
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
});

// ── Sessions ────────────────────────────────────────────────────────

async function refreshSessions() { sessions.value = await store.listSessions(); }
onMounted(refreshSessions);

function openSession(sid: string) {
  store.loadSession(sid);
  showSidebar.value = false;
}

// ── Send ────────────────────────────────────────────────────────────

async function send() {
  const text = input.value.trim();
  if (!text || loading.value) return;
  input.value = '';
  loading.value = true;
  try {
    await store.send(text);
    refreshSessions();
  } finally {
    loading.value = false;
  }
}

function choose(opt: string) {
  input.value = opt;
  send();
}

// ── Markdown / reasoning ────────────────────────────────────────────

const TOOL_CALL_RE = /<tool_call>[\s\S]*?<\/tool_call>/g;

function md(text: string): string {
  if (!text) return '';
  // Strip any <tool_call> XML that leaked through (defense in depth)
  const clean = text.replace(TOOL_CALL_RE, '');
  if (!clean.trim()) return '';
  return marked.parse(clean, { async: false }) as string;
}
function toggleReasoning(id: string) {
  expanded.value[id] = !expanded.value[id];
}

// ── Tool meta ───────────────────────────────────────────────────────

const tMeta: Record<string, { icon: unknown; label: string }> = {
  create_novel: { icon: BookOpen, label: '创建小说' },
  suggest_titles: { icon: Lightbulb, label: '生成书名' },
  expand_background: { icon: BookMarked, label: '扩展背景' },
  generate_outline: { icon: GitBranch, label: '生成大纲' },
  write_chapter_content: { icon: PenLine, label: '撰写章节' },
  generate_characters: { icon: Users, label: '生成角色' },
  save_content: { icon: Save, label: '保存内容' },
  navigate: { icon: Navigation, label: '页面跳转' },
  ask_user: { icon: MessageSquare, label: '等待回答' },
  done: { icon: Flag, label: '完成任务' },
};

function tName(msg: AiMessage): string {
  return ((msg.metadata?.toolCall || msg.metadata?.toolResult) as Record<string, unknown>)?.name as string || '';
}
function tLabel(name: string): string { return tMeta[name]?.label || name; }
function tIcon(name: string) { return tMeta[name]?.icon || Wrench; }
function tArgs(msg: AiMessage): Record<string, unknown> {
  return ((msg.metadata?.toolCall as Record<string, unknown>)?.arguments as Record<string, unknown>) || {};
}
function tResult(msg: AiMessage): Record<string, unknown> {
  return ((msg.metadata?.toolResult as Record<string, unknown>)?.result as Record<string, unknown>) || {};
}
function tError(msg: AiMessage): string {
  return ((msg.metadata?.toolResult as Record<string, unknown>)?.error as string) || '';
}

// ── Keyboard ────────────────────────────────────────────────────────

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && store.isOpen) store.close();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
</script>

<template>
  <!-- Floating trigger -->
  <button
    v-if="!store.isOpen"
    type="button"
    class="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full px-4 py-2.5 shadow-lg transition-all duration-300 hover:scale-105"
    :class="store.isRunning ? 'btn-primary pulse-glow' : 'glass-card text-muted-foreground hover:text-foreground'"
    @click="store.open()"
  >
    <Bot class="h-4.5 w-4.5" />
    <span class="text-sm font-medium">AI 助手</span>
    <span v-if="store.isRunning" class="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
  </button>

  <!-- Panel -->
  <div
    v-else
    class="fixed bottom-4 right-4 z-50 w-[min(760px,calc(100vw-2rem))] h-[min(680px,calc(100vh-6rem))] flex flex-col rounded-2xl glass-strong shadow-xl overflow-hidden"
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0 glass">
      <div class="flex items-center gap-2">
        <div class="flex items-center justify-center h-7 w-7 rounded-lg bg-gradient-ai text-white shadow-glow">
          <Sparkles class="h-3.5 w-3.5" />
        </div>
        <span class="font-semibold text-sm gradient-text-ai">AI 写作助手</span>
        <span v-if="store.isRunning" class="flex items-center gap-1 text-xs text-primary">
          <span class="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />运行中
        </span>
      </div>
      <div class="flex items-center gap-0.5">
        <button type="button" class="p-1.5 rounded-lg hover:bg-muted transition-colors"
                @click="showSidebar = !showSidebar">
          <PanelRightOpen v-if="!showSidebar" class="h-4 w-4 text-muted-foreground" />
          <PanelRightClose v-else class="h-4 w-4 text-muted-foreground" />
        </button>
        <button type="button" class="p-1.5 rounded-lg hover:bg-muted transition-colors"
                @click="store.close()">
          <X class="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
    </div>

    <!-- Body -->
    <div class="flex-1 flex min-h-0">
      <!-- Sidebar -->
      <div v-if="showSidebar" class="w-52 shrink-0 border-r border-border glass flex flex-col">
        <div class="p-2">
          <button type="button"
                  class="w-full flex items-center justify-center gap-2 text-xs py-2 rounded-xl btn-primary"
                  @click="store.newSession(); showSidebar = false; input = ''">
            <Plus class="h-3.5 w-3.5" /> 新对话
          </button>
        </div>
        <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
          <p class="text-[11px] font-medium text-muted-foreground px-2 py-1 uppercase tracking-wider">历史会话</p>
          <button
            v-for="s in sessions" :key="s.id as string" type="button"
            class="w-full text-left px-2.5 py-2 rounded-lg text-xs truncate flex items-center gap-2 group/session transition-colors"
            :class="store.sessionId === s.id ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'"
            @click="openSession(s.id as string)"
          >
            <MessageSquare class="h-3 w-3 shrink-0 opacity-50" />
            <span class="truncate flex-1">{{ s.title || '对话' }}</span>
            <button type="button"
                    class="opacity-0 group-hover/session:opacity-100 p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive shrink-0 transition-all"
                    @click.stop="store.deleteSession(s.id as string); refreshSessions();">
              <Trash2 class="h-3 w-3" />
            </button>
          </button>
          <p v-if="sessions.length === 0" class="text-xs text-muted-foreground px-2 py-6 text-center">暂无历史会话</p>
        </div>
      </div>

      <!-- Messages -->
      <div class="flex-1 flex flex-col min-w-0 bg-card">
        <div ref="scrollEl" class="flex-1 overflow-y-auto">
          <!-- Empty state -->
          <div v-if="store.messages.length === 0 && !store.isRunning" class="flex flex-col items-center justify-center h-full text-center p-8">
            <div class="flex items-center justify-center h-16 w-16 rounded-2xl bg-gradient-subtle mb-4 shadow-glow">
              <Sparkles class="h-8 w-8 gradient-text-ai" />
            </div>
            <p class="text-sm font-semibold gradient-text-ai mb-1">AI 写作助手</p>
            <p class="text-xs text-muted-foreground max-w-xs">输入创作需求，AI 将自动使用工具完成创建小说、生成大纲、撰写章节等</p>
          </div>

          <!-- Messages -->
          <div v-else class="p-3 space-y-3">
            <template v-for="msg in store.messages" :key="msg.id">
              <!-- User -->
              <div v-if="msg.role === 'user'" class="flex justify-end">
                <div class="rounded-2xl rounded-br-md max-w-[85%] px-4 py-2.5 bg-gradient-primary text-primary-foreground text-sm leading-relaxed shadow-glow">
                  {{ msg.content }}
                </div>
              </div>

              <!-- Tool call -->
              <div v-else-if="msg.role === 'tool_call'" class="flex items-center gap-2 pl-1">
                <div class="flex items-center justify-center h-6 w-6 rounded-lg shrink-0"
                     :class="msg.metadata?.completed ? 'bg-emerald-100 dark:bg-emerald-900/20' : 'bg-muted'">
                  <CheckCircle2 v-if="msg.metadata?.completed" class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  <component :is="tIcon(tName(msg))" v-else class="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <span class="text-sm font-medium">{{ tLabel(tName(msg)) }}</span>
                <span class="text-xs text-muted-foreground truncate max-w-[200px]">
                  {{ tName(msg) === 'create_novel' ? (tArgs(msg).title || '') :
                     tName(msg) === 'write_chapter_content' ? (tArgs(msg).title || tArgs(msg).chapter_id || '') :
                     tName(msg) === 'ask_user' ? (tArgs(msg).question || '') : '' }}
                </span>
                <Loader2 v-if="!msg.metadata?.completed" class="h-3 w-3 animate-spin text-muted-foreground ml-1" />
                <CheckCircle2 v-else class="h-3 w-3 text-emerald-500 ml-1" />
              </div>

              <!-- Tool result -->
              <div v-else-if="msg.role === 'tool_result'" class="flex items-center gap-2 pl-1">
                <div class="flex items-center justify-center h-6 w-6 rounded-lg shrink-0"
                     :class="tError(msg) ? 'bg-red-100 dark:bg-red-900/20' : 'bg-emerald-100 dark:bg-emerald-900/20'">
                  <CheckCircle2 v-if="!tError(msg)" class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  <AlertCircle v-else class="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                </div>
                <span class="text-sm" :class="tError(msg) ? 'text-red-600' : ''">
                  {{ tError(msg) ? `${tLabel(tName(msg))} 失败` : `${tLabel(tName(msg))} 完成` }}
                </span>
                <!-- Novel link -->
                <button
                  v-if="tName(msg) === 'create_novel' && tResult(msg).novel_id"
                  class="ml-auto text-xs px-2.5 py-1 rounded-lg bg-primary text-primary-foreground hover:opacity-90"
                  @click="router.push(`/novels/detail?id=${tResult(msg).novel_id}`)">
                  查看小说 →
                </button>
                <!-- Chapter link -->
                <button
                  v-if="tName(msg) === 'save_content' && tResult(msg).chapter_id"
                  class="ml-auto text-xs px-2.5 py-1 rounded-lg bg-primary text-primary-foreground hover:opacity-90"
                  @click="router.push(`/chapters/edit?id=${tResult(msg).chapter_id}`)">
                  查看章节 →
                </button>
              </div>

              <!-- System / Question card -->
              <div v-else-if="msg.role === 'system'" class="flex justify-center">
                <template v-if="msg.metadata?.question">
                  <div class="rounded-xl px-4 py-3 bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900/10 dark:to-purple-900/10 border border-blue-200/50 dark:border-blue-800/30 max-w-sm">
                    <p class="font-medium text-sm text-blue-700 dark:text-blue-300 mb-2 flex items-center gap-1.5">
                      <Sparkles class="h-4 w-4" />
                      {{ (msg.metadata.question as Record<string, unknown>).question }}
                    </p>
                    <div v-if="((msg.metadata.question as Record<string, unknown>).options as string[])?.length"
                         class="flex flex-wrap gap-1.5">
                      <button
                        v-for="opt in ((msg.metadata.question as Record<string, unknown>).options as string[])" :key="opt"
                        :disabled="store.isRunning"
                        class="px-3 py-1 text-xs rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:border-primary hover:bg-primary/5 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        @click="choose(opt)">{{ opt }}</button>
                    </div>
                    <p v-else class="text-xs text-muted-foreground mt-1">请在下方输入你的回答</p>
                  </div>
                </template>
                <div v-else class="rounded-full px-4 py-1.5 bg-muted text-xs text-muted-foreground">{{ msg.content }}</div>
              </div>

              <!-- Assistant -->
              <div v-else class="flex flex-col max-w-[85%]">
                <!-- Reasoning -->
                <div v-if="msg.reasoningContent" class="mb-2">
                  <button type="button"
                          class="flex items-center gap-1.5 text-[11px] text-violet-500 hover:text-violet-600 dark:text-violet-400 mb-1.5 transition-colors font-medium"
                          @click="toggleReasoning(msg.id)">
                    <ChevronDown v-if="!expanded[msg.id]" class="h-3 w-3" />
                    <ChevronUp v-else class="h-3 w-3" />
                    <span class="inline-block w-1 h-3 rounded-full bg-violet-400" />思考过程
                  </button>
                  <div v-if="expanded[msg.id]"
                       class="rounded-lg px-3 py-2 text-xs bg-violet-50/50 dark:bg-violet-950/20 text-gray-500 dark:text-gray-400 font-mono leading-relaxed whitespace-pre-wrap border-l-2 border-violet-300 dark:border-violet-700">
                    {{ msg.reasoningContent }}
                  </div>
                </div>
                <!-- Content -->
                <div v-if="msg.content" class="rounded-2xl rounded-tl-md px-4 py-2.5 bg-muted text-sm leading-relaxed">
                  <div class="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0"
                       v-html="md(msg.content)" />
                  <span v-if="msg.isStreaming" class="inline-block w-2 h-4 bg-primary animate-pulse ml-0.5 align-middle rounded-sm" />
                </div>
              </div>
            </template>

            <!-- Error -->
            <div v-if="store.status === 'done' && store.error"
                 class="rounded-lg px-4 py-3 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800 text-sm text-red-600 dark:text-red-400">
              {{ store.error }}
            </div>
          </div>
        </div>

        <!-- Composer -->
        <div class="border-t border-border p-3 shrink-0 glass">
          <!-- Question quick options -->
          <div v-if="store.pendingQuestion?.options?.length && !store.isRunning" class="flex flex-wrap gap-2 mb-2">
            <button
              v-for="opt in (store.pendingQuestion.options || [])" :key="opt"
              class="px-3 py-1.5 text-xs rounded-xl border border-primary/30 bg-primary/5 text-primary hover:bg-primary/15 hover:border-primary/50 transition-all font-medium"
              @click="choose(opt)">{{ opt }}</button>
          </div>
          <form class="flex gap-2" @submit.prevent="send">
            <button
              v-if="store.isRunning"
              type="button"
              class="p-2 rounded-xl bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors shrink-0"
              @click="store.cancel()">
              <Square class="h-4 w-4" />
            </button>
            <input
              v-model="input"
              class="input-field"
              :placeholder="store.isAwaiting ? '输入你的回答…' : '告诉 AI 你想做什么…'"
              :disabled="loading"
            />
            <button
              type="submit"
              class="btn-primary p-2.5 shrink-0 disabled:opacity-40"
              :disabled="loading || !input.trim()">
              <Loader2 v-if="loading" class="h-4 w-4 animate-spin" />
              <Send v-else class="h-4 w-4" />
            </button>
          </form>
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

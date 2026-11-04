<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { Bot, X, Sparkles } from 'lucide-vue-next';
import { marked } from 'marked';
import { useSocketStore } from '@/stores/socket';

interface LogEntry {
  interactionId?: string;
  timestamp: string;
  type: string;
  status: 'running' | 'chunk' | 'completed' | 'failed';
  message?: string;
  chunk?: string;
  provider?: string;
  model?: string;
}

interface AIInteraction {
  interactionId: string;
  prompt: string;
  response: string;
  status: 'running' | 'completed' | 'failed';
  provider?: string;
  model?: string;
  timestamp: string;
  error?: string;
}

const socketStore = useSocketStore();
const isOpen = ref(false);
const interactions = ref<Record<string, AIInteraction>>({});
const bottomRef = ref<HTMLElement | null>(null);

const hasActive = computed(() =>
  Object.values(interactions.value).some((i) => i.status === 'running'),
);
const totalCount = computed(() => Object.keys(interactions.value).length);

function renderMd(text: string) {
  return marked.parse(text || '', { async: false }) as string;
}

function handleLog(data: unknown) {
  const entry = data as LogEntry;
  if (!entry || !entry.interactionId) return;
  const iId = entry.interactionId;
  const existing = interactions.value[iId] ?? {
    interactionId: iId,
    prompt: '',
    response: '',
    status: 'running' as const,
    provider: entry.provider,
    model: entry.model,
    timestamp: entry.timestamp,
  };
  if (entry.status === 'chunk' && entry.chunk) {
    existing.response += entry.chunk;
  } else if (entry.message) {
    existing.prompt = entry.message;
  }
  if (entry.status === 'completed' || entry.status === 'failed') {
    existing.status = entry.status;
  }
  interactions.value = { ...interactions.value, [iId]: { ...existing } };
}

onMounted(() => {
  socketStore.connect();
  socketStore.on('global:task:log', handleLog);
});

onUnmounted(() => {
  socketStore.off('global:task:log', handleLog);
});

watch(
  () => Object.keys(interactions.value).length,
  async () => {
    await nextTick();
    bottomRef.value?.scrollIntoView({ behavior: 'smooth' });
  },
);
</script>

<template>
  <button
    v-if="!isOpen"
    type="button"
    class="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-primary-foreground shadow-lg hover:opacity-90"
    @click="isOpen = true"
  >
    <Bot class="h-5 w-5" />
    <span class="text-sm font-medium">AI 日志</span>
    <span
      v-if="hasActive"
      class="ml-1 h-2 w-2 rounded-full bg-emerald-400 animate-pulse"
    />
    <span v-if="totalCount" class="text-xs opacity-80">({{ totalCount }})</span>
  </button>

  <div
    v-else
    class="fixed bottom-6 right-6 z-50 w-[min(420px,calc(100vw-2rem))] max-h-[70vh] flex flex-col rounded-2xl border border-border bg-card shadow-2xl"
  >
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <div class="flex items-center gap-2 font-semibold">
        <Sparkles class="h-4 w-4 text-primary" />
        AI 调用日志
      </div>
      <button type="button" class="p-1 rounded hover:bg-muted" @click="isOpen = false">
        <X class="h-4 w-4" />
      </button>
    </div>
    <div class="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
      <div
        v-for="item in Object.values(interactions)"
        :key="item.interactionId"
        class="rounded-lg border border-border p-3 space-y-2"
      >
        <div class="flex items-center justify-between text-xs text-muted-foreground">
          <span>{{ item.provider }} / {{ item.model }}</span>
          <span
            :class="
              item.status === 'running'
                ? 'text-blue-500'
                : item.status === 'failed'
                  ? 'text-destructive'
                  : 'text-emerald-500'
            "
          >
            {{ item.status }}
          </span>
        </div>
        <div
          v-if="item.response"
          class="prose prose-sm dark:prose-invert max-w-none"
          v-html="renderMd(item.response)"
        />
      </div>
      <div ref="bottomRef" />
      <p v-if="totalCount === 0" class="text-center text-muted-foreground py-8">暂无 AI 调用记录</p>
    </div>
  </div>
</template>

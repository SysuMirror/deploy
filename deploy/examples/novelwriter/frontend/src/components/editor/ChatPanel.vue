<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { Send, Bot, User, Loader2, ExternalLink } from 'lucide-vue-next';
import { marked } from 'marked';
import { useAiLogStore } from '@/stores/aiLog';
import { executeSkill } from '@/utils/aiPipe';
import { cn } from '@/lib/utils';

const props = defineProps<{ novelId: string; currentContent: string }>();

const aiLog = useAiLogStore();
const messages = ref<Array<{ id: string; role: 'user' | 'assistant'; content: string }>>([]);
const input = ref('');
const loading = ref(false);
const scrollRef = ref<HTMLElement | null>(null);
const activeAiTaskId = ref('');

watch(messages, async () => {
  await nextTick();
  scrollRef.value?.scrollIntoView({ behavior: 'smooth' });
}, { deep: true });

async function sendMessage(text?: string) {
  const msg = (text ?? input.value).trim();
  if (!msg || loading.value) return;
  input.value = '';
  const userId = Date.now().toString();
  const assistantId = (Date.now() + 1).toString();
  messages.value.push({ id: userId, role: 'user', content: msg });
  messages.value.push({ id: assistantId, role: 'assistant', content: '' });
  loading.value = true;

  try {
    const taskId = await executeSkill('free_chat', props.novelId, {
      message: msg,
      previousContent: props.currentContent,
      novelTitle: '',
      novelContext: '',
    }, '对话');

    activeAiTaskId.value = taskId;

    // Poll for updates from the store and apply to local messages
    const unwatch = watch(
      () => aiLog.tabs[taskId]?.messages,
      (msgs) => {
        if (!msgs) return;
        const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
        if (lastAssistant) {
          const m = messages.value.find((x) => x.id === assistantId);
          if (m) {
            m.content = lastAssistant.content;
            if (!lastAssistant.isStreaming) {
              loading.value = false;
              activeAiTaskId.value = '';
              unwatch();
            }
          }
        }
      },
      { deep: true },
    );
  } catch (e) {
    const m = messages.value.find((x) => x.id === assistantId);
    if (m) m.content = `❌ ${(e as Error).message}`;
    loading.value = false;
  }
}

function openAiPanel() {
  aiLog.openPanel(activeAiTaskId.value);
}

defineExpose({ sendMessage });
</script>

<template>
  <div class="flex flex-col h-full border-l border-border bg-card/50">
    <div class="flex-1 overflow-y-auto p-4 space-y-4">
      <div v-for="m in messages" :key="m.id" :class="cn('flex gap-2', m.role === 'user' ? 'flex-row-reverse' : '')">
        <component :is="m.role === 'user' ? User : Bot" class="h-5 w-5 shrink-0 text-primary" />
        <div
          :class="cn('rounded-lg px-3 py-2 text-sm max-w-[85%]', m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted')"
          v-html="m.role === 'assistant' ? marked.parse(m.content || '…') : m.content"
        />
      </div>
      <div ref="scrollRef" />
    </div>
    <form class="p-3 border-t flex gap-2" @submit.prevent="sendMessage()">
      <button
        v-if="activeAiTaskId"
        type="button"
        class="p-2 rounded-md border hover:bg-muted"
        title="在AI面板中查看"
        @click="openAiPanel"
      >
        <ExternalLink class="h-4 w-4" />
      </button>
      <input v-model="input" class="flex-1 border rounded-md px-3 py-2 text-sm bg-background" placeholder="向 AI 提问…" />
      <button type="submit" :disabled="loading" class="p-2 rounded-md bg-primary text-primary-foreground disabled:opacity-50">
        <Loader2 v-if="loading" class="h-4 w-4 animate-spin" />
        <Send v-else class="h-4 w-4" />
      </button>
    </form>
  </div>
</template>

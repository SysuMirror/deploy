<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue';
import { Bot, Send, Loader2, Plus, PanelLeftClose, PanelLeftOpen } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import AppShell from '@/components/layout/AppShell.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { agentAPI, agentProcessStream, agentConfirmStream } from '@/api';
import { newId } from '@/lib/utils';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  streaming?: boolean;
}

const sessionId = ref<string | null>(null);
const messages = ref<Message[]>([]);
const input = ref('');
const loading = ref(false);
const showHistory = ref(true);
const conversations = ref<Array<Record<string, unknown>>>([]);
const pendingConfirmation = ref<Record<string, unknown> | null>(null);
const messagesEnd = ref<HTMLElement | null>(null);

async function initSession() {
  try {
    const res = await agentAPI.createSession({ title: '新对话' });
    sessionId.value = res.data?.sessionId ?? res.data?.id;
    messages.value = [];
  } catch {
    toast.error('创建会话失败');
  }
}

onMounted(async () => {
  await initSession();
  try {
    const res = await agentAPI.getConversations();
    conversations.value = res.data?.conversations ?? [];
  } catch {
    /* optional */
  }
});

function addMessage(role: Message['role'], content: string, streaming = false) {
  messages.value.push({ id: newId('m'), role, content, streaming });
  nextTick(() => messagesEnd.value?.scrollIntoView({ behavior: 'smooth' }));
}

async function send() {
  if (!input.value.trim() || !sessionId.value || loading.value) return;
  const text = input.value;
  input.value = '';
  addMessage('user', text);
  loading.value = true;
  const assistantId = newId('m');
  messages.value.push({ id: assistantId, role: 'assistant', content: '', streaming: true });

  try {
    await agentProcessStream(sessionId.value, text, (event) => {
      const type = event.type as string;
      if (type === 'meta') {
        // event.data has { intent, skill } — can show what the AI decided to do
      } else if (type === 'content') {
        const chunk = (event.data as { content?: string })?.content ?? '';
        const m = messages.value.find((x) => x.id === assistantId);
        if (m) m.content += chunk;
      } else if (type === 'done') {
        const m = messages.value.find((x) => x.id === assistantId);
        if (m) m.streaming = false;
      }
    });
  } catch (e) {
    const m = messages.value.find((x) => x.id === assistantId);
    if (m) m.content = `错误: ${(e as Error).message}`;
  } finally {
    const m = messages.value.find((x) => x.id === assistantId);
    if (m) m.streaming = false;
    loading.value = false;
  }
}

async function confirmChoice(choice: string) {
  if (!sessionId.value) return;
  loading.value = true;
  try {
    await agentConfirmStream(sessionId.value, { choice }, () => {});
    pendingConfirmation.value = null;
    toast.success('已确认');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <AppShell>
    <div class="flex gap-4 h-[calc(100vh-8rem)] min-h-[500px]">
      <aside v-if="showHistory" class="w-56 shrink-0 border rounded-xl p-3 hidden md:block">
        <div class="flex justify-between items-center mb-3">
          <span class="text-sm font-medium">历史</span>
          <button @click="showHistory = false"><PanelLeftClose class="h-4 w-4" /></button>
        </div>
        <UiButton size="sm" full-width class="mb-2" @click="initSession"><Plus class="h-4 w-4 mr-1" />新对话</UiButton>
        <div v-for="c in conversations" :key="c.id as string" class="text-xs py-2 truncate text-muted-foreground">
          {{ c.title || c.sessionId }}
        </div>
      </aside>
      <button v-else class="self-start p-2 border rounded" @click="showHistory = true"><PanelLeftOpen class="h-4 w-4" /></button>

      <div class="flex-1 flex flex-col border rounded-xl overflow-hidden">
        <div class="px-4 py-3 border-b flex items-center gap-2 font-semibold">
          <Bot class="h-5 w-5 text-primary" />AI 写作助手
        </div>
        <div class="flex-1 overflow-y-auto p-4 space-y-4">
          <div
            v-for="m in messages"
            :key="m.id"
            :class="['rounded-lg px-4 py-2 text-sm max-w-[90%]', m.role === 'user' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted']"
          >
            {{ m.content }}<span v-if="m.streaming" class="animate-pulse">▌</span>
          </div>
          <div ref="messagesEnd" />
        </div>
        <div v-if="pendingConfirmation" class="mx-4 mb-2 p-3 border rounded-lg bg-amber-500/10 text-sm">
          <p>{{ pendingConfirmation.message }}</p>
          <div class="flex gap-2 mt-2">
            <UiButton size="sm" @click="confirmChoice('confirm')">确认</UiButton>
            <UiButton size="sm" variant="outline" @click="confirmChoice('cancel')">取消</UiButton>
          </div>
        </div>
        <form class="p-4 border-t flex gap-2" @submit.prevent="send">
          <input v-model="input" class="flex-1 border rounded-lg px-3 py-2 bg-background" placeholder="描述你的创作需求…" />
          <UiButton type="submit" :disabled="loading">
            <Loader2 v-if="loading" class="h-4 w-4 animate-spin" />
            <Send v-else class="h-4 w-4" />
          </UiButton>
        </form>
      </div>
    </div>
  </AppShell>
</template>

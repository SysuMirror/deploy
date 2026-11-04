<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter, RouterLink } from 'vue-router';
import { toast } from 'vue-sonner';
import { Save, ArrowLeft, Loader2, Sparkles, PanelRightOpen, PanelRightClose, ScanSearch } from 'lucide-vue-next';
import { tasksAPI, novelsAPI } from '@/api';
import ChatPanel from '@/components/editor/ChatPanel.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { executeSkill } from '@/utils/aiPipe';

const route = useRoute();
const router = useRouter();
const chapterId = computed(() => (route.query.id as string) || '');

const chapter = ref<Record<string, unknown> | null>(null);
const novel = ref<Record<string, unknown> | null>(null);
const content = ref('');
const title = ref('');
const saveStatus = ref<'saved' | 'saving' | 'unsaved' | 'error'>('saved');
const isRightOpen = ref(false);
const loading = ref(true);
const chatRef = ref<InstanceType<typeof ChatPanel> | null>(null);

let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function load() {
  if (!chapterId.value) {
    toast.error('缺少章节 ID');
    router.push('/novels');
    return;
  }
  loading.value = true;
  try {
    const chRes = await tasksAPI.getChapter(chapterId.value);
    chapter.value = chRes.data;
    content.value = (chRes.data.content as string) || '';
    title.value = (chRes.data.title as string) || '';
    const nId = chRes.data.novelId as string;
    if (nId) {
      const nRes = await novelsAPI.get(nId);
      novel.value = nRes.data;
    }
  } catch {
    toast.error('加载章节失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  // Desktop default open chat; mobile closed
  if (typeof window !== 'undefined' && window.innerWidth >= 1024) {
    isRightOpen.value = true;
  }
  load();
});
watch(chapterId, load);

function scheduleSave() {
  saveStatus.value = 'unsaved';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveChapter, 1500);
}

async function saveChapter() {
  if (!chapterId.value) return;
  saveStatus.value = 'saving';
  try {
    await tasksAPI.updateChapter(chapterId.value, { title: title.value, content: content.value });
    saveStatus.value = 'saved';
    const today = new Date().toISOString().split('T')[0];
    const key = `writing-words-${today}`;
    const existing = parseInt(localStorage.getItem(key) || '0', 10);
    localStorage.setItem(key, String(existing + content.value.length));
  } catch {
    saveStatus.value = 'error';
    toast.error('保存失败');
  }
}

async function checkOoc() {
  if (!chapterId.value) return;
  try {
    const res = await tasksAPI.checkOoc(chapterId.value, content.value);
    toast.info(typeof res.data === 'string' ? res.data : JSON.stringify(res.data));
  } catch {
    toast.error('OOC 检测失败');
  }
}

function expandSelection() {
  const sel = window.getSelection()?.toString();
  if (sel) {
    isRightOpen.value = true;
    chatRef.value?.sendMessage(`请扩写：\n\n${sel}`);
  } else toast.error('请先选中文字');
}

function detectAiRate() {
  if (!content.value.trim()) {
    toast.error('请先写入内容');
    return;
  }
  const nId = (novel.value?.id || chapter.value?.novelId || '') as string;
  executeSkill('detect_ai', nId, { content: content.value }, 'AI率检测');
}
</script>

<template>
  <div class="h-[100dvh] flex flex-col bg-background">
    <header class="border-b px-2 sm:px-4 py-2 flex items-center gap-1.5 sm:gap-3 shrink-0">
      <RouterLink
        :to="novel ? `/novels/detail?id=${novel.id}` : '/novels'"
        class="text-muted-foreground hover:text-foreground p-2"
        aria-label="返回"
      >
        <ArrowLeft class="h-5 w-5" />
      </RouterLink>
      <input
        v-model="title"
        class="flex-1 min-w-0 font-semibold bg-transparent border-none outline-none text-sm sm:text-base"
        placeholder="章节标题"
        @input="scheduleSave"
      />
      <span class="text-[10px] sm:text-xs text-muted-foreground shrink-0 hidden xs:inline">
        {{ saveStatus === 'saving' ? '保存中' : saveStatus === 'saved' ? '已保存' : saveStatus === 'error' ? '失败' : '未保存' }}
      </span>
      <UiButton size="sm" variant="outline" class="hidden sm:inline-flex" :disabled="loading" @click="checkOoc">
        <Sparkles class="h-4 w-4" />
      </UiButton>
      <UiButton size="sm" variant="outline" class="hidden sm:inline-flex" :disabled="loading" @click="detectAiRate">
        <ScanSearch class="h-4 w-4" />
      </UiButton>
      <UiButton size="sm" :disabled="loading || saveStatus === 'saving'" @click="saveChapter">
        <Save class="h-4 w-4" />
      </UiButton>
      <button type="button" class="p-2 rounded-lg hover:bg-muted" aria-label="AI 面板" @click="isRightOpen = !isRightOpen">
        <PanelRightClose v-if="isRightOpen" class="h-5 w-5" />
        <PanelRightOpen v-else class="h-5 w-5" />
      </button>
    </header>

    <div v-if="loading" class="flex-1 flex items-center justify-center">
      <Loader2 class="h-8 w-8 animate-spin text-primary" />
    </div>

    <div v-else class="flex flex-1 min-h-0 relative">
      <div class="flex-1 flex flex-col min-w-0">
        <textarea
          v-model="content"
          class="flex-1 w-full resize-none border-0 bg-transparent p-4 sm:p-6 text-base sm:text-lg leading-relaxed focus:outline-none font-serif"
          placeholder="开始写作…"
          @input="scheduleSave"
        />
        <div class="border-t px-3 sm:px-4 py-2 flex flex-wrap gap-2">
          <UiButton size="sm" variant="outline" @click="expandSelection">扩写选区</UiButton>
          <UiButton size="sm" variant="outline" class="sm:hidden" @click="checkOoc">OOC</UiButton>
          <UiButton size="sm" variant="outline" class="sm:hidden" @click="detectAiRate">AI率</UiButton>
        </div>
      </div>

      <!-- Desktop side panel -->
      <div
        v-if="isRightOpen && chapter"
        class="hidden lg:flex w-96 shrink-0 border-l"
      >
        <ChatPanel ref="chatRef" class="w-full" :novel-id="(chapter.novelId as string)" :current-content="content" />
      </div>

      <!-- Mobile / tablet overlay panel -->
      <div
        v-if="isRightOpen && chapter"
        class="lg:hidden fixed inset-0 z-40 flex flex-col bg-background"
      >
        <div class="flex items-center justify-between border-b px-3 py-2">
          <span class="font-medium text-sm">AI 对话</span>
          <button type="button" class="p-2 rounded-lg hover:bg-muted" @click="isRightOpen = false">关闭</button>
        </div>
        <ChatPanel ref="chatRef" class="flex-1 min-h-0" :novel-id="(chapter.novelId as string)" :current-content="content" />
      </div>
    </div>
  </div>
</template>

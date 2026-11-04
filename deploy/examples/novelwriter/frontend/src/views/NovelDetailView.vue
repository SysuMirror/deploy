<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter, RouterLink } from 'vue-router';
import { toast } from 'vue-sonner';
import {
  ArrowLeft, Settings, FileText, Users, Database, Sparkles, Loader2, Save, Beaker, Bookmark, Clock,
} from 'lucide-vue-next';
import UiButton from '@/components/ui/UiButton.vue';
import { novelsAPI, sandboxAPI } from '@/api';
import CharacterManager from '@/components/novel/CharacterManager.vue';
import ChapterGenerator from '@/components/novel/ChapterGenerator.vue';
import PlotThreadManager from '@/components/novel/PlotThreadManager.vue';
import TimelineManager from '@/components/novel/TimelineManager.vue';
import KnowledgeManager from '@/components/novel/KnowledgeManager.vue';

const route = useRoute();
const router = useRouter();
const novelId = computed(() => (route.query.id as string) || '');

const loading = ref(true);
const novelData = ref<Record<string, unknown> | null>(null);
const localNovel = ref<Record<string, unknown> | null>(null);
const displayNovel = computed(() => localNovel.value ?? novelData.value);

const activeTab = ref((route.query.tab as string) || 'settings');
const tabs = [
  { id: 'settings', label: '基础设定', icon: Settings },
  { id: 'outline', label: '大纲', icon: FileText },
  { id: 'chapters', label: '章节', icon: FileText },
  { id: 'characters', label: '人物卡', icon: Users },
  { id: 'threads', label: '伏笔追踪', icon: Bookmark },
  { id: 'timeline', label: '时间线', icon: Clock },
  { id: 'knowledge', label: '知识库', icon: Database },
  { id: 'style', label: '文风设定', icon: Sparkles },
  { id: 'sandbox', label: '推演沙盒', icon: Beaker },
];

watch(
  () => route.query.tab,
  (tab) => {
    if (typeof tab === 'string' && tabs.some((t) => t.id === tab)) {
      activeTab.value = tab;
    }
  },
);

const generatedOutline = ref('');
const isStreaming = ref(false);
const outlineVersions = ref<Array<Record<string, unknown>>>([]);
const styleSample = ref('');
const sandboxes = ref<Array<Record<string, unknown>>>([]);
const sandboxTitle = ref('');
const sandboxPremise = ref('');

async function loadNovel() {
  if (!novelId.value) return;
  loading.value = true;
  try {
    const res = await novelsAPI.get(novelId.value);
    novelData.value = res.data;
    localNovel.value = null;
    const versions = await novelsAPI.getOutlineVersions(novelId.value);
    outlineVersions.value = versions.data ?? [];
    if (outlineVersions.value.length) {
      generatedOutline.value = (outlineVersions.value[0].content as string) || '';
    }
    const sb = await sandboxAPI.list(novelId.value);
    sandboxes.value = sb.data?.sandboxes ?? sb.data ?? [];
  } catch {
    router.push('/novels');
  } finally {
    loading.value = false;
  }
}

onMounted(loadNovel);
watch(novelId, loadNovel);

async function saveNovel() {
  if (!displayNovel.value) return;
  try {
    await novelsAPI.update(novelId.value, localNovel.value || {});
    toast.success('已保存');
    await loadNovel();
  } catch {
    toast.error('保存失败');
  }
}

function handleGenerateOutlineStream(mode: string) {
  isStreaming.value = true;
  if (mode === 'initial') generatedOutline.value = '';
  const es = novelsAPI.generateOutlineStream(
    novelId.value,
    mode,
    mode !== 'initial' ? generatedOutline.value : undefined,
  );
  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'chunk') generatedOutline.value += data.content || '';
      else if (data.type === 'done') {
        es.close();
        isStreaming.value = false;
        novelsAPI.saveOutlineVersion(novelId.value, { content: generatedOutline.value, mode }).then(loadNovel);
        toast.success('大纲已生成');
      } else if (data.type === 'error') {
        es.close();
        isStreaming.value = false;
        toast.error(data.error || data.message || '大纲生成失败');
      }
    } catch {
      toast.error('大纲流解析失败');
      es.close();
      isStreaming.value = false;
    }
  };
  es.onerror = () => {
    if (isStreaming.value) {
      toast.error('大纲生成连接中断');
      isStreaming.value = false;
    }
    es.close();
  };
}

async function extractStyle() {
  try {
    const res = await novelsAPI.extractStyle(novelId.value, styleSample.value);
    const rules = res.data?.style ?? res.data?.writingStyleRules ?? '';
    if (localNovel.value) localNovel.value.writingStyleRules = rules;
    else if (novelData.value) novelData.value.writingStyleRules = rules;
    toast.success('文风已提取');
  } catch {
    toast.error('提取失败');
  }
}

async function createSandbox() {
  await sandboxAPI.create(novelId.value, { title: sandboxTitle.value, premise: sandboxPremise.value });
  toast.success('沙盒已创建');
  const sb = await sandboxAPI.list(novelId.value);
  sandboxes.value = sb.data?.sandboxes ?? [];
}

function patchLocal(patch: Record<string, unknown>) {
  localNovel.value = { ...(displayNovel.value || {}), ...patch };
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <header class="sticky top-0 z-40 border-b bg-background/95 backdrop-blur px-3 sm:px-4 py-3 flex items-center gap-2 sm:gap-4">
      <RouterLink to="/novels" class="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm shrink-0">
        <ArrowLeft class="h-4 w-4" /><span class="hidden sm:inline">返回</span>
      </RouterLink>
      <h1 class="font-bold truncate flex-1 text-sm sm:text-base">{{ displayNovel?.title || '加载中…' }}</h1>
      <UiButton size="sm" @click="saveNovel"><Save class="h-4 w-4 sm:mr-1" /><span class="hidden sm:inline">保存</span></UiButton>
    </header>

    <div v-if="loading" class="p-12 text-center"><Loader2 class="h-8 w-8 animate-spin mx-auto text-primary" /></div>
    <template v-else-if="displayNovel">
      <div class="border-b flex overflow-x-auto px-2 sm:px-4 gap-1 scrollbar-thin">
        <button
          v-for="t in tabs"
          :key="t.id"
          type="button"
          :class="[
            'px-3 sm:px-4 py-3 text-sm font-medium border-b-2 -mb-px whitespace-nowrap flex items-center gap-1.5 touch-manipulation',
            activeTab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground',
          ]"
          @click="activeTab = t.id"
        >
          <component :is="t.icon" class="h-4 w-4" /><span class="hidden xs:inline sm:inline">{{ t.label }}</span>
        </button>
      </div>

      <div class="container max-w-5xl mx-auto p-3 sm:p-6">
        <div v-if="activeTab === 'settings'" class="space-y-4 max-w-xl">
          <input
            :value="(displayNovel.title as string)"
            class="w-full border rounded-md px-3 py-2 text-lg font-semibold bg-background"
            @input="patchLocal({ title: ($event.target as HTMLInputElement).value })"
          />
          <textarea
            :value="(displayNovel.background as string)"
            rows="6"
            class="w-full border rounded-md px-3 py-2 bg-background"
            placeholder="背景设定"
            @input="patchLocal({ background: ($event.target as HTMLTextAreaElement).value })"
          />
        </div>

        <div v-else-if="activeTab === 'outline'" class="space-y-4">
          <div class="flex gap-2">
            <UiButton size="sm" :disabled="isStreaming" @click="handleGenerateOutlineStream('initial')">初始生成</UiButton>
            <UiButton size="sm" variant="outline" :disabled="isStreaming" @click="handleGenerateOutlineStream('continue')">续写</UiButton>
          </div>
          <textarea v-model="generatedOutline" rows="16" class="w-full border rounded-md px-3 py-2 font-mono text-sm bg-background" />
        </div>

        <ChapterGenerator
          v-else-if="activeTab === 'chapters'"
          :novel-id="novelId"
          :novel="displayNovel"
          @refresh="loadNovel"
        />

        <CharacterManager
          v-else-if="activeTab === 'characters'"
          :novel-id="novelId"
          :characters="(displayNovel.characters as Array<Record<string, unknown>>) || []"
          @update="loadNovel"
        />

        <PlotThreadManager v-else-if="activeTab === 'threads'" :novel-id="novelId" />

        <TimelineManager v-else-if="activeTab === 'timeline'" :novel-id="novelId" />

        <KnowledgeManager
          v-else-if="activeTab === 'knowledge'"
          :novel-id="novelId"
          :knowledge-bases="(displayNovel.knowledgeBases as Array<Record<string, unknown>>) || []"
          @update="loadNovel"
        />

        <div v-else-if="activeTab === 'style'" class="space-y-4 max-w-xl">
          <textarea v-model="styleSample" rows="8" class="w-full border rounded-md px-3 py-2 bg-background" placeholder="粘贴样本文风…" />
          <UiButton @click="extractStyle">提取文风规则</UiButton>
          <pre v-if="displayNovel.writingStyleRules" class="text-xs bg-muted p-4 rounded-lg overflow-auto">{{ displayNovel.writingStyleRules }}</pre>
        </div>

        <div v-else-if="activeTab === 'sandbox'" class="space-y-4">
          <div class="flex gap-2">
            <input v-model="sandboxTitle" placeholder="标题" class="border rounded-md px-3 py-2 bg-background" />
            <input v-model="sandboxPremise" placeholder="前提" class="flex-1 border rounded-md px-3 py-2 bg-background" />
            <UiButton @click="createSandbox">创建</UiButton>
          </div>
          <div v-for="s in sandboxes" :key="s.id as string" class="border rounded-lg p-4">
            <p class="font-medium">{{ s.title }}</p>
            <p class="text-sm text-muted-foreground mt-1">{{ s.premise }}</p>
          </div>
        </div>

      </div>
    </template>
  </div>
</template>

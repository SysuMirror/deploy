<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import { toast } from 'vue-sonner';
import { ArrowLeft, BookOpen, Wand2, Loader2 } from 'lucide-vue-next';
import UiButton from '@/components/ui/UiButton.vue';
import { novelsAPI } from '@/api';
import { executeSkill } from '@/utils/aiPipe';

const GENRES = ['玄幻', '奇幻', '都市', '仙侠', '科幻', '历史', '武侠'];
const STYLES = ['爽文', '热血', '轻松', '系统流', '重生', '穿越'];

const router = useRouter();
const loading = ref(false);
const form = ref({
  title: '',
  genre: [] as string[],
  style: [] as string[],
  targetWords: 200000,
  minChapterWords: 3000,
  background: '',
  worldSettings: { timeBackground: '', worldRules: [] as string[], powerSystem: '', forbiddenRules: [] as string[] },
});

function toggle(field: 'genre' | 'style', v: string) {
  const arr = form.value[field];
  form.value[field] = arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

function onTitleSelected(e: Event) {
  const title = (e as CustomEvent<{ title: string }>).detail?.title;
  if (title) {
    form.value.title = title;
    toast.success('已选择书名: ' + title);
  }
}

function onBackgroundExpanded(e: Event) {
  const bg = (e as CustomEvent<{ background: string }>).detail?.background;
  if (bg) {
    form.value.background = bg;
    toast.success('背景已更新');
  }
}

onMounted(() => {
  window.addEventListener('ai:title-selected', onTitleSelected);
  window.addEventListener('ai:background-expanded', onBackgroundExpanded);
});

onUnmounted(() => {
  window.removeEventListener('ai:title-selected', onTitleSelected);
  window.removeEventListener('ai:background-expanded', onBackgroundExpanded);
});

async function suggestTitle() {
  await executeSkill('suggest_titles', '', {
    genre: form.value.genre,
    background: form.value.background,
    count: 5,
  }, '建议书名');
}

async function expandBg() {
  await executeSkill('expand_background', '', {
    title: form.value.title,
    genre: form.value.genre,
    background: form.value.background,
  }, '扩写背景');
}

async function submit() {
  loading.value = true;
  try {
    const res = await novelsAPI.create(form.value);
    const id = res.data?.id ?? res.data;
    router.replace(`/novels/detail?id=${id}`);
  } catch {
    toast.error('创建失败');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-background pb-20">
    <header class="border-b px-6 py-4 flex items-center justify-between">
      <RouterLink to="/novels" class="flex items-center gap-2 text-muted-foreground"><ArrowLeft class="h-4 w-4" />返回</RouterLink>
      <h1 class="font-bold flex items-center gap-2"><BookOpen class="h-5 w-5 text-primary" />创建新作品</h1>
      <span class="w-16" />
    </header>

    <div class="container max-w-2xl mx-auto px-4 py-8 space-y-8">
      <div class="space-y-2">
        <h2 class="font-semibold">选择题材</h2>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="g in GENRES"
            :key="g"
            type="button"
            :class="['px-3 py-1.5 rounded-full text-sm border', form.genre.includes(g) ? 'bg-primary text-primary-foreground border-primary' : '']"
            @click="toggle('genre', g)"
          >{{ g }}</button>
        </div>
      </div>

      <div class="space-y-2">
        <h2 class="font-semibold">选择风格</h2>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="s in STYLES"
            :key="s"
            type="button"
            :class="['px-3 py-1.5 rounded-full text-sm border', form.style.includes(s) ? 'bg-primary text-primary-foreground border-primary' : '']"
            @click="toggle('style', s)"
          >{{ s }}</button>
        </div>
      </div>

      <div class="space-y-2">
        <h2 class="font-semibold">基本信息</h2>
        <div class="flex gap-2">
          <input v-model="form.title" placeholder="书名" class="flex-1 border rounded-md px-3 py-2 bg-background" />
          <UiButton variant="outline" @click="suggestTitle"><Wand2 class="h-4 w-4" /></UiButton>
        </div>
        <textarea v-model="form.background" rows="6" class="w-full border rounded-md px-3 py-2 bg-background" placeholder="背景设定" />
        <UiButton variant="outline" @click="expandBg">AI 扩写背景</UiButton>
      </div>

      <UiButton full-width :disabled="loading" @click="submit">
        <Loader2 v-if="loading" class="h-4 w-4 animate-spin mr-2" />创建作品
      </UiButton>
    </div>
  </div>
</template>

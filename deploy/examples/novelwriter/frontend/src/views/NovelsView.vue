<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import { BookOpen, Plus, Upload, Loader2, Trash2, Clock, PenLine } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import AppShell from '@/components/layout/AppShell.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { novelsAPI } from '@/api';
import { formatDate, formatNumber } from '@/lib/utils';

const novels = ref<Array<Record<string, unknown>>>([]);
const loading = ref(true);
const importing = ref(false);

async function load() {
  loading.value = true;
  try {
    const res = await novelsAPI.list();
    novels.value = res.data ?? [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function handleDelete(e: Event, id: string, title: string) {
  e.preventDefault();
  e.stopPropagation();
  if (!confirm(`确定要删除小说《${title}》吗？`)) return;
  try {
    await novelsAPI.delete(id);
    toast.success('已删除');
    await load();
  } catch {
    toast.error('删除失败');
  }
}

async function handleImport(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  importing.value = true;
  const ext = file.name.split('.').pop()?.toLowerCase();
  try {
    if (ext === 'json') {
      const text = await file.text();
      const content = JSON.parse(text);
      const init = confirm('是否使用 AI 初始化小说内容？');
      await novelsAPI.import({ ...content, initialize: init });
      toast.success('导入成功');
      await load();
    } else if (ext === 'txt' || ext === 'epub') {
      const fd = new FormData();
      fd.append('file', file);
      await novelsAPI.import(fd);
      toast.success('导入成功，AI 正在后台初始化');
      await load();
    } else {
      toast.error('不支持的文件格式');
    }
  } catch {
    toast.error('导入失败');
  } finally {
    importing.value = false;
    (e.target as HTMLInputElement).value = '';
  }
}
</script>

<template>
  <AppShell>
    <div class="page-container">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-3xl font-bold flex items-center gap-3 tracking-tight">
            <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <BookOpen class="h-6 w-6 text-primary" />
            </div>
            藏书阁
          </h1>
          <p class="text-muted-foreground mt-2 ml-[52px]">共 {{ novels.length }} 部作品</p>
        </div>
        <div class="flex gap-3">
          <label class="relative cursor-pointer">
            <input type="file" accept=".json,.txt,.epub" class="absolute inset-0 opacity-0" :disabled="importing" @change="handleImport" />
            <UiButton variant="outline" :disabled="importing" class="btn-secondary">
              <Loader2 v-if="importing" class="h-4 w-4 animate-spin" />
              <Upload v-else class="h-4 w-4" />导入小说
            </UiButton>
          </label>
          <RouterLink to="/novels/new" class="btn-primary">
            <Plus class="h-4 w-4" />创建作品
          </RouterLink>
        </div>
      </div>

      <div v-if="loading" class="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        <div v-for="i in 6" :key="i" class="h-48 rounded-2xl shimmer" />
      </div>
      <div v-else-if="!novels.length" class="rounded-2xl border-2 border-dashed border-border p-16 text-center">
        <div class="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mx-auto mb-6">
          <BookOpen class="h-8 w-8 text-primary" />
        </div>
        <p class="text-lg font-bold">藏书阁空空如也</p>
        <p class="text-muted-foreground mt-2 mb-6">创建或导入你的第一部小说</p>
        <div class="flex items-center justify-center gap-3">
          <RouterLink to="/novels/new" class="btn-primary"><Plus class="h-4 w-4" />新建作品</RouterLink>
          <label class="btn-secondary cursor-pointer">
            <Upload class="h-4 w-4" />导入小说
            <input type="file" accept=".json,.txt,.epub" class="hidden" :disabled="importing" @change="handleImport" />
          </label>
        </div>
      </div>
      <div v-else class="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        <div v-for="novel in novels" :key="novel.id as string" class="block group relative">
          <RouterLink :to="`/novels/detail?id=${novel.id}`" class="block">
            <div class="h-full rounded-2xl border border-border/50 bg-card p-6 transition-all duration-300 card-hover group-hover:border-primary/20 overflow-hidden">
              <div class="absolute top-0 right-0 w-32 h-32 bg-gradient-subtle rounded-bl-3xl opacity-50" />
              <div class="relative z-10">
                <h3 class="text-xl font-bold pr-8 tracking-tight">{{ novel.title || '未命名' }}</h3>
                <p class="text-sm text-muted-foreground line-clamp-2 mt-2.5 leading-relaxed">{{ novel.background || '暂无简介' }}</p>
                <div class="mt-5 pt-4 border-t border-border/40 flex items-center justify-between text-xs text-muted-foreground">
                  <span class="flex items-center gap-1.5"><PenLine class="h-3 w-3" />{{ formatNumber((novel.targetWords as number) || 0) }} 字</span>
                  <span class="flex items-center gap-1.5"><Clock class="h-3 w-3" />{{ formatDate(novel.updatedAt as string) }}</span>
                </div>
              </div>
            </div>
          </RouterLink>
          <button
            type="button"
            class="absolute top-4 right-4 p-2 rounded-xl opacity-0 group-hover:opacity-100 hover:bg-destructive/10 text-destructive transition-all z-10"
            @click="handleDelete($event, novel.id as string, (novel.title as string) || '')"
          >
            <Trash2 class="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  </AppShell>
</template>

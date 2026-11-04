<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { RouterLink } from 'vue-router';
import { Plus, BookOpen, ArrowRight, Clock, Sparkles, BarChart3, Library, PenLine, Bot, FileText } from 'lucide-vue-next';
import AppShell from '@/components/layout/AppShell.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { novelsAPI } from '@/api';
import { formatNumber } from '@/lib/utils';

const loading = ref(true);
const allNovels = ref<Array<Record<string, unknown>>>([]);

onMounted(async () => {
  try {
    const res = await novelsAPI.list();
    allNovels.value = res.data ?? [];
  } finally {
    loading.value = false;
  }
});

const novels = computed(() => allNovels.value.slice(0, 6));
const totalWords = computed(() =>
  allNovels.value.reduce((s, n) => s + ((n.targetWords as number) || 0), 0),
);

const shortcuts = [
  { title: '新建作品', href: '/novels/new', icon: Plus, desc: '从零开始创作', primary: true },
  { title: '藏书阁', href: '/novels', icon: BookOpen, desc: '管理全部作品' },
  { title: 'AI 助手', href: '/ai-chat', icon: Bot, desc: '智能写作辅助' },
  { title: '写作统计', href: '/stats', icon: BarChart3, desc: '查看创作数据' },
  { title: '知识库', href: '/knowledge', icon: Library, desc: '世界观与设定' },
];
</script>

<template>
  <AppShell>
    <div class="page-container">
      <section class="relative rounded-2xl overflow-hidden border border-border/50 bg-gradient-to-br from-card via-card to-primary/5 p-8 md:p-10 shadow-soft">
        <div class="absolute inset-0 bg-gradient-subtle opacity-50" />
        <div class="absolute top-0 right-0 w-72 h-72 bg-gradient-ai rounded-full blur-3xl opacity-10 -translate-y-1/2 translate-x-1/2" />
        <div class="relative z-10">
          <div class="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary mb-5">
            <Sparkles class="h-3 w-3" /> AI 多智能体协作
          </div>
          <h1 class="text-2xl md:text-3xl font-bold tracking-tight">
            <span class="gradient-text">开始创作</span>
          </h1>
          <p class="mt-3 text-muted-foreground max-w-lg text-[15px] leading-relaxed">
            从灵感到大纲、人设再到正文，多智能体协作助你完成长篇网文。AI 阅读体验审计、AI 率检测、角色 OOC 检查，全方位保障作品质量。
          </p>
          <div class="mt-6 flex flex-wrap gap-3">
            <RouterLink to="/novels/new" class="btn-primary">
              <Plus class="h-4 w-4" />新建作品
            </RouterLink>
            <RouterLink to="/novels" class="btn-secondary">
              <BookOpen class="h-4 w-4" />浏览作品
            </RouterLink>
          </div>
        </div>
      </section>

      <section>
        <h2 class="section-title mb-4">快捷入口</h2>
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <RouterLink
            v-for="s in shortcuts"
            :key="s.href"
            :to="s.href"
            :class="[
              'flex flex-col rounded-2xl border border-border/50 bg-card p-5 transition-all duration-300 card-hover',
              s.primary ? 'bg-gradient-subtle border-primary/20' : ''
            ]"
          >
            <div :class="[
              'inline-flex h-9 w-9 items-center justify-center rounded-xl mb-3',
              s.primary ? 'bg-primary text-primary-foreground shadow-glow' : 'bg-muted text-primary'
            ]">
              <component :is="s.icon" class="h-4 w-4" />
            </div>
            <span class="font-semibold text-sm">{{ s.title }}</span>
            <span class="text-xs text-muted-foreground mt-0.5">{{ s.desc }}</span>
          </RouterLink>
        </div>
      </section>

      <section v-if="!loading && allNovels.length" class="grid grid-cols-2 gap-4">
        <div class="rounded-2xl border border-border/50 bg-card px-6 py-5 shadow-soft">
          <div class="flex items-center gap-3">
            <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <BookOpen class="h-5 w-5 text-primary" />
            </div>
            <div>
              <p class="text-xs text-muted-foreground font-medium uppercase tracking-wider">作品数</p>
              <p class="mt-1 text-2xl font-bold tracking-tight">{{ allNovels.length }}</p>
            </div>
          </div>
        </div>
        <div class="rounded-2xl border border-border/50 bg-card px-6 py-5 shadow-soft">
          <div class="flex items-center gap-3">
            <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10">
              <FileText class="h-5 w-5 text-emerald-500" />
            </div>
            <div>
              <p class="text-xs text-muted-foreground font-medium uppercase tracking-wider">目标总字数</p>
              <p class="mt-1 text-2xl font-bold tracking-tight">{{ formatNumber(totalWords) }}<span class="text-sm font-normal text-muted-foreground ml-1">字</span></p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-base font-bold flex items-center gap-2.5">
            <div class="h-2 w-2 rounded-full bg-primary" />
            近期项目
          </h2>
          <RouterLink to="/novels" class="text-sm text-primary hover:underline flex items-center gap-1 font-medium transition-colors">
            查看全部 <ArrowRight class="h-3.5 w-3.5" />
          </RouterLink>
        </div>

        <div v-if="loading" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div v-for="i in 6" :key="i" class="h-44 rounded-2xl shimmer" />
        </div>
        <div v-else-if="!novels.length" class="rounded-2xl border-2 border-dashed border-border p-12 text-center">
          <div class="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 mx-auto mb-5">
            <BookOpen class="h-7 w-7 text-primary" />
          </div>
          <p class="font-semibold text-lg">暂无作品</p>
          <p class="text-muted-foreground text-sm mt-1 mb-6">创建你的第一部小说，开启创作之旅</p>
          <RouterLink to="/novels/new" class="btn-primary inline-flex">
            <Plus class="h-4 w-4" />立即创建
          </RouterLink>
        </div>
        <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <RouterLink
            v-for="novel in novels"
            :key="novel.id as string"
            :to="`/novels/detail?id=${novel.id}`"
            class="block group"
          >
            <div class="h-full rounded-2xl border border-border/50 bg-card p-5 transition-all duration-300 card-hover group-hover:border-primary/20">
              <h3 class="font-bold text-[15px] line-clamp-1 group-hover:text-primary transition-colors">{{ novel.title || '未命名' }}</h3>
              <p class="text-[13px] text-muted-foreground line-clamp-2 mt-2 leading-relaxed">{{ novel.background || '暂无简介' }}</p>
              <div class="mt-4 pt-3 border-t border-border/40 flex items-center justify-between text-xs text-muted-foreground">
                <span class="flex items-center gap-1"><PenLine class="h-3 w-3" />{{ formatNumber((novel.targetWords as number) || 0) }} 字</span>
                <span class="flex items-center gap-1"><Clock class="h-3 w-3" />{{ (novel.updatedAt as string)?.slice(0, 10) || '' }}</span>
              </div>
            </div>
          </RouterLink>
        </div>
      </section>
    </div>
  </AppShell>
</template>

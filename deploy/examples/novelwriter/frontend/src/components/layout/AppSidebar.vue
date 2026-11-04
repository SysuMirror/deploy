<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  BookOpen,
  Library,
  Sparkles,
  BarChart3,
  Bot,
} from 'lucide-vue-next';

defineProps<{ class?: string }>();

const route = useRoute();

const items = [
  { title: '概览', href: '/', icon: LayoutDashboard },
  { title: '藏书阁', href: '/novels', icon: BookOpen },
  { title: 'AI 助手', href: '/ai-chat', icon: Bot },
  { title: '写作统计', href: '/stats', icon: BarChart3 },
  { title: '知识库', href: '/knowledge', icon: Library },
  { title: '系统设置', href: '/settings', icon: Sparkles },
];
</script>

<template>
  <div :class="cn('pb-8 w-56 rounded-2xl border border-border/50 glass-card py-5', $props.class)">
    <div class="px-3">
      <h2 class="mb-3 px-3 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground/70">创作中心</h2>
      <div class="space-y-0.5">
        <RouterLink
          v-for="item in items"
          :key="item.href"
          :to="item.href"
          :class="
            cn(
              'flex items-center rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200',
              route.path === item.href
                ? 'bg-primary/10 text-primary shadow-sm'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )
          "
        >
          <component :is="item.icon" class="mr-3 h-4 w-4 shrink-0" />
          {{ item.title }}
          <span
            v-if="route.path === item.href"
            class="ml-auto h-1.5 w-1.5 rounded-full bg-primary"
          />
        </RouterLink>
      </div>
    </div>
  </div>
</template>

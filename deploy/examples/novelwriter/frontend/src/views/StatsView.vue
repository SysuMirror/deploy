<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { BarChart3 } from 'lucide-vue-next';
import AppShell from '@/components/layout/AppShell.vue';
import UiCard from '@/components/ui/UiCard.vue';
import { novelsAPI } from '@/api';
import { formatNumber } from '@/lib/utils';

const novels = ref<Array<Record<string, unknown>>>([]);
const dailyGoal = ref(3000);

const todayKey = computed(() => `writing-words-${new Date().toISOString().split('T')[0]}`);
const todayWords = computed(() => parseInt(localStorage.getItem(todayKey.value) || '0', 10));

onMounted(async () => {
  const goal = localStorage.getItem('daily-word-goal');
  if (goal) dailyGoal.value = parseInt(goal, 10);
  const res = await novelsAPI.list();
  novels.value = res.data ?? [];
});

function saveGoal() {
  localStorage.setItem('daily-word-goal', String(dailyGoal.value));
}
</script>

<template>
  <AppShell>
    <h1 class="text-2xl font-bold flex items-center gap-2 mb-8"><BarChart3 class="h-6 w-6 text-primary" />写作统计</h1>
    <div class="grid gap-4 sm:grid-cols-3 mb-8">
      <UiCard class="p-5">
        <p class="text-xs text-muted-foreground uppercase">今日字数</p>
        <p class="text-2xl font-bold mt-1">{{ formatNumber(todayWords) }}</p>
      </UiCard>
      <UiCard class="p-5">
        <p class="text-xs text-muted-foreground uppercase">日更目标</p>
        <input v-model.number="dailyGoal" type="number" class="mt-2 w-full border rounded-md px-2 py-1 bg-background" @change="saveGoal" />
      </UiCard>
      <UiCard class="p-5">
        <p class="text-xs text-muted-foreground uppercase">作品数</p>
        <p class="text-2xl font-bold mt-1">{{ novels.length }}</p>
      </UiCard>
    </div>
    <UiCard v-for="n in novels" :key="n.id as string" class="p-4 mb-3">
      <p class="font-semibold">{{ n.title }}</p>
      <p class="text-sm text-muted-foreground">目标 {{ formatNumber((n.targetWords as number) || 0) }} 字</p>
    </UiCard>
  </AppShell>
</template>

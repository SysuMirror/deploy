<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import { Library } from 'lucide-vue-next';
import AppShell from '@/components/layout/AppShell.vue';
import UiCard from '@/components/ui/UiCard.vue';
import { knowledgeAPI } from '@/api';

const items = ref<Array<Record<string, unknown>>>([]);

onMounted(async () => {
  const res = await knowledgeAPI.listAll();
  items.value = res.data ?? [];
});
</script>

<template>
  <AppShell>
    <h1 class="text-2xl font-bold flex items-center gap-2 mb-8"><Library class="h-6 w-6 text-primary" />知识库中心</h1>
    <div class="grid gap-4 md:grid-cols-2">
      <RouterLink
        v-for="kb in items"
        :key="`${kb.novelId}-${kb.id}`"
        :to="`/novels/detail?id=${kb.novelId}&tab=knowledge`"
        class="block"
      >
        <UiCard class="p-5 hover:border-primary/40 transition-colors">
          <p class="font-semibold">{{ kb.name }}</p>
          <p class="text-sm text-muted-foreground mt-1">{{ kb.description || '无描述' }}</p>
        </UiCard>
      </RouterLink>
    </div>
    <p v-if="!items.length" class="text-center text-muted-foreground py-12">暂无知识库，请在作品详情中创建</p>
  </AppShell>
</template>

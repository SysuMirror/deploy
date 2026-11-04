<script setup lang="ts">
import { useRoute } from 'vue-router';
import { RouterLink } from 'vue-router';

const route = useRoute();
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-8 text-center">
    <div>
      <p class="text-muted-foreground mb-4">旧版编辑页已弃用，请使用章节编辑器。</p>
      <RouterLink
        v-if="route.query.chapterId"
        :to="`/chapters/edit?id=${route.query.chapterId}`"
        class="text-primary hover:underline"
      >前往章节编辑</RouterLink>
    </div>
  </div>
</template>

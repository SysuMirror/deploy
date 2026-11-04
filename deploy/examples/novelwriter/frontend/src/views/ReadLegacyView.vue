<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';
const route = useRoute();
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-8 text-center">
    <p class="text-muted-foreground mb-4">阅读模式占位页，请从章节列表进入编辑/阅读。</p>
    <RouterLink v-if="route.query.chapterId" :to="`/chapters/edit?id=${route.query.chapterId}`" class="text-primary">打开章节</RouterLink>
  </div>
</template>

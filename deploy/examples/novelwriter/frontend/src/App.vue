<script setup lang="ts">
import { Toaster } from 'vue-sonner';
import AiLogPanel from '@/components/layout/AiLogPanel.vue';
import NavigationProgress from '@/components/layout/NavigationProgress.vue';
import { useAiActions } from '@/composables/useAiActions';

useAiActions();
</script>

<template>
  <div class="bg-background text-foreground selection:bg-primary/20 selection:text-foreground min-h-screen">
    <RouterView />
    <NavigationProgress />
    <AiLogPanel />
    <Toaster position="top-center" rich-colors />
  </div>
</template>

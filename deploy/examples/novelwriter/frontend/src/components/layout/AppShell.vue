<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Menu, X } from 'lucide-vue-next';
import AppHeader from './AppHeader.vue';
import AppSidebar from './AppSidebar.vue';

const route = useRoute();
const mobileNavOpen = ref(false);

watch(
  () => route.fullPath,
  () => {
    mobileNavOpen.value = false;
  },
);
</script>

<template>
  <div class="min-h-screen bg-background flex flex-col">
    <AppHeader>
      <template #leading>
        <button
          type="button"
          class="lg:hidden p-2 -ml-1 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="打开菜单"
          @click="mobileNavOpen = true"
        >
          <Menu class="h-5 w-5" />
        </button>
      </template>
    </AppHeader>

    <!-- Mobile drawer -->
    <div
      v-if="mobileNavOpen"
      class="fixed inset-0 z-50 lg:hidden"
    >
      <div class="absolute inset-0 bg-black/40" @click="mobileNavOpen = false" />
      <aside class="absolute left-0 top-0 bottom-0 w-[min(18rem,85vw)] bg-background border-r shadow-xl p-4 flex flex-col animate-fade-in">
        <div class="flex items-center justify-between mb-4">
          <span class="font-semibold text-sm">导航</span>
          <button type="button" class="p-2 rounded-lg hover:bg-muted" aria-label="关闭" @click="mobileNavOpen = false">
            <X class="h-5 w-5" />
          </button>
        </div>
        <AppSidebar class="w-full border-0 shadow-none bg-transparent" />
      </aside>
    </div>

    <div class="flex flex-1 w-full max-w-6xl mx-auto px-3 sm:px-4 md:px-6 py-5 sm:py-8 gap-8">
      <AppSidebar class="hidden lg:block w-56 shrink-0 sticky top-20 self-start" />
      <main class="flex-1 min-w-0 animate-fade-in">
        <slot />
      </main>
    </div>
  </div>
</template>

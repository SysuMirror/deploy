<script setup lang="ts">
import { useDark, useToggle } from '@vueuse/core';
import { Moon, Sun } from 'lucide-vue-next';

const isDark = useDark();
const toggle = useToggle(isDark);
</script>

<template>
  <button
    type="button"
    class="relative p-2 rounded-full hover:bg-muted transition-colors"
    aria-label="切换主题"
    @click="toggle()"
  >
    <Sun class="h-5 w-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0 text-amber-500" />
    <Moon class="absolute top-2 left-2 h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100 text-primary" />
  </button>
</template>

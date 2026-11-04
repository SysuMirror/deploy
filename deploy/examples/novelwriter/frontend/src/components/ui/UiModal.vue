<script setup lang="ts">
defineProps<{
  open: boolean;
  title: string;
  size?: 'sm' | 'md' | 'lg';
}>();
defineEmits<{ close: [] }>();

const widthClass = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg' };
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" @click.self="$emit('close')">
    <div :class="['bg-card rounded-xl border shadow-xl w-full p-6', widthClass[size || 'md']]">
      <h3 class="text-lg font-semibold mb-4">{{ title }}</h3>
      <slot />
    </div>
  </div>
</template>

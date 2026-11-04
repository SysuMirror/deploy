<script setup lang="ts">
import { cn } from '@/lib/utils';
defineProps<{ modelValue?: string; type?: string; placeholder?: string; class?: string }>();
defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <input
    :type="type || 'text'"
    :value="modelValue"
    :placeholder="placeholder"
    :class="cn(
      'flex h-11 w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm',
      'placeholder:text-muted-foreground/50',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary/40',
      'transition-all duration-200',
      class
    )"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>

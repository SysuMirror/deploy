<script setup lang="ts">
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
    size?: 'default' | 'sm' | 'lg' | 'icon';
    fullWidth?: boolean;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
  }>(),
  { variant: 'default', size: 'default', type: 'button' },
);

const variants: Record<string, string> = {
  default: 'bg-gradient-primary text-primary-foreground shadow-glow hover:shadow-glow-lg hover:-translate-y-0.5',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  outline: 'border border-border bg-card hover:bg-muted/60 hover:border-primary/30',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  link: 'text-primary underline-offset-4 hover:underline',
};

const sizes: Record<string, string> = {
  default: 'h-11 px-5 py-2.5',
  sm: 'h-9 rounded-lg px-3 text-xs',
  lg: 'h-12 rounded-xl px-8 text-base',
  icon: 'h-10 w-10 rounded-xl',
};
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    :class="
      cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]',
        fullWidth ? 'flex w-full' : '',
        variants[variant],
        sizes[size],
        $attrs.class as string,
      )
    "
  >
    <slot />
  </button>
</template>

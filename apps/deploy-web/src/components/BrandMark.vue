<script setup lang="ts">
import { BRAND } from '@/config/brand';

withDefaults(
  defineProps<{
    size?: number;
    showWordmark?: boolean;
  }>(),
  { size: 28, showWordmark: false }
);
</script>

<template>
  <span class="brand-mark" :style="{ '--bm-size': `${size}px` }">
    <img v-if="BRAND.logo" :src="BRAND.logo" alt="" class="brand-mark__img" />
    <span v-else class="brand-mark__fallback" aria-hidden="true">
      <span class="brand-mark__glyph">S</span>
    </span>
    <span v-if="showWordmark" class="brand-mark__name">{{ BRAND.name }}</span>
  </span>
</template>

<style scoped>
.brand-mark {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
}
.brand-mark__img {
  width: var(--bm-size);
  height: var(--bm-size);
  border-radius: 8px;
  object-fit: cover;
  border: 1px solid var(--deploy-border);
}
.brand-mark__fallback {
  width: var(--bm-size);
  height: var(--bm-size);
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: linear-gradient(145deg, #38bdf8 0%, #0284c7 100%);
  border: 1px solid rgba(2, 132, 199, 0.35);
}
.brand-mark__glyph {
  font-weight: 800;
  font-size: calc(var(--bm-size) * 0.48);
  color: #fff;
  line-height: 1;
  font-family: var(--deploy-font);
}
.brand-mark__name {
  font-weight: 750;
  font-size: 0.98rem;
  letter-spacing: -0.03em;
  color: inherit;
}
</style>

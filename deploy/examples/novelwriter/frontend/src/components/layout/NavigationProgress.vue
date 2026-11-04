<script setup lang="ts">
import { watch } from 'vue';
import { useRoute } from 'vue-router';
import NProgress from 'nprogress';
import 'nprogress/nprogress.css';

NProgress.configure({ showSpinner: false });

const route = useRoute();
watch(
  () => route.path,
  () => {
    NProgress.start();
    requestAnimationFrame(() => NProgress.done());
  },
);
</script>

<template>
  <span class="hidden" />
</template>

<style>
#nprogress .bar {
  background: hsl(var(--primary)) !important;
  height: 2px;
}
</style>

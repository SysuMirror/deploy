<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import ThemeToggle from '@/components/ui/ThemeToggle.vue';
import { authAPI } from '@/api';

const router = useRouter();
const loggedIn = ref(false);
const userName = ref('');

function checkAuth() {
  const token = localStorage.getItem('token');
  loggedIn.value = !!token;
  if (token) {
    authAPI.me().then(r => {
      userName.value = (r.data as { name?: string }).name || '';
    }).catch(() => {});
  }
}

onMounted(checkAuth);

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('userId');
  loggedIn.value = false;
  userName.value = '';
  router.push('/login');
}
</script>

<template>
  <header class="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-2xl supports-[backdrop-filter]:bg-background/60">
    <div class="flex h-14 items-center gap-2 sm:gap-4 px-3 sm:px-4 md:px-6">
      <slot name="leading" />
      <RouterLink to="/" class="flex items-center gap-2 sm:gap-3 text-foreground no-underline group min-w-0">
        <div class="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-ai shadow-glow group-hover:shadow-glow-lg transition-shadow duration-300 shrink-0">
          <img src="/logo.svg" alt="Logo" width="22" height="22" class="relative z-10" />
        </div>
        <span class="hidden font-bold xs:inline-block sm:inline-block text-base tracking-tight truncate">
          <span class="gradient-text-ai">SECoding</span> Novel
        </span>
      </RouterLink>
      <div class="flex-1" />
      <nav class="hidden md:flex items-center gap-1">
        <RouterLink to="/" class="px-3 py-1.5 text-sm rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors">概览</RouterLink>
        <RouterLink to="/novels" class="px-3 py-1.5 text-sm rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors">藏书阁</RouterLink>
        <RouterLink to="/ai-chat" class="px-3 py-1.5 text-sm rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors">AI 助手</RouterLink>
      </nav>
      <div class="h-5 w-px bg-border/60 hidden md:block" />
      <ThemeToggle />
      <template v-if="loggedIn">
        <RouterLink to="/settings" class="text-sm text-muted-foreground hover:text-foreground transition-colors ml-1 max-w-[5rem] truncate">{{ userName || '用户' }}</RouterLink>
        <button type="button" class="text-xs text-muted-foreground hover:text-destructive transition-colors ml-1 sm:ml-2" @click="logout">退出</button>
      </template>
      <template v-else>
        <RouterLink to="/login" class="text-sm text-muted-foreground hover:text-foreground transition-colors">登录</RouterLink>
        <RouterLink to="/register" class="btn-primary text-xs !px-3 !py-1.5 ml-1">注册</RouterLink>
      </template>
    </div>
  </header>
</template>

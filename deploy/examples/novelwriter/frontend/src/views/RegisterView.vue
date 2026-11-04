<script setup lang="ts">
import { ref } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import { authAPI } from '@/api';
import { BookOpen } from 'lucide-vue-next';

const router = useRouter();
const email = ref('');
const password = ref('');
const name = ref('');
const loading = ref(false);
const error = ref('');

async function handleSubmit() {
  loading.value = true;
  error.value = '';
  try {
    const res = await authAPI.register({ email: email.value, password: password.value, name: name.value });
    const data = res.data as { token?: string };
    if (data.token) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('userId', (data as { user?: { id?: string } }).user?.id || '');
      router.push('/');
    } else {
      router.push('/login');
    }
  } catch (e: unknown) {
    error.value = (e as { response?: { data?: { message?: string } } })?.response?.data?.message || '注册失败';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-background p-4">
    <div class="w-full max-w-md">
      <div class="text-center mb-8">
        <RouterLink to="/" class="inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-gradient-ai shadow-glow mb-5">
          <BookOpen class="h-7 w-7 text-white" />
        </RouterLink>
        <h1 class="text-2xl font-bold tracking-tight">创建账号</h1>
        <p class="text-muted-foreground text-sm mt-1.5">加入 SECoding Novel 开始创作</p>
      </div>

      <div class="rounded-2xl border border-border/50 glass-card p-8 shadow-soft-lg">
        <div v-if="error" class="mb-5 p-3 rounded-xl text-sm bg-destructive/10 text-destructive border border-destructive/20 flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full bg-destructive shrink-0" />{{ error }}
        </div>
        <form class="space-y-4" @submit.prevent="handleSubmit">
          <div>
            <label class="block text-sm font-medium mb-1.5">昵称</label>
            <input v-model="name" type="text" class="input-field" placeholder="笔名/昵称" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1.5">邮箱</label>
            <input v-model="email" type="email" required class="input-field" placeholder="your@email.com" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1.5">密码</label>
            <input v-model="password" type="password" required class="input-field" placeholder="至少 6 位密码" minlength="6" />
          </div>
          <button type="submit" :disabled="loading" class="btn-primary w-full mt-2">
            {{ loading ? '注册中...' : '立即注册' }}
          </button>
        </form>
      </div>

      <p class="text-center text-sm text-muted-foreground mt-6">
        已有账号？<RouterLink to="/login" class="text-primary hover:underline font-medium ml-1">前往登录</RouterLink>
      </p>
    </div>
  </div>
</template>

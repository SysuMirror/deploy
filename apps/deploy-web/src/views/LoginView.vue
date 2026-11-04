<script setup lang="ts">
import BrandMark from '@/components/BrandMark.vue';
import { BRAND } from '@/config/brand';
import { useLoginFlow } from '@/composables/auth/useLoginFlow';

const { error, loading, email, password, submit } = useLoginFlow();
</script>

<template>
  <div class="login-page">
    <div class="login-page__glow" aria-hidden="true" />
    <div class="login-card">
      <div class="login-card__brand">
        <BrandMark :size="44" show-wordmark />
      </div>
      <p class="login-card__tagline">{{ BRAND.tagline }}</p>
      <p class="login-card__space">部署控制台</p>

      <form class="login-card__form" @submit.prevent="submit">
        <label class="login-card__field">
          <span class="login-card__label">邮箱</span>
          <input
            v-model.trim="email"
            class="login-card__input"
            type="email"
            name="email"
            autocomplete="username"
            placeholder="you@example.com"
            required
          />
        </label>
        <label class="login-card__field">
          <span class="login-card__label">密码</span>
          <input
            v-model="password"
            class="login-card__input"
            type="password"
            name="password"
            autocomplete="current-password"
            placeholder="账号密码"
            required
          />
        </label>
        <button class="login-card__action" type="submit" :disabled="loading">
          {{ loading ? '登录中…' : '登录' }}
        </button>
      </form>

      <p v-if="error" class="login-card__error" role="alert">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  position: relative;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem 1.25rem;
  overflow: hidden;
  background:
    radial-gradient(1200px 600px at 10% -10%, #dbeafe 0%, transparent 55%),
    radial-gradient(900px 500px at 100% 0%, #e0f2fe 0%, transparent 50%),
    linear-gradient(180deg, #f8fafc 0%, #eef2f6 100%);
}
.login-page__glow {
  position: absolute;
  inset: auto 20% -20% 20%;
  height: 40%;
  background: radial-gradient(ellipse at center, rgba(14, 165, 233, 0.12), transparent 70%);
  pointer-events: none;
}
.login-card {
  position: relative;
  width: 100%;
  max-width: 24rem;
  padding: 2.25rem 1.75rem;
  text-align: center;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 16px;
  box-shadow: 0 20px 50px -24px rgba(15, 23, 42, 0.25);
}
.login-card__brand {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 0.75rem;
}
.login-card__tagline {
  margin: 0;
  font-size: 0.875rem;
  color: var(--deploy-fg-secondary);
}
.login-card__space {
  margin: 6px 0 1.25rem;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--deploy-muted-fg);
}
.login-card__form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}
.login-card__field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  text-align: left;
}
.login-card__label {
  font-size: 0.8125rem;
  color: var(--deploy-fg-secondary);
}
.login-card__input {
  width: 100%;
  padding: 0.65rem 0.85rem;
  font-size: 0.9375rem;
  color: var(--deploy-fg, #0f172a);
  background: #fff;
  border: 1px solid rgba(203, 213, 225, 0.9);
  border-radius: 10px;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.login-card__input:focus {
  border-color: #0ea5e9;
  box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.16);
}
.login-card__action {
  width: 100%;
  margin-top: 0.25rem;
  padding: 0.7rem 1rem;
  font-size: 0.9375rem;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, #0ea5e9, #2563eb);
  border: none;
  border-radius: 10px;
  cursor: pointer;
  box-shadow: 0 10px 24px -10px rgba(14, 165, 233, 0.6);
  transition: filter 0.15s ease, box-shadow 0.15s ease;
}
.login-card__action:hover:not(:disabled) {
  filter: brightness(1.05);
  box-shadow: 0 14px 28px -10px rgba(14, 165, 233, 0.7);
}
.login-card__action:disabled {
  opacity: 0.7;
  cursor: wait;
}
.login-card__error {
  margin: 1rem 0 0;
  font-size: 0.875rem;
  line-height: 1.5;
  color: #b91c1c;
}
</style>

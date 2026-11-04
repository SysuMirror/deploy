<script setup lang="ts">
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useRouter } from 'vue-router';

const props = withDefaults(
  defineProps<{ workspace?: string }>(),
  { workspace: '控制台' }
);

const auth = useAuthStore();
const ui = useUiStore();
const router = useRouter();

function logout() {
  auth.logout();
  // 用命名路由跳转：在子路径部署（如 /sdpy/）下，字符串 '/login' 会被当作站点根的绝对路径，
  // 无法匹配 base 下的路由，导致点退出后停在原页。命名路由会按 history base 解析成正确地址。
  router.replace({ name: 'login', query: { reason: 'logout' } });
}
</script>

<template>
  <header class="deploy-header">
    <div class="deploy-header__left">
      <button
        type="button"
        class="deploy-header__menu"
        aria-label="打开菜单"
        @click="ui.toggleSidebar()"
      >
        ☰
      </button>
      <span class="deploy-header__ws">{{ props.workspace }}</span>
    </div>
    <div v-if="auth.user" class="deploy-header__right">
      <span class="deploy-header__user">{{ auth.user.name }}</span>
      <button type="button" class="deploy-header__logout" @click="logout">退出</button>
    </div>
  </header>
</template>

<style scoped>
.deploy-header {
  height: var(--deploy-header-h);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 28px;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--deploy-border);
  position: sticky;
  top: 0;
  z-index: 30;
}
.deploy-header__left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.deploy-header__ws {
  font-size: 13px;
  font-weight: 650;
  color: var(--deploy-fg-secondary);
  letter-spacing: 0.02em;
}
.deploy-header__menu {
  display: none;
  border: 1px solid var(--deploy-border);
  background: #fff;
  border-radius: 8px;
  width: 40px;
  height: 40px;
  font-size: 18px;
  cursor: pointer;
  color: var(--deploy-fg);
  font-family: inherit;
}
.deploy-header__right {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
}
.deploy-header__user {
  color: var(--deploy-fg-secondary);
  font-weight: 500;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.deploy-header__logout {
  border: 1px solid var(--deploy-border);
  background: #fff;
  color: var(--deploy-fg-secondary);
  cursor: pointer;
  font-size: 13px;
  padding: 5px 12px;
  border-radius: 8px;
  font-family: inherit;
}
.deploy-header__logout:hover {
  border-color: #bae6fd;
  background: var(--deploy-accent-soft);
  color: var(--deploy-primary);
}

@media (max-width: 768px) {
  .deploy-header {
    padding: 0 14px;
  }
  .deploy-header__menu {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .deploy-header__user {
    max-width: 96px;
    font-size: 13px;
  }
}
</style>

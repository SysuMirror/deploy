<script setup lang="ts">
import { computed, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import { BRAND } from '@/config/brand';
import { useUiStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';

const props = withDefaults(
  defineProps<{ variant?: 'console' | 'admin' }>(),
  { variant: 'console' }
);

const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const auth = useAuthStore();

type NavItem = { path: string; label: string; match?: string };

const consoleItems = computed<NavItem[]>(() => {
  const list: NavItem[] = [
    { path: '/projects', label: '项目', match: '/projects' },
    // 监控中心：三个子视图（访问日志/总览图表/进程管理）在页内标签切换，侧边栏只留一个入口
    { path: '/monitor', label: '监控中心', match: '/monitor' },
    // 脚本部署：非部署台应用（宿主机脚本的网页下发执行）
    { path: '/scripts', label: '脚本部署', match: '/scripts' },
    { path: '/oa', label: 'OA 审批', match: '/oa' },
    { path: '/applications', label: '我的申请', match: '/applications' },
  ];
  if (auth.user?.isPlatformAdmin) {
    list.push({ path: '/admin/approvals', label: '进入管理台', match: '/admin' });
  }
  return list;
});

const adminItems = computed<NavItem[]>(() => [
  { path: '/admin/approvals', label: '审批', match: '/admin/approvals' },
  { path: '/admin/containers', label: '容器', match: '/admin/containers' },
  { path: '/admin/images', label: '镜像', match: '/admin/images' },
  { path: '/admin/volumes', label: '数据卷', match: '/admin/volumes' },
  { path: '/admin/networks', label: '网络', match: '/admin/networks' },
  { path: '/admin/audit', label: '审计', match: '/admin/audit' },
  { path: '/admin/system', label: '系统', match: '/admin/system' },
  { path: '/admin/admins', label: '管理员', match: '/admin/admins' },
  { path: '/admin/recovery', label: '数据恢复', match: '/admin/recovery' },
  { path: '/projects', label: '← 返回控制台', match: '/projects' },
]);

const items = computed(() =>
  props.variant === 'admin' ? adminItems.value : consoleItems.value
);

function isActive(item: NavItem) {
  const m = item.match || item.path;
  if (m === '/projects') {
    return (
      route.path === '/projects' ||
      route.path.startsWith('/projects/') ||
      route.path.startsWith('/modules/')
    );
  }
  if (m === '/admin') return route.path.startsWith('/admin');
  return route.path === m || route.path.startsWith(m + '/');
}

function go(path: string) {
  router.push(path);
  ui.closeSidebar();
}

function syncBodyScroll(open: boolean) {
  const mobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
  document.body.style.overflow = open && mobile ? 'hidden' : '';
}

watch(
  () => route.fullPath,
  () => ui.closeSidebar()
);

watch(
  () => ui.sidebarOpen,
  (open) => syncBodyScroll(open),
  { immediate: true }
);

onUnmounted(() => {
  document.body.style.overflow = '';
});
</script>

<template>
  <div
    class="sidebar-backdrop"
    :class="{ 'sidebar-backdrop--open': ui.sidebarOpen }"
    aria-hidden="true"
    @click="ui.closeSidebar()"
  />
  <aside
    class="deploy-sidebar"
    :class="{
      'deploy-sidebar--open': ui.sidebarOpen,
      'deploy-sidebar--admin': variant === 'admin',
    }"
  >
    <div class="deploy-sidebar__brand">
      <BrandMark :size="28" />
      <div class="deploy-sidebar__titles">
        <span class="deploy-sidebar__name">{{ BRAND.name }}</span>
        <span class="deploy-sidebar__space">
          {{ variant === 'admin' ? '管理台' : '控制台' }}
        </span>
      </div>
      <button type="button" class="deploy-sidebar__close" aria-label="关闭菜单" @click="ui.closeSidebar()">
        ×
      </button>
    </div>

    <nav class="deploy-sidebar__nav" :aria-label="variant === 'admin' ? '管理导航' : '控制台导航'">
      <button
        v-for="item in items"
        :key="item.path"
        type="button"
        class="deploy-sidebar__item"
        :class="{ 'deploy-sidebar__item--active': isActive(item) }"
        @click="go(item.path)"
      >
        {{ item.label }}
      </button>
    </nav>
  </aside>
</template>

<style scoped>
.sidebar-backdrop {
  display: none;
}
.deploy-sidebar {
  width: var(--deploy-sidebar-w);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 18px 12px;
  background: #fff;
  border-right: 1px solid var(--deploy-border);
  position: relative;
  z-index: 40;
}
.deploy-sidebar--admin {
  background: #0f172a;
  border-right-color: #1e293b;
  color: #e2e8f0;
}
.deploy-sidebar__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px 18px;
  margin-bottom: 4px;
}
.deploy-sidebar__titles {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.deploy-sidebar__name {
  font-weight: 700;
  font-size: 14px;
  letter-spacing: -0.02em;
  color: var(--deploy-fg);
}
.deploy-sidebar--admin .deploy-sidebar__name {
  color: #f8fafc;
}
.deploy-sidebar__space {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--deploy-muted-fg);
}
.deploy-sidebar--admin .deploy-sidebar__space {
  color: #94a3b8;
}
.deploy-sidebar__close {
  display: none;
  border: none;
  background: transparent;
  font-size: 22px;
  line-height: 1;
  color: var(--deploy-fg-secondary);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 8px;
}
.deploy-sidebar__nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.deploy-sidebar__item {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 40px;
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--deploy-fg-secondary);
  font-size: 14px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition: background 0.15s var(--deploy-ease), color 0.15s var(--deploy-ease);
}
.deploy-sidebar--admin .deploy-sidebar__item {
  color: #94a3b8;
}
.deploy-sidebar__item:hover {
  background: var(--deploy-muted);
  color: var(--deploy-fg);
}
.deploy-sidebar--admin .deploy-sidebar__item:hover {
  background: #1e293b;
  color: #f1f5f9;
}
.deploy-sidebar__item--active {
  background: var(--deploy-accent-soft);
  color: var(--deploy-primary);
  font-weight: 650;
}
.deploy-sidebar--admin .deploy-sidebar__item--active {
  background: #1e3a5f;
  color: #7dd3fc;
}
.deploy-sidebar__item--active::before {
  content: '';
  position: absolute;
  left: -12px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: 3px;
  background: var(--deploy-primary);
}
.deploy-sidebar--admin .deploy-sidebar__item--active::before {
  background: #38bdf8;
}

@media (max-width: 768px) {
  .sidebar-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.45);
    z-index: 80;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 0.2s var(--deploy-ease), visibility 0.2s;
  }
  .sidebar-backdrop--open {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
  }
  .deploy-sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: min(var(--deploy-sidebar-w), 86vw);
    z-index: 90;
    transform: translateX(-105%);
    transition: transform 0.22s var(--deploy-ease);
    pointer-events: none;
    padding-top: max(16px, env(safe-area-inset-top));
  }
  .deploy-sidebar--open {
    transform: translateX(0);
    box-shadow: var(--deploy-shadow-lg);
    pointer-events: auto;
  }
  .deploy-sidebar__close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 40px;
    min-height: 40px;
  }
  .deploy-sidebar__item {
    min-height: 44px;
    font-size: 15px;
  }
}
</style>

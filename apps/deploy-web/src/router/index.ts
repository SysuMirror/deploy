import { createRouter, createWebHistory } from 'vue-router';
import { getToken } from '@/services/api';
import { isPublicPath } from '@/composables/auth/oauth-guard';
import { saveLoginRedirect } from '@/composables/auth/oauth-redirect';
import { useAuthStore } from '@/stores/auth';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      redirect: '/projects',
    },
    {
      path: '/',
      component: () => import('@/layouts/DeployLayout.vue'),
      children: [
        {
          path: 'projects',
          name: 'projects',
          component: () => import('@/views/ProjectsView.vue'),
        },
        {
          path: 'projects/:projectId',
          name: 'project',
          component: () => import('@/views/ProjectDetailView.vue'),
        },
        {
          path: 'projects/:projectId/members',
          name: 'project-members',
          component: () => import('@/views/ProjectMembersView.vue'),
        },
        {
          path: 'modules/:moduleId',
          name: 'module',
          component: () => import('@/views/ModuleDetailView.vue'),
        },
        {
          path: 'modules/:moduleId/object-storage',
          name: 'module-object-storage',
          component: () => import('@/views/ModuleObjectStorageView.vue'),
        },
        {
          path: 'modules/:moduleId/deployments/:deploymentId',
          name: 'deployment-logs',
          component: () => import('@/views/DeploymentLogView.vue'),
        },
        {
          path: 'applications',
          name: 'applications',
          component: () => import('@/views/ApplicationsView.vue'),
        },
        {
          path: 'monitor',
          redirect: { name: 'monitor-logs' },
        },
        {
          path: 'monitor/logs',
          name: 'monitor-logs',
          component: () => import('@/views/MonitorLogView.vue'),
        },
        {
          path: 'monitor/overview',
          name: 'monitor-overview',
          component: () => import('@/views/MonitorOverviewView.vue'),
        },
        {
          path: 'monitor/proc',
          name: 'monitor-proc',
          component: () => import('@/views/ProcessView.vue'),
        },
        {
          path: 'scripts',
          name: 'scripts',
          component: () => import('@/views/ScriptsView.vue'),
        },
        {
          path: 'scripts/:appId',
          name: 'script-app',
          component: () => import('@/views/ScriptAppDetailView.vue'),
        },
        {
          path: 'oa',
          name: 'oa',
          component: () => import('@/views/OaView.vue'),
        },
        {
          path: 'developer-gate',
          name: 'developer-gate',
          component: () => import('@/views/DeveloperGateView.vue'),
        },
      ],
    },
    {
      path: '/admin',
      component: () => import('@/layouts/AdminLayout.vue'),
      meta: { requiresAdmin: true },
      children: [
        { path: '', redirect: { name: 'admin-tab', params: { tab: 'approvals' } } },
        {
          path: ':tab',
          name: 'admin-tab',
          component: () => import('@/views/AdminView.vue'),
          props: true,
        },
      ],
    },
  ],
});

router.beforeEach(async (to) => {
  // 门禁页只展示申请入口，不依赖登录态
  if (to.name === 'developer-gate') return true;
  const auth = useAuthStore();
  const redirectTarget = () =>
    typeof to.query.redirect === 'string' && to.query.redirect
      ? to.query.redirect
      : { name: 'projects' };

  // 登录页：无论有无本地会话都先复核共享 Cookie，单点登出后刷新不再“假登录”
  if (to.name === 'login') {
    const r = await auth.revalidateSso();
    if (r === 'not-developer') return { name: 'developer-gate' };
    if (getToken() && r !== 'invalid') return redirectTarget();
    return true;
  }

  if (isPublicPath(to.path) || to.meta.public) return true;

  // 有本地会话也复核一次：其它平台单点登出后这里刷新即回登录页；
  // 503/网络（unavailable）则保留本地会话。
  const r = await auth.revalidateSso();
  if (r === 'not-developer') return { name: 'developer-gate' };
  if (!getToken()) {
    saveLoginRedirect(to.fullPath);
    return { name: 'login', query: { redirect: to.fullPath } };
  }

  if (to.matched.some((x) => x.meta.requiresAdmin)) {
    if (!auth.user) {
      try {
        const ok = await auth.restoreSession();
        if (ok === 'not-developer') {
          return { name: 'developer-gate' };
        }
      } catch {
        /* ignore */
      }
    }
    if (!auth.user?.isPlatformAdmin) {
      return { path: '/projects' };
    }
  }
  return true;
});

export default router;

import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: () => import('@/views/HomeView.vue') },
    { path: '/novels', name: 'novels', component: () => import('@/views/NovelsView.vue') },
    { path: '/novels/new', name: 'novel-new', component: () => import('@/views/NovelNewView.vue') },
    { path: '/novels/detail', name: 'novel-detail', component: () => import('@/views/NovelDetailView.vue') },
    { path: '/chapters/edit', name: 'chapter-edit', component: () => import('@/views/ChapterEditView.vue') },
    { path: '/ai-chat', name: 'ai-chat', component: () => import('@/views/AiChatView.vue') },
    { path: '/agent', redirect: '/ai-chat' },
    { path: '/stats', name: 'stats', component: () => import('@/views/StatsView.vue') },
    { path: '/knowledge', name: 'knowledge', component: () => import('@/views/KnowledgeView.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
    { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue') },
    { path: '/register', name: 'register', component: () => import('@/views/RegisterView.vue') },
    { path: '/forgot-password', redirect: '/' },
    { path: '/reset-password', redirect: '/' },
    { path: '/edit', name: 'edit-legacy', component: () => import('@/views/EditLegacyView.vue') },
    { path: '/read', name: 'read-legacy', component: () => import('@/views/ReadLegacyView.vue') },
  ],
  scrollBehavior() {
    return { top: 0 };
  },
});

const publicRoutes = ['/login', '/register'];

router.beforeEach((to, _from, next) => {
  const token = localStorage.getItem('token');
  if (!token && !publicRoutes.includes(to.path)) {
    next('/login');
  } else if (token && publicRoutes.includes(to.path)) {
    next('/');
  } else {
    next();
  }
});

export default router;

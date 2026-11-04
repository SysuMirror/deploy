import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { Project } from '@/services/api';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/auth';

export type DevGateInfo = {
  configured: boolean;
  checked: boolean;
  isDeveloper: boolean;
  isAdmin: boolean;
  name?: string;
  effective?: boolean;
  joinUrl: string;
  platformUrl: string;
};

export const useDeployStore = defineStore('deploy', () => {
  const projects = ref<Project[]>([]);
  const baseDomain = ref('ssemarket.cn');
  const publicBasePath = ref('/');
  const rootMode = ref(true);
  const agentFixerEnabled = ref(false);
  const gateRequired = ref(false);
  const dev = ref<DevGateInfo | null>(null);
  const loading = ref(false);

  async function bootstrap() {
    loading.value = true;
    try {
      const data = await api.getBootstrap();
      projects.value = data.projects;
      baseDomain.value = data.baseDomain;
      publicBasePath.value = data.publicBasePath || '/';
      rootMode.value = Boolean(data.rootMode);
      agentFixerEnabled.value = Boolean(data.agentFixerEnabled);
      gateRequired.value = Boolean(data.gateRequired);
      dev.value = data.dev ?? null;
      if (data.user?.isPlatformAdmin != null) {
        const auth = useAuthStore();
        if (auth.user) {
          auth.user = { ...auth.user, isPlatformAdmin: data.user.isPlatformAdmin };
        }
      }
    } finally {
      loading.value = false;
    }
  }

  function moduleUrl(
    name: string,
    env: 'test' | 'prod',
    kind: 'web' | 'api' = 'web',
    pathMode?: string
  ) {
    // 仅子域名模式：prod=名称.域名 / test=test.名称.域名
    if (pathMode === 'domain') {
      return env === 'test'
        ? `https://test.${name}.${baseDomain.value}`
        : `https://${name}.${baseDomain.value}`;
    }
    const base =
      pathMode === 'root'
        ? ''
        : pathMode === 'subpath'
          ? '/sdpy'
          : publicBasePath.value === '/'
            ? ''
            : publicBasePath.value.replace(/\/$/, '');
    const suffix = kind === 'api' ? `${name}-api` : name;
    const path =
      env === 'test' ? `${base}/test/${suffix}` : `${base}/${suffix}`;
    return `https://${baseDomain.value}${path}`;
  }

  function reset() {
    projects.value = [];
  }

  return {
    projects,
    baseDomain,
    publicBasePath,
    rootMode,
    agentFixerEnabled,
    gateRequired,
    dev,
    loading,
    bootstrap,
    moduleUrl,
    reset,
  };
});

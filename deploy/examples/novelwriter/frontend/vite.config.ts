import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

const backendDevOrigin = process.env.BACKEND_DEV_PROXY_URL || 'http://localhost:8002';

function normalizeBase(raw: string | undefined): string {
  const v = (raw ?? '/').trim() || '/';
  if (v === '/') return '/';
  const withSlash = v.startsWith('/') ? v : `/${v}`;
  return withSlash.endsWith('/') ? withSlash : `${withSlash}/`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // 平台部署时传入 SDPY_PUBLIC_BASE=/sdpy/test/{module}，避免资源请求打到站点根路径返回 HTML
  const base = normalizeBase(process.env.VITE_BASE_PATH || env.VITE_BASE_PATH || '/');
  return {
    base,
    plugins: [vue()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 8001,
      proxy: {
        '/api': {
          target: backendDevOrigin,
          changeOrigin: true,
        },
        '/ws': {
          target: backendDevOrigin,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['vue', 'vue-router', 'pinia'],
            flow: ['@vue-flow/core'],
          },
        },
      },
    },
    define: {
      'import.meta.env.VITE_API_URL': JSON.stringify(env.VITE_API_URL ?? ''),
    },
  };
});

import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const outDir = mode === 'production.deploy' ? 'dist-deploy' : 'dist';

  return {
    base: env.VITE_BASE_PATH || '/',
    plugins: [vue()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        // 源码包存在且已构建时优先用 dist（源码按 UI 库自身的 tsconfig 编译，
        // 直接进本应用的 strict vue-tsc 会报隐式 any）；否则退回源码别名
        '@sse/ui/style.css': resolve(__dirname, '../../../packages/sse-ui/dist/style.css'),
        '@sse/ui': resolve(__dirname, '../../../packages/sse-ui/dist/sse-ui.js'),
      },
    },
    build: {
      outDir,
      rollupOptions: {
        // mermaid 由 @sse/ui 动态 import 且缺失时降级；本应用不内置 mermaid
        external: ['mermaid'],
      },
    },
    server: {
      port: 5174,
      open: true,
      fs: {
        allow: [resolve(__dirname, '../../..'), resolve(__dirname, '../../../packages')],
      },
      proxy: {
        '/api': {
          target: 'http://localhost:3002',
          changeOrigin: true,
        },
      },
    },
  };
});

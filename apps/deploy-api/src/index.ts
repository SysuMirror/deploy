import express from 'express';
import cors from 'cors';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { initSchema } from './db/init.js';
import { ensureBootstrapAdmins } from './services/platform-admin.js';
import { recoverStaleDeployments } from './services/deploy-worker.js';
import authRoutes from './routes/auth.js';
import projectsRoutes from './routes/projects.js';
import modulesRoutes from './routes/modules.js';
import deploymentsRoutes from './routes/deployments.js';
import webhookRoutes from './routes/webhooks.js';
import bootstrapRoutes from './routes/bootstrap.js';
import adminRoutes from './routes/admin.js';
import templatesRoutes from './routes/templates.js';
import monitorRoutes from './routes/monitor.js';
import processRoutes from './routes/process.js';
import scriptsRoutes from './routes/scripts.js';
import { cleanupOrphanContainers } from './services/script-runner.js';
import { markStaleRunsInterrupted } from './services/script-apps.js';
import devRoutes from './routes/dev.js';
import { startAccessLogCollector } from './services/access-log.js';
import { startCpuDaemon } from './services/process-manager.js';
import { oauthConfig } from './config/oauth.js';
import { getGatewayModulesPath, getGatewayHostsPath, regenerateNginxRoutes } from './services/routing.js';
import { getPublicBasePath } from './config/paths.js';

const PORT = Number(process.env.PORT) || 3002;
const __dirname = dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production';
const staticDir = process.env.STATIC_DIR
  ? resolve(process.env.STATIC_DIR)
  : isProduction
    ? resolve(__dirname, '../public')
    : null;

initSchema();
ensureBootstrapAdmins();
recoverStaleDeployments();
try {
  const modulesConf = getGatewayModulesPath();
  mkdirSync(dirname(modulesConf), { recursive: true });
  if (!existsSync(modulesConf)) {
    writeFileSync(modulesConf, '# SSE Deploy modules — awaiting first deploy\n', 'utf8');
  }
  const hostsConf = getGatewayHostsPath();
  if (!existsSync(hostsConf)) {
    writeFileSync(hostsConf, '# SSE Deploy host servers — awaiting domain bind\n', 'utf8');
  }
  regenerateNginxRoutes();
} catch (e) {
  console.warn('初始化网关路由失败:', e instanceof Error ? e.message : e);
}

const app = express();
app.set('trust proxy', 1);

const corsOrigins = process.env.CORS_ORIGIN?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (corsOrigins?.length) {
  app.use(cors({ origin: corsOrigins }));
} else if (!isProduction) {
  app.use(cors({ origin: ['http://localhost:5174', 'http://127.0.0.1:5174'] }));
}

// webhook 需要原始 body 做签名校验，必须先于全局 json 解析挂载
app.use('/api/webhooks', webhookRoutes);
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'deploy-api' });
});

app.use('/api/auth', authRoutes);
app.use('/api/v1/projects', projectsRoutes);
app.use('/api/v1/modules', modulesRoutes);
app.use('/api/v1/deployments', deploymentsRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/templates', templatesRoutes);
app.use('/api/v1/monitor', monitorRoutes);
app.use('/api/v1/proc', processRoutes);
app.use('/api/v1/scripts', scriptsRoutes);
app.use('/api/v1/dev', devRoutes);
app.use('/api', bootstrapRoutes);

if (staticDir && existsSync(staticDir)) {
  app.use(express.static(staticDir, { index: false }));
  app.get(/^(?!\/api\/).*/, (_req, res, next) => {
    const indexHtml = join(staticDir, 'index.html');
    if (!existsSync(indexHtml)) {
      next();
      return;
    }
    res.sendFile(indexHtml);
  });
}

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`SSE Deploy API at http://localhost:${PORT}`);

  // 脚本执行是「宿主机进程 + 宿主上的 docker 容器」，进程重启后不会自己收摊：
  // 1) 上次被杀时正在跑的辅助容器要清掉，否则一直挂在宿主上
  // 2) 库里遗留的 running 记录不可能再有结果，标记为中断
  cleanupOrphanContainers();
  const stale = markStaleRunsInterrupted();
  if (stale > 0) console.log(`[scripts] 已将 ${stale} 条遗留执行记录标记为中断`);

  console.log(`PUBLIC_BASE_PATH=${getPublicBasePath() || '/'} (rootMode=${getPublicBasePath() === ''})`);
  if (staticDir && existsSync(staticDir)) {
    console.log(`Static web: ${staticDir}`);
  }
  console.log(`UniSSO issuer=${oauthConfig.issuer} (password verify)`);
  startAccessLogCollector();
  startCpuDaemon();
});

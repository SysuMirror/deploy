import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  canReadModule,
  canWriteModule,
  createDeployment,
  createMigrateDeployment,
  createPromoteDeployment,
  createRollbackDeployment,
  getDeployment,
  getModule,
  getModuleGitSource,
  listDeployments,
  resolvePackageForDeploy,
} from '../services/project.js';
import { cancelDeployment, enqueueDeployment } from '../services/deploy-worker.js';
import { validateDeployEnv } from '../services/release.js';
import { isPlatformAdmin } from '../services/platform-admin.js';
import { isSseinfraRuntime } from '../services/sseinfra-client.js';
import { getModuleLegacyStatus } from '../services/legacy-migrate.js';
import { getPackageDeployShStatus } from '../services/deploy-sh-status.js';
import { isLlmConfigured } from '../services/llm.js';
import { hasDeploySh } from '../services/package-store.js';

const router = Router();

function needAgentPayload(modId: string, packageVersion?: string) {
  const st = getPackageDeployShStatus(modId, packageVersion);
  return {
    error: st.message,
    code: 'NEED_AGENT_DEPLOY_SH' as const,
    llmReady: st.llmReady,
    hasDeploySh: st.hasDeploySh,
  };
}

router.post('/modules/:moduleId/deployments', authMiddleware, (req, res) => {
  const mod = getModule(req.params.moduleId);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权部署' });
    return;
  }

  const { env, noCache, packageVersion, source, branch, useAgentFixer, confirmAgentGenerate } =
    req.body as {
      env?: string;
      noCache?: boolean;
      packageVersion?: string;
      source?: 'package' | 'git';
      branch?: string;
      useAgentFixer?: boolean;
      confirmAgentGenerate?: boolean;
    };

  let deployEnv: 'test' | 'prod';
  try {
    deployEnv = validateDeployEnv(env);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '环境无效' });
    return;
  }

  const resolvedSource: 'package' | 'git' =
    source === 'package' ? 'package' : source === 'git' ? 'git' : isSseinfraRuntime() ? 'git' : 'package';

  try {
    if (resolvedSource === 'package' && isSseinfraRuntime()) {
      const pkg = resolvePackageForDeploy(mod.id, packageVersion?.trim() || undefined);
      if (!hasDeploySh(pkg.packagePath) && !confirmAgentGenerate) {
        res.status(409).json(needAgentPayload(mod.id, packageVersion?.trim()));
        return;
      }
      if (!hasDeploySh(pkg.packagePath) && confirmAgentGenerate && !isLlmConfigured()) {
        res.status(400).json({
          error: '未配置 AI/vLLM，无法自动生成 deploy.sh',
          code: 'LLM_NOT_READY',
        });
        return;
      }
    }

    const deployment = createDeployment(mod.id, req.user!.id, {
      env: deployEnv,
      noCache: Boolean(noCache),
      packageVersion: packageVersion?.trim() || undefined,
      source: resolvedSource,
      branch: branch?.trim() || undefined,
      useAgentFixer: Boolean(useAgentFixer),
      confirmAgentGenerate: Boolean(confirmAgentGenerate),
    });
    enqueueDeployment(deployment.id);
    res.status(201).json({ deployment });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '创建部署失败' });
  }
});

/** 压缩包 deploy.sh 状态（部署/迁移前预检） */
router.get('/modules/:moduleId/deploy-sh-status', authMiddleware, (req, res) => {
  const mod = getModule(req.params.moduleId);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canReadModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权查看' });
    return;
  }
  const packageVersion =
    typeof req.query.packageVersion === 'string' ? req.query.packageVersion : undefined;
  res.json({ status: getPackageDeployShStatus(mod.id, packageVersion) });
});

/** 一键：测试环境当前包 → 正式环境 */
router.post('/modules/:moduleId/promote', authMiddleware, (req, res) => {
  const mod = getModule(req.params.moduleId);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权部署' });
    return;
  }

  const { noCache } = req.body as { noCache?: boolean };

  try {
    const deployment = createPromoteDeployment(mod.id, req.user!.id, Boolean(noCache));
    enqueueDeployment(deployment.id);
    res.status(201).json({ deployment });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '晋升失败' });
  }
});

/** 回滚：重发指定环境上一条成功部署 */
router.post('/modules/:moduleId/rollback', authMiddleware, (req, res) => {
  const mod = getModule(req.params.moduleId);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权部署' });
    return;
  }

  const { env, sourceDeploymentId } = req.body as { env?: string; sourceDeploymentId?: string };
  try {
    const deployment = createRollbackDeployment(mod.id, req.user!.id, env ?? 'test', {
      sourceDeploymentId: sourceDeploymentId?.trim() || undefined,
    });
    enqueueDeployment(deployment.id);
    res.status(201).json({ deployment });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '回滚失败' });
  }
});

/** 查询本机 compose 遗留槽位与 MODULE_DATA 概况 */
router.get('/modules/:moduleId/legacy', authMiddleware, (req, res) => {
  const mod = getModule(req.params.moduleId);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canReadModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权查看' });
    return;
  }
  res.json({ legacy: getModuleLegacyStatus(mod), sseinfra: isSseinfraRuntime() });
});

/**
 * 迁移：同步 MODULE_DATA → 组容器，再部署。
 * 缺 deploy.sh 且未 confirmAgentGenerate → 409 NEED_AGENT_DEPLOY_SH（前端确认后再带 flag 重试）。
 * 生成在 worker 内执行，用户可随时 cancel。
 */
router.post('/modules/:moduleId/migrate', authMiddleware, (req, res) => {
  const mod = getModule(req.params.moduleId);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权部署' });
    return;
  }

  const { env, source, packageVersion, branch, force, confirmAgentGenerate } = req.body as {
    env?: string;
    source?: 'package' | 'git';
    packageVersion?: string;
    branch?: string;
    force?: boolean;
    confirmAgentGenerate?: boolean;
  };

  let deployEnv: 'test' | 'prod';
  try {
    deployEnv = validateDeployEnv(env);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '环境无效' });
    return;
  }

  try {
    const git = getModuleGitSource(mod.id);
    const resolvedSource = source || (git?.repoUrl ? 'git' : 'package');

    if (resolvedSource === 'package') {
      const pkg = resolvePackageForDeploy(mod.id, packageVersion?.trim() || undefined);
      if (!hasDeploySh(pkg.packagePath) && !confirmAgentGenerate) {
        res.status(409).json(needAgentPayload(mod.id, packageVersion?.trim()));
        return;
      }
      if (!hasDeploySh(pkg.packagePath) && confirmAgentGenerate && !isLlmConfigured()) {
        res.status(400).json({
          error: '未配置 AI/vLLM，无法自动生成 deploy.sh',
          code: 'LLM_NOT_READY',
        });
        return;
      }
    }

    const deployment = createMigrateDeployment(mod.id, req.user!.id, {
      env: deployEnv,
      source: resolvedSource,
      packageVersion: packageVersion?.trim() || undefined,
      branch: branch?.trim() || undefined,
      force: Boolean(force),
      confirmAgentGenerate: Boolean(confirmAgentGenerate),
    });
    enqueueDeployment(deployment.id);
    res.status(201).json({ deployment });
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === 'NEED_AGENT_DEPLOY_SH' || String(err.message || '').startsWith('NEED_AGENT_DEPLOY_SH')) {
      res.status(409).json(needAgentPayload(mod.id, packageVersion?.trim()));
      return;
    }
    res.status(400).json({ error: e instanceof Error ? e.message : '创建迁移失败' });
  }
});

router.post('/:id/cancel', authMiddleware, (req, res) => {
  const deployment = getDeployment(req.params.id);
  if (!deployment) {
    res.status(404).json({ error: '部署记录不存在' });
    return;
  }
  const mod = getModule(deployment.moduleId);
  if (!mod || (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id))) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  const result = cancelDeployment(deployment.id);
  res.status(result.ok ? 200 : 400).json(result);
});

router.get('/modules/:moduleId/deployments', authMiddleware, (req, res) => {
  const mod = getModule(req.params.moduleId);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canReadModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权查看' });
    return;
  }
  const deployments = listDeployments(mod.id);
  res.json({ deployments });
});

router.get('/:id', authMiddleware, (req, res) => {
  const deployment = getDeployment(req.params.id);
  if (!deployment) {
    res.status(404).json({ error: '部署记录不存在' });
    return;
  }
  const mod = getModule(deployment.moduleId);
  if (!mod || (!canReadModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id))) {
    res.status(403).json({ error: '无权查看' });
    return;
  }
  res.json({ deployment });
});

export default router;

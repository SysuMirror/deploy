import { Router } from 'express';
import { authMiddleware, requirePlatformAdmin } from '../middleware/auth.js';
import {
  createApplication,
  listApplications,
  listReviewableApplications,
  reviewApplication,
} from '../services/applications.js';
import { listAuditLogs } from '../services/audit.js';
import { db } from '../db/init.js';
import {
  filterContainersByModules,
  listDockerContainers,
  listDockerImages,
  listDockerNetworks,
  listDockerSystemDf,
  listDockerSystemInfo,
  listDockerVolumes,
  pruneDockerBuildCache,
  pruneDockerImages,
  pruneDockerNetworks,
  pruneDockerVolumes,
  pruneUnusedContainers,
  reloadGateway,
  removeContainers,
  removeImages,
  removeNetworks,
  removeVolumes,
  restartContainers,
  startContainers,
  stopContainers,
} from '../services/docker-admin.js';
import { getPublicBasePath, isRootPublicBase, normalizeBasePath } from '../config/paths.js';
import { getBaseDomain, setPlatformSetting } from '../db/init.js';
import { regenerateNginxRoutes } from '../services/routing.js';
import { isAgentFixerEnabled, isAgentFixerGloballyEnabled } from '../services/build-fixer.js';
import { isLlmConfigured } from '../services/llm.js';
import {
  createCustomEndpoint,
  deleteCustomEndpoint,
  getActiveEndpointId,
  listCustomEndpointsForAdmin,
  setActiveEndpointId,
  updateCustomEndpoint,
  type AiCustomEndpointInput,
} from '../services/ai-custom-endpoints.js';
import {
  getSseinfraSettingsForAdmin,
  saveSseinfraSettings,
  type SseinfraSettingsInput,
} from '../services/sseinfra-settings.js';
import { SseinfraClient } from '../services/sseinfra-client.js';
import {
  addPlatformAdminByOAuthId,
  isPlatformAdmin,
  listPlatformAdmins,
  removePlatformAdmin,
} from '../services/platform-admin.js';
import { findUserByEmailOrId, listAccessibleModuleNames } from '../services/project.js';
import { listUsers } from '../services/user.js';

const router = Router();

router.use(authMiddleware);

router.get('/me', (req, res) => {
  res.json({
    isPlatformAdmin: isPlatformAdmin(req.user!.id),
    publicBasePath: getPublicBasePath() || '/',
    rootMode: isRootPublicBase(),
    baseDomain: getBaseDomain(),
    agentFixerEnabled: isAgentFixerGloballyEnabled(),
  });
});

// —— 平台设置（Agent 自愈开关、主域名、挂载路径模式等） ——
router.get('/settings', requirePlatformAdmin, (_req, res) => {
  res.json({
    agentFixerEnabled: isAgentFixerGloballyEnabled(),
    agentFixerConfigured: isAgentFixerEnabled(),
    baseDomain: getBaseDomain(),
    publicBasePath: getPublicBasePath() || '/',
    rootMode: isRootPublicBase(),
  });
});

router.get('/settings/ai/custom-endpoints', requirePlatformAdmin, (_req, res) => {
  res.json({
    endpoints: listCustomEndpointsForAdmin(),
    activeId: getActiveEndpointId() || null,
    llmConfigured: isLlmConfigured(),
  });
});

router.post('/settings/ai/custom-endpoints', requirePlatformAdmin, (req, res) => {
  try {
    const endpoint = createCustomEndpoint(req.body as AiCustomEndpointInput, req.user!.id);
    res.status(201).json({ endpoint });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '创建失败' });
  }
});

router.put('/settings/ai/custom-endpoints/:id', requirePlatformAdmin, (req, res) => {
  try {
    const endpoint = updateCustomEndpoint(
      req.params.id,
      req.body as AiCustomEndpointInput,
      req.user!.id
    );
    res.json({ endpoint });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '更新失败' });
  }
});

router.delete('/settings/ai/custom-endpoints/:id', requirePlatformAdmin, (req, res) => {
  try {
    deleteCustomEndpoint(req.params.id, req.user!.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '删除失败' });
  }
});

router.post('/settings/ai/active-endpoint', requirePlatformAdmin, (req, res) => {
  const { id } = req.body as { id?: string };
  if (!id?.trim()) {
    res.status(400).json({ error: '缺少端点 id' });
    return;
  }
  setActiveEndpointId(id.trim(), req.user!.id);
  res.json({
    endpoints: listCustomEndpointsForAdmin(),
    activeId: getActiveEndpointId() || null,
    llmConfigured: isLlmConfigured(),
  });
});

/** sseinfra 面板登录配置（管理台可改；env 有值则锁定密码项） */
router.get('/settings/sseinfra', requirePlatformAdmin, (_req, res) => {
  res.json({ sseinfra: getSseinfraSettingsForAdmin() });
});

router.post('/settings/sseinfra', requirePlatformAdmin, (req, res) => {
  try {
    const sseinfra = saveSseinfraSettings(req.body as SseinfraSettingsInput, req.user!.id);
    res.json({ sseinfra });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '保存失败' });
  }
});

/** 用当前配置试登录面板 */
router.post('/settings/sseinfra/test-login', requirePlatformAdmin, async (req, res) => {
  try {
    // 若表单带了临时密码，先不落库只测连
    const body = req.body as SseinfraSettingsInput & { password?: string };
    if (body.baseUrl || body.password || body.username || body.groupPrefix || body.sshHost) {
      // 可选：先保存非空字段再测；密码仅当填写时保存
      if (
        body.baseUrl ||
        body.groupPrefix ||
        body.sshHost ||
        body.sshUser ||
        body.username ||
        (body.password && body.password.trim()) ||
        body.clearPassword ||
        body.giteeToken ||
        body.clearGiteeToken
      ) {
        saveSseinfraSettings(body, req.user!.id);
      }
    }
    const client = new SseinfraClient();
    await client.login();
    res.json({ ok: true, message: '登录成功，已获得 session', sseinfra: getSseinfraSettingsForAdmin() });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: e instanceof Error ? e.message : '登录失败',
      sseinfra: getSseinfraSettingsForAdmin(),
    });
  }
});

router.post('/settings', requirePlatformAdmin, (req, res) => {
  const { agentFixerEnabled, baseDomain, publicBasePath } = req.body as {
    agentFixerEnabled?: boolean;
    baseDomain?: string;
    publicBasePath?: string;
  };

  if (typeof agentFixerEnabled === 'boolean') {
    setPlatformSetting('agent_fixer_enabled', agentFixerEnabled ? '1' : '0', req.user!.id);
  }
  if (typeof baseDomain === 'string') {
    const domain = baseDomain
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '');
    if (domain) setPlatformSetting('base_domain', domain, req.user!.id);
  }
  if (typeof publicBasePath === 'string') {
    setPlatformSetting('public_base_path', normalizeBasePath(publicBasePath), req.user!.id);
    // 挂载路径变化会改变 nginx 路由，重新生成并 reload
    try {
      regenerateNginxRoutes();
    } catch (e) {
      console.warn('更新挂载路径后重载网关失败:', e instanceof Error ? e.message : e);
    }
  }

  res.json({
    agentFixerEnabled: isAgentFixerGloballyEnabled(),
    agentFixerConfigured: isAgentFixerEnabled(),
    baseDomain: getBaseDomain(),
    publicBasePath: getPublicBasePath() || '/',
    rootMode: isRootPublicBase(),
  });
});

// —— 审批 ——
router.get('/applications', (req, res) => {
  const mine = req.query.mine === '1';
  if (mine) {
    res.json({ applications: listApplications({ applicantId: req.user!.id }) });
    return;
  }
  res.json({ applications: listReviewableApplications(req.user!.id) });
});

router.get('/audit-logs', requirePlatformAdmin, (req, res) => {
  const limit = Number(req.query.limit) || 100;
  const action = typeof req.query.action === 'string' ? req.query.action : undefined;
  res.json({ logs: listAuditLogs({ limit, action }) });
});

router.post('/applications/:id/review', async (req, res) => {
  const { decision, note } = req.body as { decision?: string; note?: string };
  if (decision !== 'approved' && decision !== 'rejected') {
    res.status(400).json({ error: 'decision 须为 approved 或 rejected' });
    return;
  }
  try {
    const application = await reviewApplication(req.params.id, req.user!.id, decision, note);
    res.json({ application });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '审核失败';
    const status = msg.includes('无权') ? 403 : 400;
    res.status(status).json({ error: msg });
  }
});

router.post('/applications', (req, res) => {
  const { type, projectId, moduleId, payload } = req.body as {
    type?: string;
    projectId?: string;
    moduleId?: string;
    payload?: Record<string, unknown>;
  };
  const allowed = [
    'create_project',
    'join_project',
    'create_module',
    'join_module',
    'minio_bucket',
  ];
  if (!type || !allowed.includes(type)) {
    res.status(400).json({ error: '无效申请类型' });
    return;
  }
  try {
    const application = createApplication(req.user!.id, {
      type: type as
        | 'create_project'
        | 'join_project'
        | 'create_module'
        | 'join_module'
        | 'minio_bucket',
      projectId,
      moduleId,
      payload,
    });
    res.status(201).json({ application });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '提交失败' });
  }
});

// —— 容器（平台管理员看全量；普通成员按项目隔离，仅本项目的 sdpy 容器） ——
router.get('/containers', async (req, res) => {
  try {
    const containers = await listDockerContainers();
    if (isPlatformAdmin(req.user!.id)) {
      res.json({ containers });
      return;
    }
    const names = listAccessibleModuleNames(req.user!.id);
    res.json({ containers: filterContainersByModules(containers, names) });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '列举容器失败' });
  }
});

router.post('/containers/delete', async (req, res) => {
  const { ids } = req.body as { ids?: string[] };
  if (!ids?.length) {
    res.status(400).json({ error: '请选择容器' });
    return;
  }
  try {
    if (isPlatformAdmin(req.user!.id)) {
      const result = await removeContainers(ids);
      res.json(result);
      return;
    }
    const names = listAccessibleModuleNames(req.user!.id);
    const all = await listDockerContainers();
    const allowed = new Set(filterContainersByModules(all, names).map((c) => c.id));
    const ok: string[] = [];
    const denied: string[] = [];
    for (const id of ids) {
      const t = id.trim();
      if (!t) continue;
      if (allowed.has(t)) ok.push(t);
      else denied.push(`${t}: 无权操作该容器`);
    }
    const result = await removeContainers(ok);
    res.json({ removed: result.removed, errors: [...result.errors, ...denied] });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '删除失败' });
  }
});

router.post('/containers/prune', async (req, res) => {
  const { onlySdpy, includeRunning } = req.body as {
    onlySdpy?: boolean;
    includeRunning?: boolean;
  };
  try {
    if (isPlatformAdmin(req.user!.id)) {
      const result = await pruneUnusedContainers({ onlySdpy, includeRunning });
      res.json(result);
      return;
    }
    const names = listAccessibleModuleNames(req.user!.id);
    const all = await listDockerContainers();
    const targets = filterContainersByModules(all, names).filter(
      (c) => c.state !== 'running' && c.state !== 'restarting'
    );
    const result = await removeContainers(targets.map((c) => c.id));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '清理失败' });
  }
});

// —— 容器启停（仅平台管理员） ——
router.post('/containers/start', requirePlatformAdmin, async (req, res) => {
  const { ids } = req.body as { ids?: string[] };
  if (!ids?.length) {
    res.status(400).json({ error: '请选择容器' });
    return;
  }
  try {
    res.json(await startContainers(ids));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '启动失败' });
  }
});

router.post('/containers/stop', requirePlatformAdmin, async (req, res) => {
  const { ids } = req.body as { ids?: string[] };
  if (!ids?.length) {
    res.status(400).json({ error: '请选择容器' });
    return;
  }
  try {
    res.json(await stopContainers(ids));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '停止失败' });
  }
});

router.post('/containers/restart', requirePlatformAdmin, async (req, res) => {
  const { ids } = req.body as { ids?: string[] };
  if (!ids?.length) {
    res.status(400).json({ error: '请选择容器' });
    return;
  }
  try {
    res.json(await restartContainers(ids));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '重启失败' });
  }
});

router.post('/gateway/reload', requirePlatformAdmin, async (_req, res) => {
  const result = await reloadGateway();
  res.status(result.ok ? 200 : 500).json(result);
});

// —— 镜像 / 构建缓存清理 ——
router.post('/containers/prune-images', requirePlatformAdmin, async (_req, res) => {
  try {
    const result = await pruneDockerImages();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '清理镜像失败' });
  }
});

router.post('/containers/prune-builder', requirePlatformAdmin, async (_req, res) => {
  try {
    const result = await pruneDockerBuildCache();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '清理构建缓存失败' });
  }
});

// —— 镜像（仅平台管理员） ——
router.get('/images', requirePlatformAdmin, async (_req, res) => {
  try {
    res.json({ images: await listDockerImages() });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '列举镜像失败' });
  }
});

router.post('/images/delete', requirePlatformAdmin, async (req, res) => {
  const { ids } = req.body as { ids?: string[] };
  if (!ids?.length) {
    res.status(400).json({ error: '请选择镜像' });
    return;
  }
  try {
    res.json(await removeImages(ids));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '删除镜像失败' });
  }
});

// —— 数据卷（仅平台管理员） ——
router.get('/volumes', requirePlatformAdmin, async (_req, res) => {
  try {
    res.json({ volumes: await listDockerVolumes() });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '列举数据卷失败' });
  }
});

router.post('/volumes/delete', requirePlatformAdmin, async (req, res) => {
  const { names } = req.body as { names?: string[] };
  if (!names?.length) {
    res.status(400).json({ error: '请选择数据卷' });
    return;
  }
  try {
    res.json(await removeVolumes(names));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '删除数据卷失败' });
  }
});

router.post('/volumes/prune', requirePlatformAdmin, async (_req, res) => {
  try {
    res.json(await pruneDockerVolumes());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '清理数据卷失败' });
  }
});

// —— 网络（仅平台管理员） ——
router.get('/networks', requirePlatformAdmin, async (_req, res) => {
  try {
    res.json({ networks: await listDockerNetworks() });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '列举网络失败' });
  }
});

router.post('/networks/delete', requirePlatformAdmin, async (req, res) => {
  const { names } = req.body as { names?: string[] };
  if (!names?.length) {
    res.status(400).json({ error: '请选择网络' });
    return;
  }
  try {
    res.json(await removeNetworks(names));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '删除网络失败' });
  }
});

router.post('/networks/prune', requirePlatformAdmin, async (_req, res) => {
  try {
    res.json(await pruneDockerNetworks());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '清理网络失败' });
  }
});

// —— 系统概览（仅平台管理员）：磁盘占用 + 守护进程 / 主机信息 ——
router.get('/system', requirePlatformAdmin, async (_req, res) => {
  try {
    const [info, disk] = await Promise.all([listDockerSystemInfo(), listDockerSystemDf()]);
    res.json({ info, disk });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '获取系统概览失败' });
  }
});

/** MinIO 桶绑定一览（平台不提供删桶；删组/删模块默认保留） */
router.get('/object-storage', requirePlatformAdmin, (_req, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT module_id, env, bucket, key_label, status, last_sync_at, last_sync_files, last_sync_bytes, updated_at
         FROM module_object_storage ORDER BY updated_at DESC`
      )
      .all() as Array<{
      module_id: string;
      env: string;
      bucket: string;
      key_label: string;
      status: string;
      last_sync_at: string | null;
      last_sync_files: number;
      last_sync_bytes: number;
      updated_at: string;
    }>;
    res.json({
      bindings: rows.map((r) => ({
        moduleId: r.module_id,
        env: r.env,
        bucket: r.bucket,
        keyLabel: r.key_label,
        status: r.status,
        lastSyncAt: r.last_sync_at,
        lastSyncFiles: r.last_sync_files,
        lastSyncBytes: r.last_sync_bytes,
        updatedAt: r.updated_at,
      })),
      policy:
        '对象存储桶随模块保留；释放 K8s 组或删除模块时默认不删桶。需删桶请教师在 sseinfra /storage 面板人工处理。',
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : '查询失败' });
  }
});

// —— 平台管理员 ——
router.get('/admins', requirePlatformAdmin, (_req, res) => {
  res.json({ admins: listPlatformAdmins() });
});

router.post('/admins', requirePlatformAdmin, (req, res) => {
  const { oauthId, userQuery } = req.body as { oauthId?: string; userQuery?: string };
  try {
    let id = (oauthId ?? '').trim();
    if (!id && userQuery?.trim()) {
      const user = findUserByEmailOrId(userQuery);
      if (!user) {
        res.status(404).json({ error: '未找到用户（对方需先登录过本平台）' });
        return;
      }
      id = user.oauthId;
      if (!id) {
        res.status(400).json({ error: '该用户尚未关联 OAuth ID，无法设为管理员' });
        return;
      }
    }
    if (!id) {
      res.status(400).json({ error: '请填写 OAuth ID 或用户邮箱 / 用户名' });
      return;
    }
    addPlatformAdminByOAuthId(id);
    res.json({ admins: listPlatformAdmins() });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '添加失败' });
  }
});

router.delete('/admins/:oauthId', requirePlatformAdmin, (req, res) => {
  try {
    removePlatformAdmin(req.params.oauthId);
    res.json({ admins: listPlatformAdmins() });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '移除失败' });
  }
});

router.get('/users', requirePlatformAdmin, (_req, res) => {
  res.json({ users: listUsers() });
});

export default router;

import { Router } from 'express';
import multer from 'multer';
import { authMiddleware } from '../middleware/auth.js';
import { getBaseDomain } from '../db/init.js';
import { getPublicBasePath, isRootPublicBase } from '../config/paths.js';
import {
  addModuleMember,
  canDeleteModule,
  canReadModule,
  canWriteModule,
  deleteModule,
  deletePackageVersion,
  findUserByEmailOrId,
  getModule,
  getModuleUrls,
  getModuleWebhookSecret,
  insertPackageVersion,
  isProjectOwner,
  listModuleMembers,
  listPackages,
  removeModuleMember,
  rotateModuleWebhookSecret,
  setModuleGitConfig,
  setModulePackage,
  setModulePathMode,
  setModulePriority,
} from '../services/project.js';
import { getUserById } from '../services/user.js';
import { saveAndExtractPackage } from '../services/package-store.js';
import { createApplication } from '../services/applications.js';
import { isPlatformAdmin } from '../services/platform-admin.js';
import { generateDeployShForModule } from '../services/generate-deploy-sh.js';
import {
  getModuleEnvConfigMeta,
  parseEnvInput,
  setModuleEnvVars,
} from '../services/module-env-config.js';
import {
  addModuleDomain,
  ensureDefaultDomainsForModule,
  deleteModuleDomain,
  listModuleDomains,
  RESERVED_SUBDOMAIN_LABELS,
  updateModuleDomain,
  type DomainKind,
  type DomainRouteTarget,
  type GrayMatchType,
} from '../services/module-domains.js';
import { regenerateNginxRoutes } from '../services/routing.js';
import {
  describeModuleDataExport,
  getModuleDataDir,
} from '../services/module-data.js';
import type { DeployEnv } from '../types.js';
import AdmZip from 'adm-zip';
import { existsSync } from 'fs';

function parseDeployEnvParam(raw: unknown): DeployEnv {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'prod' || v === 'production') return 'prod';
  if (v === 'test' || v === 'dev') return 'test';
  throw new Error('env 须为 test 或 prod');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.UPLOAD_MAX_MB || 200) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    if (name.endsWith('.zip')) cb(null, true);
    else cb(new Error('仅支持 .zip 压缩包'));
  },
});

const router = Router();

router.get('/:id', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canReadModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权访问' });
    return;
  }
  const urls = getModuleUrls(mod.name);
  const domains = listModuleDomains(mod.id);
  res.json({
    module: mod,
    urls: {
      test: urls.test,
      testApi: urls.testApi,
      prod: urls.prod,
      prodApi: urls.prodApi,
    },
    domains,
    reservedSubdomains: [...RESERVED_SUBDOMAIN_LABELS].sort(),
    members: listModuleMembers(mod.id),
    baseDomain: getBaseDomain(),
    publicBasePath: getPublicBasePath() || '/',
    rootMode: isRootPublicBase(),
    canDelete: canDeleteModule(mod.id, req.user!.id),
    canWrite: canWriteModule(mod.id, req.user!.id),
    canManageMembers:
      isProjectOwner(mod.projectId, req.user!.id) ||
      mod.createdBy === req.user!.id ||
      isPlatformAdmin(req.user!.id),
  });
});

/**
 * 修改访问模式：root=根路径 /subpath=/sdpy 前缀 /domain=仅子域名（不出路径路由）/ ''=跟随平台默认。
 * 切到 domain 时自动登记默认子域名（prod={module}.base / test=test.{module}.base）。
 */
router.patch('/:id/path-mode', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  const { pathMode } = req.body as { pathMode?: string };
  try {
    const updated = setModulePathMode(mod.id, String(pathMode ?? ''));
    if (updated?.pathMode === 'domain') {
      for (const env of ['test', 'prod'] as const) {
        ensureDefaultDomainsForModule(mod.id, mod.name, env, req.user!.id);
      }
    }
    regenerateNginxRoutes();
    res.json({ module: updated });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '保存失败' });
  }
});

router.put('/:id/git', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  const { repoUrl, provider, branch, username, token, clearToken } = req.body as {
    repoUrl?: string;
    provider?: string;
    branch?: string;
    username?: string;
    token?: string;
    clearToken?: boolean;
  };
  try {
    const updated = setModuleGitConfig(mod.id, req.user!.id, {
      repoUrl,
      provider,
      branch,
      username,
      token,
      clearToken: Boolean(clearToken),
    });
    res.json({ module: updated });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '保存失败' });
  }
});

/**
 * 设置模块优先级（critical / normal / best_effort）。
 * 部署时注入为 PRIORITY 环境变量推进 sseinfra 组，底层据此在压力高时排杀序。
 */
router.patch('/:id/priority', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  const { priority } = req.body as { priority?: string };
  try {
    const updated = setModulePriority(
      mod.id,
      String(priority ?? '').trim() as 'critical' | 'normal' | 'best_effort'
    );
    res.json({ module: updated });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '保存失败' });
  }
});

/** 查看模块 webhook 配置（含明文密钥，仅模块写权限可见） */
router.get('/:id/webhook', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  const secret = getModuleWebhookSecret(mod.id);
  res.json({
    enabled: Boolean(secret),
    secret,
    path: `/webhooks/git/${mod.id}`,
    webhookUrl: `https://${getBaseDomain()}/sdpy-api/webhooks/git/${mod.id}`,
  });
});

/** 轮换模块 webhook 密钥 */
router.post('/:id/webhook', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  const secret = rotateModuleWebhookSecret(mod.id);
  res.json({
    enabled: true,
    secret,
    path: `/webhooks/git/${mod.id}`,
    webhookUrl: `https://${getBaseDomain()}/sdpy-api/webhooks/git/${mod.id}`,
  });
});

router.post('/:id/join', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  try {
    const application = createApplication(req.user!.id, {
      type: 'join_module',
      moduleId: mod.id,
      projectId: mod.projectId,
      payload: { message: req.body?.message },
    });
    res.status(201).json({ application, message: '已提交加入模块申请' });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '提交失败' });
  }
});

router.post('/:id/members', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  const canManage =
    isProjectOwner(mod.projectId, req.user!.id) ||
    mod.createdBy === req.user!.id ||
    isPlatformAdmin(req.user!.id);
  if (!canManage) {
    res.status(403).json({ error: '仅负责人可添加模块成员' });
    return;
  }
  const { userQuery } = req.body as { userQuery?: string };
  const user = findUserByEmailOrId(userQuery ?? '');
  if (!user) {
    res.status(404).json({ error: '未找到用户（对方需先登录过本平台）' });
    return;
  }
  try {
    addModuleMember(mod.id, user.id, 'developer');
    res.json({ members: listModuleMembers(mod.id) });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '添加失败' });
  }
});

router.delete('/:id/members/:userId', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  const canManage =
    isProjectOwner(mod.projectId, req.user!.id) ||
    mod.createdBy === req.user!.id ||
    isPlatformAdmin(req.user!.id);
  if (!canManage) {
    res.status(403).json({ error: '仅负责人可移除模块成员' });
    return;
  }
  try {
    removeModuleMember(mod.id, req.params.userId);
    res.json({ members: listModuleMembers(mod.id) });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '移除失败' });
  }
});

router.get('/:id/packages', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canReadModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权访问' });
    return;
  }
  const packages = listPackages(mod.id).map((p) => ({
    ...p,
    uploadedByName: getUserById(p.uploadedBy)?.name ?? p.uploadedBy,
    canDelete: p.uploadedBy === req.user!.id || isPlatformAdmin(req.user!.id),
    isCurrent: p.version === mod.packageVersion,
  }));
  res.json({ packages, currentVersion: mod.packageVersion ?? null });
});

router.delete('/:id/packages/:version', authMiddleware, async (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  try {
    deletePackageVersion(mod.id, req.params.version, req.user!.id);
    const updated = getModule(mod.id);
    res.json({ ok: true, module: updated, packages: listPackages(mod.id) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '删除失败';
    const status = msg.includes('仅') ? 403 : 400;
    res.status(status).json({ error: msg });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  try {
    await deleteModule(mod.id, req.user!.id);
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '删除失败';
    const status = msg.includes('仅') ? 403 : 400;
    res.status(status).json({ error: msg });
  }
});

router.post(
  '/:id/package',
  authMiddleware,
  (req, res, next) => {
    upload.single('package')(req, res, (err) => {
      if (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : '上传失败' });
        return;
      }
      next();
    });
  },
  (req, res) => {
    const mod = getModule(req.params.id);
    if (!mod) {
      res.status(404).json({ error: '模块不存在' });
      return;
    }
    if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
      res.status(403).json({ error: '无权操作' });
      return;
    }
    const file = req.file;
    if (!file?.buffer?.length) {
      res.status(400).json({ error: '请选择 .zip 文件' });
      return;
    }

    const label =
      typeof req.body?.label === 'string' ? req.body.label.trim() : '';

    try {
      const stored = saveAndExtractPackage(mod.id, file.originalname, file.buffer, label);
      insertPackageVersion(mod.id, req.user!.id, {
        version: stored.version,
        fileName: stored.fileName,
        packagePath: stored.packagePath,
        label: stored.label,
      });
      const updated = setModulePackage(mod.id, {
        packagePath: stored.packagePath,
        packageVersion: stored.version,
        packageFileName: stored.fileName,
      });
      res.json({
        module: updated,
        package: {
          version: stored.version,
          fileName: stored.fileName,
          composeFile: stored.composeFile,
          label: stored.label,
        },
        packages: listPackages(mod.id),
      });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : '上传失败' });
    }
  }
);

/** Agent 根据压缩包生成 deploy.sh（非流式） */
router.post('/:id/agent/generate-deploy-sh', authMiddleware, async (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  const { packageVersion, apply } = req.body as { packageVersion?: string; apply?: boolean };
  try {
    const result = await generateDeployShForModule(mod.id, {
      packageVersion: packageVersion?.trim() || undefined,
      apply: apply !== false,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '生成失败' });
  }
});

/** Agent 流式生成 deploy.sh（SSE，对齐 iWiki） */
router.post('/:id/agent/generate-deploy-sh/stream', authMiddleware, async (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  const { packageVersion, apply } = req.body as { packageVersion?: string; apply?: boolean };

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const writeSse = (obj: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  try {
    writeSse({ type: 'meta', message: '部署 Agent（tools）启动' });
    const result = await generateDeployShForModule(mod.id, {
      packageVersion: packageVersion?.trim() || undefined,
      apply: apply !== false,
      onEvent: (ev) => writeSse(ev as unknown as Record<string, unknown>),
    });
    writeSse({
      type: 'done',
      deploySh: result.deploySh,
      applied: result.applied,
      hadDeploySh: result.hadDeploySh,
      writtenFiles: result.writtenFiles,
      summary: result.summary,
      turns: result.turns,
    });
  } catch (e) {
    writeSse({ type: 'error', message: e instanceof Error ? e.message : '生成失败' });
  }
  res.end();
});

/** 读取某环境的模块环境变量（test / prod 分槽） */
router.get('/:id/env-config', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canReadModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权访问' });
    return;
  }
  try {
    const env = parseDeployEnvParam(req.query.env);
    res.json({ config: getModuleEnvConfigMeta(mod.id, env, mod.name) });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '参数错误' });
  }
});

/**
 * 保存某环境的模块环境变量。
 * body: { env, vars? } 或 { env, text? } —— vars 为 JSON 对象，text 为 JSON 或 .env 文本。
 */
router.put('/:id/env-config', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  try {
    const body = req.body as { env?: string; vars?: unknown; text?: string };
    const env = parseDeployEnvParam(body.env ?? req.query.env);
    const raw = body.vars !== undefined ? body.vars : body.text !== undefined ? body.text : {};
    const vars = parseEnvInput(raw);
    setModuleEnvVars(mod.id, env, vars, req.user!.id);
    res.json({
      config: getModuleEnvConfigMeta(mod.id, env, mod.name),
      message: `已保存 ${env} 环境变量（与 ${env} 数据目录隔离；部署时写入根 .env）`,
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '保存失败' });
  }
});

/** 列出模块域名（子域名 / 自定义）；可按 env 过滤 */
router.get('/:id/domains', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canReadModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权访问' });
    return;
  }
  try {
    const envRaw = req.query.env;
    const env =
      envRaw !== undefined && String(envRaw).trim() !== ''
        ? parseDeployEnvParam(envRaw)
        : undefined;
    res.json({
      domains: listModuleDomains(mod.id, env),
      baseDomain: getBaseDomain(),
      reservedSubdomains: [...RESERVED_SUBDOMAIN_LABELS].sort(),
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '参数错误' });
  }
});

/**
 * 新增域名。
 * body: { env, kind: 'subdomain'|'custom', value, isPrimary?, grayMatchType?, grayMatchKey?, grayMatchValue? }
 * - subdomain: value 为标签，如 image → image.{baseDomain}
 * - custom: value 为完整域名
 */
router.post('/:id/domains', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  try {
    const body = req.body as {
      env?: string;
      kind?: string;
      value?: string;
      routeTarget?: string;
      isPrimary?: boolean;
      grayMatchType?: string;
      grayMatchKey?: string;
      grayMatchValue?: string;
    };
    const env = parseDeployEnvParam(body.env);
    const kind = String(body.kind || '').trim() as DomainKind;
    if (kind !== 'subdomain' && kind !== 'custom') {
      throw new Error('kind 须为 subdomain 或 custom');
    }
    const value = String(body.value ?? '').trim();
    if (!value) throw new Error('请填写子域名标签或自定义域名');
    const routeTarget = (body.routeTarget === 'api' ? 'api' : 'web') as DomainRouteTarget;
    const domain = addModuleDomain(
      mod.id,
      {
        env,
        kind,
        value,
        routeTarget,
        isPrimary: body.isPrimary,
        grayMatchType: body.grayMatchType as GrayMatchType | undefined,
        grayMatchKey: body.grayMatchKey,
        grayMatchValue: body.grayMatchValue,
      },
      req.user!.id
    );
    regenerateNginxRoutes((line) => console.log(line));
    res.status(201).json({
      domain,
      message: `已绑定 ${domain.host}（部署后网关才会反代到上游）`,
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '添加失败' });
  }
});

/** 更新域名：启用/主域名/灰度参数（灰度路由后续生效） */
router.patch('/:id/domains/:domainId', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  try {
    const body = req.body as {
      enabled?: boolean;
      isPrimary?: boolean;
      routeTarget?: string;
      grayMatchType?: string;
      grayMatchKey?: string;
      grayMatchValue?: string;
    };
    const domain = updateModuleDomain(
      req.params.domainId,
      {
        enabled: body.enabled,
        isPrimary: body.isPrimary,
        routeTarget: body.routeTarget as DomainRouteTarget | undefined,
        grayMatchType: body.grayMatchType as GrayMatchType | undefined,
        grayMatchKey: body.grayMatchKey,
        grayMatchValue: body.grayMatchValue,
      },
      mod.id
    );
    regenerateNginxRoutes((line) => console.log(line));
    res.json({ domain });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '更新失败' });
  }
});

router.delete('/:id/domains/:domainId', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  try {
    deleteModuleDomain(req.params.domainId, mod.id);
    regenerateNginxRoutes((line) => console.log(line));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '删除失败' });
  }
});

/** 申请对象存储（MinIO 桶）：管理员审批后自动建桶并按组名发密钥 */
router.post('/:id/minio-bucket-apply', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  try {
    const env = parseDeployEnvParam(
      (req.body as { env?: string }).env ?? req.query.env
    );
    const application = createApplication(req.user!.id, {
      type: 'minio_bucket',
      projectId: mod.projectId,
      moduleId: mod.id,
      payload: {
        env,
        moduleName: mod.name,
        reason: String((req.body as { reason?: string }).reason ?? '').trim(),
      },
    });
    res.status(201).json({
      application,
      message:
        '已提交对象存储申请。平台管理员审批通过后将建桶并签发密钥（标签=组名），重新部署后注入 MINIO_*。桶随模块保留，删组不删桶。',
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '申请失败' });
  }
});

/** 对象存储状态（绑定、宿主机数据量、生命周期策略） */
router.get('/:id/object-storage', authMiddleware, async (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canReadModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权访问' });
    return;
  }
  try {
    const env = parseDeployEnvParam(req.query.env);
    const { getObjectStorageStatus } = await import('../services/minio-sync.js');
    const { listModuleObjectStorage } = await import('../services/module-object-storage.js');
    res.json({
      current: getObjectStorageStatus(mod, env),
      all: listModuleObjectStorage(mod.id),
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '查询失败' });
  }
});

/**
 * 强制确保桶存在（幂等建桶+发密钥）。
 * 仅平台管理员：普通成员须走 minio-bucket-apply 审批，禁止用本接口绕过。
 */
router.post('/:id/object-storage/ensure', authMiddleware, async (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!isPlatformAdmin(req.user!.id)) {
    res.status(403).json({
      error: '普通成员请「申请对象存储」并等待审批；仅平台管理员可强制确保桶',
    });
    return;
  }
  try {
    const env = parseDeployEnvParam(
      (req.body as { env?: string }).env ?? req.query.env
    );
    const { ensureModuleBucket } = await import('../services/minio-sync.js');
    const logs: string[] = [];
    const result = await ensureModuleBucket(mod, env, req.user!.id, (l) => logs.push(l));
    res.json({ ...result, logs, message: '已确保桶与密钥；删 K8s 组不会删除此桶' });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '确保失败' });
  }
});

/** 查询 MinIO 连接凭证（从 sseinfra 面板解析；标签=组名） */
router.get('/:id/object-storage/credentials', authMiddleware, async (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canReadModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权访问' });
    return;
  }
  try {
    const env = parseDeployEnvParam(req.query.env);
    const { getModuleObjectStorageCredentials } = await import('../services/minio-sync.js');
    res.json(await getModuleObjectStorageCredentials(mod, env));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '查询密钥失败' });
  }
});

/** 浏览桶内对象（需已审批开通；只读） */
router.get('/:id/object-storage/objects', authMiddleware, async (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canReadModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权访问' });
    return;
  }
  try {
    const env = parseDeployEnvParam(req.query.env);
    const prefix = String(req.query.prefix ?? '').trim();
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 200;
    const { listModuleBucketObjects } = await import('../services/minio-sync.js');
    const result = await listModuleBucketObjects({
      mod,
      env,
      prefix: prefix || undefined,
      limit,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '列出对象失败' });
  }
});

/** 同步历史 MODULE_DATA → MinIO 桶（异步任务，可轮询进度） */
router.post('/:id/object-storage/sync', authMiddleware, async (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canWriteModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权操作' });
    return;
  }
  try {
    const body = req.body as { env?: string; pushHostData?: boolean };
    const env = parseDeployEnvParam(body.env ?? req.query.env);
    const { getModuleObjectStorage } = await import('../services/module-object-storage.js');
    const binding = getModuleObjectStorage(mod.id, env);
    if (!binding || binding.status === 'none' || binding.status === 'orphaned') {
      res.status(400).json({
        error: '请先「申请对象存储」并等待管理员审批通过后再同步',
      });
      return;
    }
    const { startMinioSyncJob, publicMinioSyncJob } = await import(
      '../services/minio-sync-jobs.js'
    );
    const job = startMinioSyncJob({
      mod,
      env,
      actorId: req.user!.id,
      pushHostData: body.pushHostData !== false,
    });
    res.status(202).json({
      job: publicMinioSyncJob(job),
      message: '同步任务已启动，请轮询进度',
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '启动同步失败' });
  }
});

/** 查询该模块+环境下最新同步任务（页面重进后恢复进度） */
router.get('/:id/object-storage/sync', authMiddleware, async (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canReadModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权访问' });
    return;
  }
  try {
    const env = parseDeployEnvParam(req.query.env);
    const { findLatestMinioSyncJob, publicMinioSyncJob } = await import(
      '../services/minio-sync-jobs.js'
    );
    const job = findLatestMinioSyncJob(mod.id, env);
    res.json({ job: job ? publicMinioSyncJob(job) : null });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '查询失败' });
  }
});

/** 查询同步任务进度 */
router.get('/:id/object-storage/sync/:jobId', authMiddleware, async (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canReadModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权访问' });
    return;
  }
  try {
    const { getMinioSyncJob, publicMinioSyncJob } = await import('../services/minio-sync-jobs.js');
    const job = getMinioSyncJob(req.params.jobId);
    if (!job || job.moduleId !== mod.id) {
      res.status(404).json({ error: '同步任务不存在' });
      return;
    }
    const { getObjectStorageStatus } = await import('../services/minio-sync.js');
    res.json({
      job: publicMinioSyncJob(job),
      status: job.status === 'success' ? getObjectStorageStatus(mod, job.env) : undefined,
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '查询失败' });
  }
});

/** 查询某环境业务数据目录概况（下载前预检） */
router.get('/:id/data-export', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canReadModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权访问' });
    return;
  }
  try {
    const env = parseDeployEnvParam(req.query.env);
    res.json({ export: describeModuleDataExport(mod.name, env) });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '参数错误' });
  }
});

/** 下载某环境 MODULE_DATA 压缩包（zip，按 test/prod 分目录） */
router.get('/:id/data-export.zip', authMiddleware, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod) {
    res.status(404).json({ error: '模块不存在' });
    return;
  }
  if (!canReadModule(mod.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权访问' });
    return;
  }
  try {
    const env = parseDeployEnvParam(req.query.env);
    const info = describeModuleDataExport(mod.name, env);
    if (!info.exists) {
      res.status(404).json({ error: `数据目录不存在: ${info.dataDir}` });
      return;
    }
    if (info.empty) {
      res.status(404).json({ error: '该环境数据目录为空，无文件可下载' });
      return;
    }
    if (info.tooLarge) {
      res.status(413).json({
        error: `数据约 ${(info.approxBytes / 1024 / 1024).toFixed(0)}MB，超过导出上限 ${(info.maxBytes / 1024 / 1024).toFixed(0)}MB。可调 MODULE_DATA_EXPORT_MAX_MB 或在宿主机打包。`,
      });
      return;
    }
    const dir = getModuleDataDir(mod.name, env);
    if (!existsSync(dir)) {
      res.status(404).json({ error: '数据目录不存在' });
      return;
    }
    const zip = new AdmZip();
    zip.addLocalFolder(dir, `${mod.name}-${env}`);
    const buf = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${info.fileName}"`
    );
    res.setHeader('Content-Length', String(buf.length));
    res.send(buf);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '导出失败' });
  }
});

export default router;

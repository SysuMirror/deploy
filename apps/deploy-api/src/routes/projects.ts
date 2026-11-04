import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  addProjectMember,
  canReadProject,
  canWriteProject,
  createModule,
  createProject,
  deleteProject,
  findUserByEmailOrId,
  getProject,
  getProjectMemberScope,
  getProjectRole,
  isProjectOwner,
  listAllVisibleProjects,
  listModules,
  listProjectMembers,
  listProjectsForUser,
  listProjectsOwnedBy,
  listProjectDirectory,
  searchPublicProjects,
  getProjectPreview,
  removeProjectMember,
  canDeleteProject,
  setProjectMemberScope,
  updateProject,
} from '../services/project.js';
import { createApplication } from '../services/applications.js';
import { getBaseDomain } from '../db/init.js';
import { getPublicBasePath, isRootPublicBase } from '../config/paths.js';
import { isPlatformAdmin } from '../services/platform-admin.js';
import { searchUsers } from '../services/user.js';

const router = Router();

router.get('/', authMiddleware, (req, res) => {
  const projects = listProjectsForUser(req.user!.id);
  res.json({ projects });
});

/** 首页「我创建的项目」 */
router.get('/mine', authMiddleware, (req, res) => {
  res.json({ projects: listProjectsOwnedBy(req.user!.id) });
});

/** 首页「全部项目」：我创建的 + 我参与的 + 公开项目，支持搜索 */
router.get('/all', authMiddleware, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.json({ projects: listAllVisibleProjects(req.user!.id, q) });
});

/** 成员管理页搜索用户（仅项目 owner / 平台管理员） */
router.get('/user-search', authMiddleware, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 1) {
    res.json({ users: [] });
    return;
  }
  res.json({ users: searchUsers(q, 10) });
});

router.get('/directory', authMiddleware, (req, res) => {
  res.json({ projects: listProjectDirectory(req.user!.id) });
});

router.get('/search', authMiddleware, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.json({ projects: searchPublicProjects(req.user!.id, q) });
});

/** 创建项目：普通用户提交审批；管理员可直接创建 */
router.post('/', authMiddleware, (req, res) => {
  const { name, description, visibility, direct } = req.body as {
    name?: string;
    description?: string;
    visibility?: string;
    direct?: boolean;
  };
  if (!name?.trim()) {
    res.status(400).json({ error: '项目名称不能为空' });
    return;
  }

  // 平台管理员可直接创建
  if (direct && isPlatformAdmin(req.user!.id)) {
    const project = createProject(req.user!.id, { name, description, visibility });
    res.status(201).json({ project, direct: true });
    return;
  }

  try {
    const application = createApplication(req.user!.id, {
      type: 'create_project',
      payload: { name: name.trim(), description: description?.trim() ?? '', visibility },
    });
    res.status(201).json({
      application,
      message: '已提交创建项目申请，请等待管理员审批',
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '提交失败' });
  }
});

router.get('/:id/preview', authMiddleware, (req, res) => {
  const preview = getProjectPreview(req.params.id, req.user!.id);
  if (preview.kind === 'not_found') {
    res.status(404).json({ error: '项目不存在' });
    return;
  }
  if (preview.kind === 'forbidden') {
    res.status(403).json({ error: '该项目未公开，无法预览' });
    return;
  }
  if (preview.kind === 'member') {
    res.status(409).json({ error: '你已是成员，请访问完整项目页', projectId: preview.projectId });
    return;
  }
  res.json({
    project: preview.project,
    modules: preview.modules,
    moduleCount: preview.moduleCount,
    readOnly: true,
    canJoin: true,
  });
});

router.get('/:id', authMiddleware, (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: '项目不存在' });
    return;
  }
  if (!canReadProject(project.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '无权访问' });
    return;
  }
  const modules = listModules(project.id);
  const members = listProjectMembers(project.id);
  res.json({
    project,
    modules,
    members,
    baseDomain: getBaseDomain(),
    publicBasePath: getPublicBasePath() || '/',
    rootMode: isRootPublicBase(),
    canDelete: canDeleteProject(project.id, req.user!.id),
    canManageMembers: isProjectOwner(project.id, req.user!.id) || isPlatformAdmin(req.user!.id),
    isOwner: isProjectOwner(project.id, req.user!.id),
  });
});

/** 修改项目名称 / 描述 / 公开性 */
router.patch('/:id', authMiddleware, (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: '项目不存在' });
    return;
  }
  if (!isProjectOwner(project.id, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '仅项目负责人或管理员可修改项目信息' });
    return;
  }
  const { name, description, visibility } = req.body as {
    name?: string;
    description?: string;
    visibility?: string;
  };
  try {
    const updated = updateProject(project.id, { name, description, visibility });
    res.json({ project: updated });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '更新失败' });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: '项目不存在' });
    return;
  }
  try {
    await deleteProject(project.id, req.user!.id);
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '删除失败';
    const status = msg.includes('仅') ? 403 : 400;
    res.status(status).json({ error: msg });
  }
});

/** 申请加入项目（私有项目不允许未知用户探测存在性） */
router.post('/:id/join', authMiddleware, (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: '项目不存在' });
    return;
  }
  const role = getProjectRole(project.id, req.user!.id);
  if (role) {
    res.status(409).json({ error: '你已是项目成员' });
    return;
  }
  // 私有项目：仅当知道有效的加入码/被邀请时才可申请；此处对非公开项目直接拒绝，
  // 避免任何人拿 id 探测私有项目并发起无限申请
  if (project.visibility !== 'public') {
    res.status(403).json({ error: '该项目未公开，无法申请加入（请联系项目负责人邀请）' });
    return;
  }
  try {
    const application = createApplication(req.user!.id, {
      type: 'join_project',
      projectId: project.id,
      payload: { role: 'developer', message: req.body?.message },
    });
    res.status(201).json({ application, message: '已提交加入申请，等待项目负责人审批' });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '提交失败' });
  }
});

/** 负责人手动添加成员 */
router.post('/:id/members', authMiddleware, (req, res) => {
  const projectId = req.params.id;
  if (!isProjectOwner(projectId, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '仅项目负责人可添加成员' });
    return;
  }
  const { userQuery, role } = req.body as { userQuery?: string; role?: string };
  if (!userQuery?.trim()) {
    res.status(400).json({ error: '请填写用户邮箱 / 用户名 / ID' });
    return;
  }
  const user = findUserByEmailOrId(userQuery);
  if (!user) {
    res.status(404).json({ error: '未找到用户（对方需先登录过本平台）' });
    return;
  }
  const r = role === 'viewer' || role === 'developer' || role === 'owner' ? role : 'developer';
  if (r === 'owner') {
    res.status(400).json({ error: '不能直接添加为 owner' });
    return;
  }
  try {
    addProjectMember(projectId, user.id, r);
    res.json({ members: listProjectMembers(projectId) });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '添加失败' });
  }
});

/** 负责人调整成员角色 */
router.put('/:id/members/:userId/role', authMiddleware, (req, res) => {
  const projectId = req.params.id;
  if (!isProjectOwner(projectId, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '仅项目负责人可修改成员角色' });
    return;
  }
  const { role } = req.body as { role?: string };
  if (role !== 'developer' && role !== 'viewer') {
    res.status(400).json({ error: '角色仅支持 developer / viewer' });
    return;
  }
  if (!getProjectRole(projectId, req.params.userId)) {
    res.status(404).json({ error: '该用户不是项目成员' });
    return;
  }
  try {
    const project = getProject(projectId)!;
    if (project.ownerId === req.params.userId) {
      res.status(400).json({ error: '不能修改项目创建人的角色' });
      return;
    }
    addProjectMember(projectId, req.params.userId, role);
    res.json({ members: listProjectMembers(projectId) });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '更新失败' });
  }
});

/** 负责人配置成员可操作的模块范围（moduleIds=null 表示项目内全部模块） */
router.put('/:id/members/:userId/modules', authMiddleware, (req, res) => {
  const projectId = req.params.id;
  if (!isProjectOwner(projectId, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '仅项目负责人可配置成员模块权限' });
    return;
  }
  const { moduleIds } = req.body as { moduleIds?: string[] | null };
  if (moduleIds !== null && moduleIds !== undefined && !Array.isArray(moduleIds)) {
    res.status(400).json({ error: 'moduleIds 须为数组或 null' });
    return;
  }
  const ids = moduleIds === null || moduleIds === undefined ? null : moduleIds.map(String);
  try {
    setProjectMemberScope(projectId, req.params.userId, ids);
    res.json({
      members: listProjectMembers(projectId),
      moduleScope: getProjectMemberScope(projectId, req.params.userId),
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '更新失败' });
  }
});

router.delete('/:id/members/:userId', authMiddleware, (req, res) => {
  const projectId = req.params.id;
  if (!isProjectOwner(projectId, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    res.status(403).json({ error: '仅项目负责人可移除成员' });
    return;
  }
  try {
    removeProjectMember(projectId, req.params.userId);
    res.json({ members: listProjectMembers(projectId) });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '移除失败' });
  }
});

/** 创建模块：改为提交审批（负责人/管理员可在审核通过后创建；管理员+direct 可直建） */
router.post('/:id/modules', authMiddleware, (req, res) => {
  const projectId = req.params.id;
  const project = getProject(projectId);
  if (!project) {
    res.status(404).json({ error: '项目不存在' });
    return;
  }

  const { name, direct, pathMode } = req.body as {
    name?: string;
    direct?: boolean;
    pathMode?: string;
  };
  if (!name?.trim()) {
    res.status(400).json({ error: '模块名不能为空' });
    return;
  }

  // 负责人或管理员可直接创建（仍建议走审批；提供 direct 给负责人）
  const canDirect =
    (direct && (isProjectOwner(projectId, req.user!.id) || isPlatformAdmin(req.user!.id))) ||
    isPlatformAdmin(req.user!.id);

  if (canDirect && direct) {
    if (!canWriteProject(projectId, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
      res.status(403).json({ error: '无权操作' });
      return;
    }
    try {
      const mod = createModule(projectId, req.user!.id, { name, pathMode });
      res.status(201).json({ module: mod, direct: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : '创建失败' });
    }
    return;
  }

  if (!canReadProject(projectId, req.user!.id) && !isPlatformAdmin(req.user!.id)) {
    // 非成员也可申请？通常需先加入项目。允许提交 create_module 申请需是成员
    res.status(403).json({ error: '请先加入项目后再申请创建模块' });
    return;
  }

  try {
    const application = createApplication(req.user!.id, {
      type: 'create_module',
      projectId,
      payload: { name: name.trim(), pathMode },
    });
    res.status(201).json({
      application,
      message: '已提交创建模块申请，等待项目负责人审批',
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '提交失败' });
  }
});

export default router;

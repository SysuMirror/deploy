import { nanoid } from 'nanoid';
import { db } from '../db/init.js';
import type {
  Application,
  ApplicationStatus,
  ApplicationType,
  ProjectMemberRole,
} from '../types.js';
import {
  addProjectMember,
  addModuleMember,
  createModule,
  createProject,
  getModule,
  getProject,
  getProjectRole,
} from './project.js';
import { isPlatformAdmin } from './platform-admin.js';
import { getUserById } from './user.js';
import { writeAudit } from './audit.js';

type AppRow = {
  id: string;
  type: string;
  status: string;
  applicant_id: string;
  project_id: string | null;
  module_id: string | null;
  payload_json: string;
  review_note: string;
  reviewer_id: string | null;
  created_at: string;
  reviewed_at: string | null;
};

function mapApp(r: AppRow): Application {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(r.payload_json || '{}');
  } catch {
    payload = {};
  }
  const applicant = getUserById(r.applicant_id);
  const project = r.project_id ? getProject(r.project_id) : null;
  const mod = r.module_id ? getModule(r.module_id) : null;
  return {
    id: r.id,
    type: r.type as ApplicationType,
    status: r.status as ApplicationStatus,
    applicantId: r.applicant_id,
    projectId: r.project_id ?? undefined,
    moduleId: r.module_id ?? undefined,
    payload,
    reviewNote: r.review_note || '',
    reviewerId: r.reviewer_id ?? undefined,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at ?? undefined,
    applicantName: applicant?.name,
    projectName: project?.name,
    moduleName: mod?.name ?? (typeof payload.moduleName === 'string' ? payload.moduleName : undefined),
  };
}

export function createApplication(
  applicantId: string,
  data: {
    type: ApplicationType;
    projectId?: string;
    moduleId?: string;
    payload?: Record<string, unknown>;
  }
): Application {
  if (data.type === 'create_project') {
    const name = String(data.payload?.name ?? '').trim();
    if (!name) throw new Error('项目名称不能为空');
  }
  if (data.type === 'create_module') {
    if (!data.projectId) throw new Error('缺少项目');
    const name = String(data.payload?.name ?? '').trim();
    if (!name) throw new Error('模块名不能为空');
  }
  if (data.type === 'join_project' && !data.projectId) {
    throw new Error('缺少项目');
  }
  if (data.type === 'join_module' && !data.moduleId) {
    throw new Error('缺少模块');
  }
  if (data.type === 'minio_bucket') {
    if (!data.moduleId) throw new Error('缺少模块');
    const env = String(data.payload?.env ?? '');
    if (env !== 'test' && env !== 'prod') throw new Error('须指定 env=test|prod');
  }

  // 已是成员则不必重复申请
  if (data.type === 'join_project' && data.projectId) {
    if (getProjectRole(data.projectId, applicantId)) {
      throw new Error('你已是该项目成员');
    }
    // 私有项目不开放申请：避免任何人拿 id 探测私有项目并发起无限申请
    const project = getProject(data.projectId);
    if (!project) throw new Error('项目不存在');
    if (project.visibility !== 'public') {
      throw new Error('该项目未公开，无法申请加入（请联系项目负责人邀请）');
    }
  }
  if (data.type === 'join_module' && data.moduleId) {
    const mod = getModule(data.moduleId);
    if (!mod) throw new Error('模块不存在');
    data.projectId = mod.projectId;
    // 私有项目下的模块同样不开放申请
    const project = getProject(mod.projectId);
    if (project && project.visibility !== 'public') {
      throw new Error('所属项目未公开，无法申请加入（请联系项目负责人邀请）');
    }
  }

  const pending = db
    .prepare(
      `SELECT 1 FROM applications
       WHERE applicant_id = ? AND type = ? AND status = 'pending'
         AND IFNULL(project_id,'') = IFNULL(?, '')
         AND IFNULL(module_id,'') = IFNULL(?, '')
         AND (
           type != 'minio_bucket'
           OR json_extract(payload_json, '$.env') = json_extract(?, '$.env')
         )`
    )
    .get(
      applicantId,
      data.type,
      data.projectId ?? null,
      data.moduleId ?? null,
      JSON.stringify(data.payload ?? {})
    );
  if (pending) throw new Error('已有待审申请，请勿重复提交');

  const id = `app-${nanoid(12)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO applications
     (id, type, status, applicant_id, project_id, module_id, payload_json, created_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.type,
    applicantId,
    data.projectId ?? null,
    data.moduleId ?? null,
    JSON.stringify(data.payload ?? {}),
    now
  );
  const app = getApplication(id)!;
  const who = getUserById(applicantId)?.name || applicantId;
  writeAudit({
    action: 'application.create',
    actorId: applicantId,
    targetType: 'application',
    targetId: id,
    summary: `${who} 申请 ${data.type}${app.projectName ? ` · 项目 ${app.projectName}` : ''}${
      app.moduleName ? ` · 模块 ${app.moduleName}` : ''
    }`,
    meta: {
      type: data.type,
      projectId: data.projectId,
      moduleId: data.moduleId,
      payload: data.payload ?? {},
    },
  });
  return app;
}

export function getApplication(id: string): Application | null {
  const r = db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as AppRow | undefined;
  return r ? mapApp(r) : null;
}

export function listApplications(filter?: {
  status?: ApplicationStatus;
  projectId?: string;
  applicantId?: string;
  forAdmin?: boolean;
}): Application[] {
  let sql = 'SELECT * FROM applications WHERE 1=1';
  const params: unknown[] = [];
  if (filter?.status) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }
  if (filter?.projectId) {
    sql += ' AND project_id = ?';
    params.push(filter.projectId);
  }
  if (filter?.applicantId) {
    sql += ' AND applicant_id = ?';
    params.push(filter.applicantId);
  }
  sql += ' ORDER BY created_at DESC LIMIT 200';
  const rows = db.prepare(sql).all(...params) as AppRow[];
  return rows.map(mapApp);
}

/** 项目负责人可见：本项目相关待审；管理员可见全部 */
export function listReviewableApplications(userId: string): Application[] {
  if (isPlatformAdmin(userId)) {
    return listApplications({ status: 'pending' });
  }
  const rows = db
    .prepare(
      `SELECT a.* FROM applications a
       JOIN project_members pm ON pm.project_id = a.project_id
       WHERE a.status = 'pending'
         AND pm.user_id = ?
         AND pm.role = 'owner'
         AND a.type IN ('join_project', 'create_module', 'join_module')
       ORDER BY a.created_at DESC`
    )
    .all(userId) as AppRow[];
  return rows.map(mapApp);
}

function canReview(app: Application, reviewerId: string): boolean {
  if (isPlatformAdmin(reviewerId)) return true;
  if (app.type === 'create_project' || app.type === 'minio_bucket') return false;
  if (!app.projectId) return false;
  return getProjectRole(app.projectId, reviewerId) === 'owner';
}

export async function reviewApplication(
  appId: string,
  reviewerId: string,
  decision: 'approved' | 'rejected',
  note?: string
): Promise<Application> {
  const app = getApplication(appId);
  if (!app) throw new Error('申请不存在');
  if (app.status !== 'pending') throw new Error('申请已处理');
  if (!canReview(app, reviewerId)) throw new Error('无权审核该申请');

  if (decision === 'approved') {
    await applyApproval(app, reviewerId);
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE applications SET status = ?, review_note = ?, reviewer_id = ?, reviewed_at = ? WHERE id = ?`
  ).run(decision, note?.trim() ?? '', reviewerId, now, appId);

  const updated = getApplication(appId)!;
  const reviewer = getUserById(reviewerId)?.name || reviewerId;
  const applicant = updated.applicantName || updated.applicantId;
  writeAudit({
    action: decision === 'approved' ? 'application.approve' : 'application.reject',
    actorId: reviewerId,
    targetType: 'application',
    targetId: appId,
    summary: `${reviewer} ${decision === 'approved' ? '通过' : '拒绝'} ${applicant} 的 ${updated.type} 申请`,
    meta: {
      type: updated.type,
      decision,
      note: note?.trim() || '',
      applicantId: updated.applicantId,
      projectId: updated.projectId,
      moduleId: updated.moduleId,
    },
  });
  return updated;
}

async function applyApproval(app: Application, reviewerId: string) {
  // 角色只接受白名单值，避免任意字符串写进 project_members.role
  const requestedRole = String(app.payload.role ?? '');
  const role: ProjectMemberRole =
    requestedRole === 'viewer' ? 'viewer' : 'developer';

  switch (app.type) {
    case 'create_project': {
      createProject(app.applicantId, {
        name: String(app.payload.name ?? ''),
        description: String(app.payload.description ?? ''),
        visibility: String(app.payload.visibility ?? 'private'),
      });
      break;
    }
    case 'join_project': {
      if (!app.projectId) throw new Error('申请缺少项目');
      addProjectMember(app.projectId, app.applicantId, role);
      break;
    }
    case 'create_module': {
      if (!app.projectId) throw new Error('申请缺少项目');
      createModule(app.projectId, app.applicantId, {
        name: String(app.payload.name ?? ''),
        pathMode: String(app.payload.pathMode ?? ''),
      });
      break;
    }
    case 'join_module': {
      if (!app.moduleId) throw new Error('申请缺少模块');
      const mod = getModule(app.moduleId);
      if (!mod) throw new Error('模块不存在');
      addModuleMember(app.moduleId, app.applicantId, 'developer');
      if (!getProjectRole(mod.projectId, app.applicantId)) {
        addProjectMember(mod.projectId, app.applicantId, 'viewer');
      }
      break;
    }
    case 'minio_bucket': {
      if (!app.moduleId) throw new Error('申请缺少模块');
      const mod = getModule(app.moduleId);
      if (!mod) throw new Error('模块不存在');
      const env = String(app.payload.env) as 'test' | 'prod';
      const { isSseinfraRuntime, SseinfraClient } = await import('./sseinfra-client.js');
      if (!isSseinfraRuntime()) {
        throw new Error('当前非 sseinfra 运行时，无法自动建桶');
      }
      const client = new SseinfraClient();
      const result = await client.provisionModuleObjectStorage(mod.name, env);
      const { upsertModuleObjectStorage } = await import('./module-object-storage.js');
      upsertModuleObjectStorage({
        moduleId: mod.id,
        env,
        bucket: result.bucket,
        keyLabel: result.group,
        status: 'provisioned',
        lastError: '',
      });
      writeAudit({
        action: 'sseinfra.minio.provision',
        actorId: reviewerId,
        targetType: 'module',
        targetId: mod.id,
        summary: `为模块 ${mod.name}/${env} 建桶 ${result.bucket}（标签=${result.group}；删组不删桶）`,
        meta: result,
      });
      break;
    }
    default:
      throw new Error(`未知申请类型`);
  }
}

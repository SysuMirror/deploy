/**
 * 对象存储同步任务：异步执行 + 可轮询进度（阶段 / 百分比 / 日志）。
 */
import { nanoid } from 'nanoid';
import type { DeployEnv, Module } from '../types.js';
import { syncHistoryDataToBucket } from './minio-sync.js';

export type MinioSyncPhase =
  | 'queued'
  | 'ensure'
  | 'check_group'
  | 'push_host'
  | 'creds'
  | 'upload'
  | 'done'
  | 'failed';

export type MinioSyncJob = {
  id: string;
  moduleId: string;
  moduleName: string;
  env: DeployEnv;
  status: 'running' | 'success' | 'failed';
  phase: MinioSyncPhase;
  phaseLabel: string;
  percent: number;
  logs: string[];
  error: string;
  result: { bucket: string; files: number; bytes: number; skipped: string[] } | null;
  startedAt: string;
  finishedAt: string | null;
};

const jobs = new Map<string, MinioSyncJob>();
const MAX_JOBS = 40;

const PHASE_LABEL: Record<MinioSyncPhase, string> = {
  queued: '排队中',
  ensure: '确保桶与密钥',
  check_group: '检查组状态',
  push_host: '推送宿主机数据到 Pod',
  creds: '读取密钥并注入环境',
  upload: '上传文件到 MinIO 桶',
  done: '完成',
  failed: '失败',
};

function trimJobs() {
  if (jobs.size <= MAX_JOBS) return;
  const sorted = [...jobs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const j of sorted.slice(0, jobs.size - MAX_JOBS)) {
    if (j.status !== 'running') jobs.delete(j.id);
  }
}

function setPhase(job: MinioSyncJob, phase: MinioSyncPhase, percent: number) {
  job.phase = phase;
  job.phaseLabel = PHASE_LABEL[phase];
  job.percent = Math.max(0, Math.min(100, Math.round(percent)));
}

function appendLog(job: MinioSyncJob, line: string) {
  job.logs.push(line);
  if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
  // 从迁移日志里抠粗略推送进度
  const m = line.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*MB/);
  if (job.phase === 'push_host' && m) {
    const cur = Number(m[1]);
    const tot = Number(m[2]);
    if (tot > 0) {
      job.percent = Math.min(54, 18 + Math.floor((cur / tot) * 36));
    }
  }
}

export function getMinioSyncJob(jobId: string): MinioSyncJob | null {
  return jobs.get(jobId) ?? null;
}

/** 同模块+环境最新任务（优先 running，便于页面重进后恢复进度） */
export function findLatestMinioSyncJob(
  moduleId: string,
  env: DeployEnv
): MinioSyncJob | null {
  const list = [...jobs.values()].filter((j) => j.moduleId === moduleId && j.env === env);
  if (!list.length) return null;
  const running = list
    .filter((j) => j.status === 'running')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (running[0]) return running[0];
  return list.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
}

export function startMinioSyncJob(opts: {
  mod: Module;
  env: DeployEnv;
  actorId: string | null;
  pushHostData?: boolean;
}): MinioSyncJob {
  const existing = findLatestMinioSyncJob(opts.mod.id, opts.env);
  if (existing?.status === 'running') {
    return existing;
  }

  const id = nanoid(12);
  const job: MinioSyncJob = {
    id,
    moduleId: opts.mod.id,
    moduleName: opts.mod.name,
    env: opts.env,
    status: 'running',
    phase: 'queued',
    phaseLabel: PHASE_LABEL.queued,
    percent: 1,
    logs: [],
    error: '',
    result: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(id, job);
  trimJobs();

  setImmediate(() => {
    void (async () => {
      try {
        setPhase(job, 'ensure', 8);
        appendLog(job, '[进度] 开始同步任务');
        const result = await syncHistoryDataToBucket({
          mod: opts.mod,
          env: opts.env,
          actorId: opts.actorId,
          pushHostData: opts.pushHostData,
          log: (l) => appendLog(job, l),
          onProgress: (p) => {
            setPhase(job, p.phase, p.percent);
            if (!p.message) return;
            if (p.message.startsWith('[进度] 上传')) {
              const last = job.logs[job.logs.length - 1];
              if (last?.startsWith('[进度] 上传')) job.logs[job.logs.length - 1] = p.message;
              else appendLog(job, p.message);
              return;
            }
            appendLog(job, p.message);
          },
        });
        job.result = result;
        setPhase(job, 'done', 100);
        job.status = 'success';
        appendLog(
          job,
          `[进度] 完成：${result.files} 文件 / ${(result.bytes / 1024 / 1024).toFixed(2)}MB → ${result.bucket}`
        );
      } catch (e) {
        job.status = 'failed';
        job.phase = 'failed';
        job.phaseLabel = PHASE_LABEL.failed;
        job.error = e instanceof Error ? e.message : String(e);
        appendLog(job, `[进度] 失败：${job.error}`);
      } finally {
        job.finishedAt = new Date().toISOString();
      }
    })();
  });

  return job;
}

export function publicMinioSyncJob(job: MinioSyncJob) {
  return {
    id: job.id,
    moduleId: job.moduleId,
    moduleName: job.moduleName,
    env: job.env,
    status: job.status,
    phase: job.phase,
    phaseLabel: job.phaseLabel,
    percent: job.percent,
    logs: job.logs,
    error: job.error,
    result: job.result,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

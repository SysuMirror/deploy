/**
 * 模块对象存储（MinIO）绑定：桶随模块生命周期，删组不删桶。
 */
import { db } from '../db/init.js';
import type { DeployEnv } from '../types.js';
import { sseinfraGroupName } from './sseinfra-client.js';

export type ModuleObjectStorage = {
  moduleId: string;
  env: DeployEnv;
  bucket: string;
  keyLabel: string;
  status: 'none' | 'provisioned' | 'synced' | 'orphaned';
  lastSyncAt: string | null;
  lastSyncBytes: number;
  lastSyncFiles: number;
  lastError: string;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  module_id: string;
  env: string;
  bucket: string;
  key_label: string;
  status: string;
  last_sync_at: string | null;
  last_sync_bytes: number;
  last_sync_files: number;
  last_error: string;
  created_at: string;
  updated_at: string;
};

function mapRow(r: Row): ModuleObjectStorage {
  return {
    moduleId: r.module_id,
    env: r.env as DeployEnv,
    bucket: r.bucket,
    keyLabel: r.key_label,
    status: r.status as ModuleObjectStorage['status'],
    lastSyncAt: r.last_sync_at,
    lastSyncBytes: r.last_sync_bytes || 0,
    lastSyncFiles: r.last_sync_files || 0,
    lastError: r.last_error || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 桶名与组名一致（test/prod 分桶），但删组时绝不删桶 */
export function moduleBucketName(moduleName: string, env: DeployEnv): string {
  return sseinfraGroupName(moduleName, env);
}

export function getModuleObjectStorage(
  moduleId: string,
  env: DeployEnv
): ModuleObjectStorage | null {
  const r = db
    .prepare(`SELECT * FROM module_object_storage WHERE module_id = ? AND env = ?`)
    .get(moduleId, env) as Row | undefined;
  return r ? mapRow(r) : null;
}

export function listModuleObjectStorage(moduleId: string): ModuleObjectStorage[] {
  const rows = db
    .prepare(
      `SELECT * FROM module_object_storage WHERE module_id = ? ORDER BY env ASC`
    )
    .all(moduleId) as Row[];
  return rows.map(mapRow);
}

export function upsertModuleObjectStorage(data: {
  moduleId: string;
  env: DeployEnv;
  bucket: string;
  keyLabel: string;
  status?: ModuleObjectStorage['status'];
  lastSyncAt?: string | null;
  lastSyncBytes?: number;
  lastSyncFiles?: number;
  lastError?: string;
}): ModuleObjectStorage {
  const now = new Date().toISOString();
  const existing = getModuleObjectStorage(data.moduleId, data.env);
  if (!existing) {
    db.prepare(
      `INSERT INTO module_object_storage
       (module_id, env, bucket, key_label, status, last_sync_at, last_sync_bytes, last_sync_files, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      data.moduleId,
      data.env,
      data.bucket,
      data.keyLabel,
      data.status ?? 'provisioned',
      data.lastSyncAt ?? null,
      data.lastSyncBytes ?? 0,
      data.lastSyncFiles ?? 0,
      data.lastError ?? '',
      now,
      now
    );
  } else {
    db.prepare(
      `UPDATE module_object_storage SET
         bucket = ?, key_label = ?,
         status = COALESCE(?, status),
         last_sync_at = COALESCE(?, last_sync_at),
         last_sync_bytes = COALESCE(?, last_sync_bytes),
         last_sync_files = COALESCE(?, last_sync_files),
         last_error = COALESCE(?, last_error),
         updated_at = ?
       WHERE module_id = ? AND env = ?`
    ).run(
      data.bucket,
      data.keyLabel,
      data.status ?? null,
      data.lastSyncAt !== undefined ? data.lastSyncAt : null,
      data.lastSyncBytes !== undefined ? data.lastSyncBytes : null,
      data.lastSyncFiles !== undefined ? data.lastSyncFiles : null,
      data.lastError !== undefined ? data.lastError : null,
      now,
      data.moduleId,
      data.env
    );
  }
  return getModuleObjectStorage(data.moduleId, data.env)!;
}

/** 删模块时：标记 orphaned，绝不调 MinIO 删桶 */
export function markModuleBucketsOrphaned(moduleId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE module_object_storage SET status = 'orphaned', updated_at = ? WHERE module_id = ?`
  ).run(now, moduleId);
}

export function listOrphanedBuckets(): ModuleObjectStorage[] {
  const rows = db
    .prepare(`SELECT * FROM module_object_storage WHERE status = 'orphaned' ORDER BY updated_at DESC`)
    .all() as Row[];
  return rows.map(mapRow);
}

/**
 * 将宿主机 MODULE_DATA（历史图/文件）同步到模块 MinIO 桶。
 * 经组 Pod 上传（Pod 可访问集群内 MinIO）；删组不删桶。
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { DeployEnv, Module } from '../types.js';
import { getModuleDataDir, moduleDataDirExists } from './module-data.js';
import {
  getModuleObjectStorage,
  moduleBucketName,
  upsertModuleObjectStorage,
} from './module-object-storage.js';
import {
  runOnGpu,
  syncHostDataToPod,
  resolveGroupPod,
} from './sseinfra-pod.js';
import { SseinfraClient, sseinfraGroupName, isSseinfraRuntime } from './sseinfra-client.js';
import { writeAudit } from './audit.js';

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const ENDPOINT = 'http://minio.platform-infra.svc.cluster.local:9000';

export const MINIO_CLUSTER_ENDPOINT = ENDPOINT;

/** 从面板或 GPU minio_keys.json 解析密钥（面板优先，不依赖跳板） */
export async function resolveModuleMinioCreds(
  mod: Module,
  env: DeployEnv,
  log?: (l: string) => void
): Promise<{ accessKey: string; secret: string; bucket: string; source: 'panel' | 'gpu_json' } | null> {
  const group = sseinfraGroupName(mod.name, env);
  const binding = getModuleObjectStorage(mod.id, env);
  const fallbackBucket = binding?.bucket || moduleBucketName(mod.name, env);

  if (isSseinfraRuntime()) {
    try {
      const client = new SseinfraClient();
      const panelKeys = await client.findStorageKeysByLabel(group);
      if (panelKeys.length) {
        const k = panelKeys[0];
        return {
          accessKey: k.accessKey,
          secret: k.secret,
          bucket: k.bucket || fallbackBucket,
          source: 'panel',
        };
      }
      log?.(`[minio] 面板未找到标签=${group} 的密钥`);
    } catch (e) {
      log?.(`[minio] 读面板密钥失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const gpu = await loadMinioCredsForLabel(group, log || (() => undefined));
  if (gpu) {
    return {
      accessKey: gpu.accessKey,
      secret: gpu.secret,
      bucket: gpu.bucket || fallbackBucket,
      source: 'gpu_json',
    };
  }
  return null;
}

export async function getModuleObjectStorageCredentials(mod: Module, env: DeployEnv) {
  const group = sseinfraGroupName(mod.name, env);
  const binding = getModuleObjectStorage(mod.id, env);
  const bucket = binding?.bucket || moduleBucketName(mod.name, env);
  const creds = await resolveModuleMinioCreds(mod, env);
  let panelKeys: Array<{ label: string; bucket: string; accessKey: string; secret: string }> = [];
  if (isSseinfraRuntime()) {
    try {
      const client = new SseinfraClient();
      panelKeys = await client.findStorageKeysByLabel(group);
    } catch {
      /* ignore */
    }
  }
  return {
    keyLabel: group,
    bucket,
    endpoint: ENDPOINT,
    endpointNote: '集群内地址；应用 Pod 内通过 MINIO_ENDPOINT 使用',
    found: Boolean(creds),
    source: creds?.source ?? null,
    credentials: creds
      ? {
          accessKey: creds.accessKey,
          secret: creds.secret,
          bucket: creds.bucket,
        }
      : null,
    keysForLabel: panelKeys.map((k) => ({
      label: k.label,
      bucket: k.bucket,
      accessKey: k.accessKey,
      secret: k.secret,
    })),
    injectVars: creds
      ? {
          MINIO_ENDPOINT: ENDPOINT,
          MINIO_ACCESS_KEY: creds.accessKey,
          MINIO_SECRET: creds.secret,
          MINIO_BUCKET: creds.bucket,
        }
      : null,
  };
}

function approxDirStats(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(d, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else {
          files += 1;
          bytes += st.size;
        }
      } catch {
        /* skip */
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { files, bytes };
}

/** 从 WZ8 平台侧读取密钥（不写日志明文） */
async function loadMinioCredsForLabel(
  label: string,
  log: (l: string) => void
): Promise<{ accessKey: string; secret: string; bucket: string } | null> {
  const script = `
import json, os, glob
label = ${JSON.stringify(label)}
paths = glob.glob('/opt/student-platform/**/minio_keys.json', recursive=True)
paths += glob.glob('/opt/student-platform/**/data/**/minio_keys.json', recursive=True)
found = None
for p in paths:
  try:
    data = json.load(open(p))
  except Exception:
    continue
  items = data if isinstance(data, list) else data.get('keys') or data.get('items') or []
  if isinstance(data, dict) and not items:
    items = list(data.values()) if all(isinstance(v, dict) for v in data.values()) else []
  for k in items:
    if not isinstance(k, dict):
      continue
    lab = (k.get('label') or k.get('name') or '').strip()
    if lab.lower() == label.lower():
      found = {
        'access_key': k.get('access_key') or k.get('accessKey') or '',
        'secret': k.get('secret') or k.get('secret_key') or k.get('secretKey') or '',
        'bucket': k.get('bucket') or '',
      }
      break
  if found:
    break
print(json.dumps(found or {}))
`;
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const r = await runOnGpu(
    `echo ${b64} | base64 -d | sudo python3 -`,
    log,
    { timeoutMs: 60_000, quiet: true }
  );
  try {
    const j = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}') as {
      access_key?: string;
      secret?: string;
      bucket?: string;
    };
    if (j.access_key && j.secret) {
      return { accessKey: j.access_key, secret: j.secret, bucket: j.bucket || '' };
    }
  } catch {
    /* ignore */
  }
  log('[minio-sync] 未能从平台 minio_keys.json 解析密钥（请确认已发密钥且标签=组名）');
  return null;
}

/**
 * 确保桶+密钥存在并写入绑定；不删除任何已有桶。
 */
export async function ensureModuleBucket(
  mod: Module,
  env: DeployEnv,
  actorId: string | null,
  log: (l: string) => void
): Promise<{ bucket: string; keyLabel: string }> {
  const group = sseinfraGroupName(mod.name, env);
  const bucket = moduleBucketName(mod.name, env);
  log(`[minio] 确保桶 ${bucket}（标签=${group}）；策略：删组不删桶，随模块保留`);
  const client = new SseinfraClient();
  await client.login();
  const result = await client.provisionModuleObjectStorage(mod.name, env);
  upsertModuleObjectStorage({
    moduleId: mod.id,
    env,
    bucket: result.bucket,
    keyLabel: result.group,
    status: 'provisioned',
    lastError: '',
  });
  writeAudit({
    action: 'sseinfra.minio.ensure',
    actorId,
    targetType: 'module',
    targetId: mod.id,
    summary: `确保模块 ${mod.name}/${env} 对象存储桶 ${result.bucket}`,
    meta: result,
  });
  return { bucket: result.bucket, keyLabel: result.group };
}

/**
 * 同步历史 MODULE_DATA → MinIO 桶（经组 Pod 上传）。
 */
export async function syncHistoryDataToBucket(opts: {
  mod: Module;
  env: DeployEnv;
  actorId: string | null;
  log: (l: string) => void;
  /** 先把宿主机 MODULE_DATA 同步进 Pod /home/cloud/data */
  pushHostData?: boolean;
  onProgress?: (p: {
    phase: 'ensure' | 'check_group' | 'push_host' | 'creds' | 'upload' | 'done';
    percent: number;
    message?: string;
  }) => void;
}): Promise<{
  bucket: string;
  files: number;
  bytes: number;
  skipped: string[];
}> {
  const { mod, env, actorId, log } = opts;
  const progress = opts.onProgress;
  const group = sseinfraGroupName(mod.name, env);
  const bucket = moduleBucketName(mod.name, env);
  const hostDir = getModuleDataDir(mod.name, env);

  const existing = getModuleObjectStorage(mod.id, env);
  if (!existing || existing.status === 'none' || existing.status === 'orphaned') {
    throw new Error('请先「申请对象存储」并等待管理员审批通过后再同步');
  }

  progress?.({ phase: 'ensure', percent: 8 });
  // 已审批：幂等补全桶/密钥（不再对未开通用户开放）
  await ensureModuleBucket(mod, env, actorId, log);

  progress?.({ phase: 'check_group', percent: 15 });
  const client = new SseinfraClient();
  await client.login();
  const g = await client.getGroup(group);
  if (!g.exists || !g.running) {
    throw new Error(`组 ${group} 未 Running，请先部署该环境后再同步到桶`);
  }

  if (opts.pushHostData !== false && moduleDataDirExists(mod.name, env)) {
    const st = approxDirStats(hostDir);
    progress?.({ phase: 'push_host', percent: 18 });
    log(
      `[minio-sync] 宿主机 MODULE_DATA ${hostDir} 约 ${st.files} 文件 / ${(st.bytes / 1024 / 1024).toFixed(1)}MB → Pod`
    );
    if (st.bytes > 32) {
      await syncHostDataToPod({ group, localDir: hostDir, log });
    } else {
      log('[minio-sync] 宿主机数据几乎为空，跳过推 Pod（将尝试同步 Pod 内已有 /home/cloud/data）');
    }
  } else {
    log('[minio-sync] 未推宿主机数据，直接同步 Pod /home/cloud/data');
  }

  progress?.({ phase: 'creds', percent: 58 });
  const creds = await resolveModuleMinioCreds(mod, env, log);
  if (!creds) {
    throw new Error(
      '无法读取 MinIO 密钥。请确认已按组名发密钥，或在本页「连接凭证」查看'
    );
  }
  const targetBucket = creds.bucket || bucket;

  // 注意：setEnvMany 常会重建 Pod，必须在「推数据 + 上传」之后再写，
  // 否则刚写入 /home/cloud/data 会随旧 Pod 丢失。上传用脚本内联凭证即可。

  progress?.({ phase: 'upload', percent: 68, message: '[进度] 开始在 Pod 内上传到 MinIO…' });
  const pod = await resolveGroupPod(group, log);
  const endpointHost = ENDPOINT.replace(/^https?:\/\//, '');
  log(`[minio-sync] 在 Pod ${pod} 内上传 /home/cloud/data → 桶 ${targetBucket} …`);

  const syncPyFinal = `
import os, sys, json, subprocess
root = "/home/cloud/data"
endpoint = ${JSON.stringify(endpointHost)}
secure = False
ak = ${JSON.stringify(creds.accessKey)}
sk = ${JSON.stringify(creds.secret)}
bucket = ${JSON.stringify(targetBucket)}
skip_names = {".jwt_secret", "imagebed.db", "deploy.db"}
skip_suffix = (".db", ".db-wal", ".db-shm")
prog = "/tmp/sdpy-minio-sync.prog"

def write_prog(obj):
  try:
    open(prog, "w").write(json.dumps(obj))
  except Exception:
    pass
  print(json.dumps(obj), flush=True)

def ensure_minio():
  try:
    from minio import Minio
    return Minio
  except ImportError:
    pass
  # Debian/Ubuntu PEP668：需要 --break-system-packages。
  # 容器内以 root 运行 → 优先系统级安装（/usr/local，保证在 sys.path）。
  # --user 曾出现装到 ~/.local 却 import 不到的情况，作为兜底并保留诊断。
  last_err = ""
  install_cmds = [
    [sys.executable, "-m", "pip", "install", "-q", "--break-system-packages", "minio"],
    [sys.executable, "-m", "pip", "install", "--user", "-q", "--break-system-packages", "minio"],
  ]
  for cmd in install_cmds:
    try:
      r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
      if r.returncode == 0:
        from minio import Minio
        return Minio
      last_err = ((r.stderr or "") + (r.stdout or "")).strip()[-800:]
    except Exception as e:
      last_err = str(e)[-800:]
  raise RuntimeError("pip install minio 失败: " + last_err)

Minio = ensure_minio()
client = Minio(endpoint, access_key=ak, secret_key=sk, secure=secure)
uploaded = 0
nbytes = 0
skipped = []
if not os.path.isdir(root):
  write_prog({"ok": False, "error": "no data dir", "files": 0, "bytes": 0, "skipped": []})
  sys.exit(0)
all_files = []
for dirpath, _, files in os.walk(root):
  for name in files:
    if name in skip_names or name.endswith(skip_suffix):
      skipped.append(name)
      continue
    all_files.append(os.path.join(dirpath, name))
total = len(all_files)
write_prog({"progress": True, "total": total, "files": 0, "bytes": 0})
for full in all_files:
  rel = os.path.relpath(full, root).replace(chr(92), "/")
  try:
    sz = os.path.getsize(full)
    client.fput_object(bucket, rel, full)
    uploaded += 1
    nbytes += sz
  except Exception as e:
    skipped.append(rel + ":" + str(e)[:80])
  if uploaded % 10 == 0 or uploaded == total:
    write_prog({"progress": True, "total": total, "files": uploaded, "bytes": nbytes})
write_prog({"ok": True, "files": uploaded, "bytes": nbytes, "skipped": skipped[:30], "bucket": bucket})
`;
  const pyB64Final = Buffer.from(syncPyFinal, 'utf8').toString('base64');
  const innerFinal = `echo ${pyB64Final} | base64 -d | python3 -`;

  let uploadPoll: ReturnType<typeof setInterval> | null = null;
  uploadPoll = setInterval(() => {
    void (async () => {
      try {
        const st = await runOnGpu(
          `sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n students exec ${pod} -- cat /tmp/sdpy-minio-sync.prog 2>/dev/null || true`,
          undefined,
          { timeoutMs: 20_000, quiet: true }
        );
        const line = (st.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
        if (!line) return;
        const j = JSON.parse(line) as {
          progress?: boolean;
          total?: number;
          files?: number;
          bytes?: number;
        };
        if (j.progress && (j.total || 0) > 0) {
          const ratio = Math.min(1, (j.files || 0) / (j.total || 1));
          const pct = 68 + Math.floor(ratio * 27);
          progress?.({
            phase: 'upload',
            percent: pct,
            message: `[进度] 上传 ${j.files}/${j.total} 文件（${((j.bytes || 0) / 1024 / 1024).toFixed(1)}MB）`,
          });
        }
      } catch {
        /* ignore poll errors */
      }
    })();
  }, 4000);

  let execOut: { stdout: string; stderr: string };
  try {
    execOut = await runOnGpu(
      `sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n students exec ${pod} -- bash -lc ${shellQuote(innerFinal)}`,
      log,
      { timeoutMs: 1_800_000 }
    );
  } finally {
    if (uploadPoll) clearInterval(uploadPoll);
  }

  let files = 0;
  let bytes = 0;
  let skipped: string[] = [];
  try {
    const line = (execOut.stdout || '')
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.includes('"ok"'))
      .pop();
    const j = JSON.parse(line || '{}') as {
      ok?: boolean;
      files?: number;
      bytes?: number;
      skipped?: string[];
      error?: string;
    };
    if (j.error && !j.ok) throw new Error(j.error);
    files = j.files || 0;
    bytes = j.bytes || 0;
    skipped = j.skipped || [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    upsertModuleObjectStorage({
      moduleId: mod.id,
      env,
      bucket: targetBucket,
      keyLabel: group,
      status: 'provisioned',
      lastError: msg.slice(0, 500),
    });
    throw new Error(
      `同步结果解析失败: ${msg}; stdout=${(execOut.stdout || '').slice(0, 400)}`
    );
  }

  upsertModuleObjectStorage({
    moduleId: mod.id,
    env,
    bucket: targetBucket,
    keyLabel: group,
    status: 'synced',
    lastSyncAt: new Date().toISOString(),
    lastSyncBytes: bytes,
    lastSyncFiles: files,
    lastError: '',
  });
  writeAudit({
    action: 'sseinfra.minio.sync',
    actorId,
    targetType: 'module',
    targetId: mod.id,
    summary: `同步 ${mod.name}/${env} 历史数据 → 桶 ${targetBucket}（${files} 文件 / ${(bytes / 1024 / 1024).toFixed(1)}MB）`,
    meta: { bucket: targetBucket, files, bytes, skippedCount: skipped.length },
  });

  // 上传完成后再注入 env（可能重建 Pod；数据已在桶内，不依赖本机目录）
  try {
    await client.setEnvMany(group, {
      MINIO_ENDPOINT: ENDPOINT,
      MINIO_ACCESS_KEY: creds.accessKey,
      MINIO_SECRET: creds.secret,
      MINIO_BUCKET: targetBucket,
    });
    log('[minio-sync] 已写入组环境 MINIO_*（密钥不落日志；可能触发 Pod 重建）');
  } catch (e) {
    log(
      `[minio-sync] 写组 env 失败（桶已同步，可稍后手动注入）: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  progress?.({ phase: 'done', percent: 100 });
  log(
    `[minio-sync] 完成：${files} 文件 / ${(bytes / 1024 / 1024).toFixed(2)}MB → ${targetBucket}`
  );
  return { bucket: targetBucket, files, bytes, skipped };
}

export function getObjectStorageStatus(mod: Module, env: DeployEnv) {
  const binding = getModuleObjectStorage(mod.id, env);
  const hostDir = getModuleDataDir(mod.name, env);
  const host = moduleDataDirExists(mod.name, env)
    ? approxDirStats(hostDir)
    : { files: 0, bytes: 0 };
  return {
    env,
    group: sseinfraGroupName(mod.name, env),
    bucket: binding?.bucket || moduleBucketName(mod.name, env),
    keyLabel: binding?.keyLabel || sseinfraGroupName(mod.name, env),
    binding,
    hostDataDir: hostDir,
    hostFiles: host.files,
    hostApproxBytes: host.bytes,
    policy: {
      deleteWithGroup: false,
      deleteWithModule: false,
      note: '对象存储桶随模块保留；释放 K8s 组或删除模块时默认不删桶',
    },
  };
}

export type BucketObjectRow = {
  key: string;
  size: number;
  lastModified: string | null;
  etag?: string;
};

/**
 * 列出桶内对象（经 gpu 访问集群内 MinIO；需已审批并已有密钥）。
 * prefix 可选；最多返回 limit 条（默认 200，上限 500）。
 */
export async function listModuleBucketObjects(opts: {
  mod: Module;
  env: DeployEnv;
  prefix?: string;
  limit?: number;
  log?: (l: string) => void;
}): Promise<{
  bucket: string;
  prefix: string;
  truncated: boolean;
  objects: BucketObjectRow[];
  totalListed: number;
}> {
  const { mod, env } = opts;
  const log = opts.log || (() => undefined);
  const binding = getModuleObjectStorage(mod.id, env);
  if (!binding || binding.status === 'none' || binding.status === 'orphaned') {
    throw new Error('桶尚未开通或已失效，请先申请并通过审批');
  }
  const group = sseinfraGroupName(mod.name, env);
  const creds = await resolveModuleMinioCreds(mod, env, log);
  if (!creds) {
    throw new Error('无法读取 MinIO 密钥，请在本页「连接凭证」查看或联系管理员按组名发密钥');
  }
  const bucket = creds.bucket || binding.bucket || moduleBucketName(mod.name, env);
  const prefix = (opts.prefix || '').replace(/^\//, '');
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);

  const script = `
import json, sys
endpoint = ${JSON.stringify(ENDPOINT.replace(/^https?:\/\//, ''))}
secure = ${ENDPOINT.startsWith('https') ? 'True' : 'False'}
ak = ${JSON.stringify(creds.accessKey)}
sk = ${JSON.stringify(creds.secret)}
bucket = ${JSON.stringify(bucket)}
prefix = ${JSON.stringify(prefix)}
limit = ${limit}

def ensure_minio():
  try:
    from minio import Minio
    return Minio
  except Exception:
    pass
  import subprocess
  last = ''
  for cmd in (
    [sys.executable, '-m', 'pip', 'install', '-q', '--break-system-packages', 'minio'],
    [sys.executable, '-m', 'pip', 'install', '--user', '-q', '--break-system-packages', 'minio'],
  ):
    try:
      subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
      from minio import Minio
      return Minio
    except Exception as e:
      last = str(e)
  raise RuntimeError('pip install minio 失败: ' + last)

Minio = ensure_minio()
client = Minio(endpoint, access_key=ak, secret_key=sk, secure=secure)
objs = []
truncated = False
n = 0
for o in client.list_objects(bucket, prefix=prefix or None, recursive=True):
  n += 1
  if len(objs) >= limit:
    truncated = True
    break
  lm = getattr(o, 'last_modified', None)
  objs.append({
    'key': o.object_name,
    'size': int(getattr(o, 'size', 0) or 0),
    'lastModified': lm.isoformat() if lm is not None else None,
    'etag': getattr(o, 'etag', None) or '',
  })
print(json.dumps({'objects': objs, 'truncated': truncated, 'totalListed': n, 'bucket': bucket}))
`;
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const r = await runOnGpu(`echo ${b64} | base64 -d | sudo python3 -`, log, {
    timeoutMs: 120_000,
    quiet: true,
  });
  const line = (r.stdout || '').trim().split('\n').pop() || '{}';
  let parsed: {
    objects?: BucketObjectRow[];
    truncated?: boolean;
    totalListed?: number;
    bucket?: string;
  };
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`列出桶对象失败：${(r.stderr || r.stdout || '').slice(0, 300)}`);
  }
  return {
    bucket: parsed.bucket || bucket,
    prefix,
    truncated: Boolean(parsed.truncated),
    objects: parsed.objects || [],
    totalListed: parsed.totalListed ?? (parsed.objects || []).length,
  };
}

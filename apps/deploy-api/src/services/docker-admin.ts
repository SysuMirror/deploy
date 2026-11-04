import { spawn } from 'child_process';
import type {
  DockerContainerInfo,
  DockerDiskUsageRow,
  DockerImageInfo,
  DockerNetworkInfo,
  DockerSystemInfo,
  DockerVolumeInfo,
} from '../types.js';
import { regenerateNginxRoutes } from './routing.js';

function runDocker(args: string[], timeoutMs = 30000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`docker ${args[0]} 超时`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parseIso(s?: string | null): string | undefined {
  if (!s || s.startsWith('0001')) return undefined;
  try {
    return new Date(s).toISOString();
  } catch {
    return undefined;
  }
}

/** docker 的 Labels 以逗号分隔的 key=value 输出；解析为对象 */
function parseDockerLabels(raw?: string): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!raw) return labels;
  for (const part of raw.split(',')) {
    const i = part.indexOf('=');
    if (i > 0) labels[part.slice(0, i)] = part.slice(i + 1);
  }
  return labels;
}

/** 解析 docker 的人类可读大小（如 1.23GB / 500MB / 0B）为字节数，用于排序 */
function parseSizeToBytes(s?: string): number {
  if (!s) return 0;
  const m = /^([\d.]+)\s*([KMGT]?i?B)$/i.exec(s.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase().replace('I', '');
  const mult: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  return Math.round(n * (mult[unit] ?? 1));
}

function uptimeSeconds(startedAt?: string, finishedAt?: string, running?: boolean): number | undefined {
  if (!startedAt) return undefined;
  const start = new Date(startedAt).getTime();
  const end = running ? Date.now() : finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, Math.floor((end - start) / 1000));
}

export async function listDockerContainers(): Promise<DockerContainerInfo[]> {
  const { code, stdout, stderr } = await runDocker(['ps', '-a', '--format', '{{json .}}']);
  if (code !== 0) {
    throw new Error(stderr.trim() || 'docker ps 失败，请确认本机/容器内可执行 docker');
  }

  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const basic = lines.map((line) => {
    const row = JSON.parse(line) as {
      ID: string;
      Names: string;
      Image: string;
      Status: string;
      State: string;
      CreatedAt: string;
      Labels?: string;
    };
    const name = (row.Names || '').replace(/^\//, '');
    const labels = parseDockerLabels(row.Labels);
    const composeProject =
      labels['com.docker.compose.project'] || labels['com.docker.compose.project.working_dir'];
    const isSdpy =
      name.startsWith('sdpy-') ||
      Boolean(composeProject?.startsWith('sdpy-')) ||
      name.includes('sdpy');

    return {
      id: row.ID,
      name,
      image: row.Image,
      status: row.Status,
      state: row.State,
      createdAt: row.CreatedAt,
      labels,
      composeProject,
      isSdpy,
    };
  });

  // inspect 补齐启动时间 / 结束时间（并行限流）
  const enriched: DockerContainerInfo[] = [];
  const chunk = 20;
  for (let i = 0; i < basic.length; i += chunk) {
    const slice = basic.slice(i, i + chunk);
    const details = await Promise.all(
      slice.map(async (c) => {
        try {
          const ins = await runDocker(['inspect', c.id, '--format', '{{json .}}']);
          if (ins.code !== 0) return { ...c } as DockerContainerInfo;
          const info = JSON.parse(ins.stdout) as {
            State?: {
              Status?: string;
              StartedAt?: string;
              FinishedAt?: string;
              Running?: boolean;
            };
            Created?: string;
          };
          const startedAt = parseIso(info.State?.StartedAt);
          const finishedAt = parseIso(info.State?.FinishedAt);
          const running = Boolean(info.State?.Running);
          return {
            ...c,
            createdAt: parseIso(info.Created) || c.createdAt,
            startedAt,
            finishedAt: running ? undefined : finishedAt,
            uptimeSeconds: uptimeSeconds(startedAt, finishedAt, running),
            // 无访问日志时用 startedAt 近似；前端可标注
            lastCallAt: running ? startedAt : finishedAt,
          } satisfies DockerContainerInfo;
        } catch {
          return { ...c } as DockerContainerInfo;
        }
      })
    );
    enriched.push(...details);
  }

  enriched.sort((a, b) => {
    if (a.isSdpy !== b.isSdpy) return a.isSdpy ? -1 : 1;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
  return enriched;
}

function containerModuleMatch(c: DockerContainerInfo, moduleNames: Set<string>): boolean {
  if (!c.isSdpy) return false;
  const cp = c.composeProject || '';
  for (const m of moduleNames) {
    if (cp === `sdpy-test-${m}` || cp === `sdpy-prod-${m}`) return true;
    if (c.name === m) return true;
    if (c.name.startsWith(`sdpy-test-${m}-`) || c.name.startsWith(`sdpy-prod-${m}-`)) return true;
  }
  return false;
}

/** 从全量容器中筛出属于指定模块集合的 sdpy 容器（供非管理员按项目隔离） */
export function filterContainersByModules(
  containers: DockerContainerInfo[],
  moduleNames: string[]
): DockerContainerInfo[] {
  const set = new Set(moduleNames);
  return containers.filter((c) => containerModuleMatch(c, set));
}

export async function removeContainers(ids: string[]): Promise<{ removed: string[]; errors: string[] }> {
  const removed: string[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed) continue;
    try {
      const r = await runDocker(['rm', '-f', trimmed]);
      if (r.code === 0) removed.push(trimmed);
      else errors.push(`${trimmed}: ${r.stderr.trim() || '删除失败'}`);
    } catch (e) {
      errors.push(`${trimmed}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { removed, errors };
}

/** 容器启停类操作（start / stop / restart），逐个执行并汇总成败 */
async function runContainerAction(
  verb: 'start' | 'stop' | 'restart',
  ids: string[],
  timeoutMs = 60000
): Promise<{ ok: string[]; errors: string[] }> {
  const ok: string[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed) continue;
    try {
      const r = await runDocker([verb, trimmed], timeoutMs);
      if (r.code === 0) ok.push(trimmed);
      else errors.push(`${trimmed}: ${r.stderr.trim() || `${verb} 失败`}`);
    } catch (e) {
      errors.push(`${trimmed}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok, errors };
}

export function startContainers(ids: string[]) {
  return runContainerAction('start', ids);
}

export function stopContainers(ids: string[]) {
  return runContainerAction('stop', ids);
}

export function restartContainers(ids: string[]) {
  return runContainerAction('restart', ids);
}

/** 清空已退出 / 无用容器（默认仅 sdpy- 相关；all=true 则 docker container prune） */
export async function pruneUnusedContainers(opts?: {
  onlySdpy?: boolean;
  includeRunning?: boolean;
}): Promise<{ removed: string[]; errors: string[] }> {
  const onlySdpy = opts?.onlySdpy !== false;
  const list = await listDockerContainers();
  const targets = list.filter((c) => {
    if (onlySdpy && !c.isSdpy) return false;
    if (opts?.includeRunning) return true;
    return c.state !== 'running' && c.state !== 'restarting';
  });
  return removeContainers(targets.map((c) => c.id));
}

/** 清理未被任何容器引用的悬空镜像（dangling） */
export async function pruneDockerImages(): Promise<{ message: string; reclaimed: string }> {
  const r = await runDocker(['image', 'prune', '-f'], 180000);
  if (r.code !== 0) {
    throw new Error(r.stderr.trim() || '清理镜像失败，请确认本机可执行 docker');
  }
  return { message: '已清理无用镜像', reclaimed: r.stdout.trim() };
}

/** 清理 Docker 构建缓存（含中间层） */
export async function pruneDockerBuildCache(): Promise<{ message: string; reclaimed: string }> {
  const r = await runDocker(['builder', 'prune', '-f'], 180000);
  if (r.code !== 0) {
    throw new Error(r.stderr.trim() || '清理构建缓存失败，请确认本机可执行 docker');
  }
  return { message: '已清理构建缓存', reclaimed: r.stdout.trim() };
}

// —— 镜像 ——

export async function listDockerImages(): Promise<DockerImageInfo[]> {
  const { code, stdout, stderr } = await runDocker(['images', '--format', '{{json .}}']);
  if (code !== 0) {
    throw new Error(stderr.trim() || 'docker images 失败，请确认本机可执行 docker');
  }

  const images = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as {
          ID?: string;
          Repository?: string;
          Tag?: string;
          Digest?: string;
          Size?: string;
          CreatedSince?: string;
          CreatedAt?: string | number;
        };
      } catch {
        return null;
      }
    })
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => {
      const repository = r.Repository || '<none>';
      const tag = r.Tag || '<none>';
      const digest = r.Digest && r.Digest !== '<none>' ? r.Digest : undefined;
      const createdAtIso =
        typeof r.CreatedAt === 'number' ? new Date(r.CreatedAt * 1000).toISOString() : r.CreatedAt;
      return {
        id: (r.ID || '').replace(/^sha256:/, ''),
        repository,
        tag,
        digest,
        size: r.Size || '0B',
        sizeBytes: parseSizeToBytes(r.Size),
        createdAt: parseIso(createdAtIso),
        createdSince: r.CreatedSince || '—',
        dangling: repository === '<none>' && tag === '<none>',
      } satisfies DockerImageInfo;
    });

  images.sort(
    (a, b) =>
      b.sizeBytes - a.sizeBytes ||
      `${a.repository}:${a.tag}`.localeCompare(`${b.repository}:${b.tag}`)
  );
  return images;
}

export async function removeImages(ids: string[]): Promise<{ removed: string[]; errors: string[] }> {
  const removed: string[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed) continue;
    try {
      const r = await runDocker(['rmi', '-f', trimmed], 180000);
      if (r.code === 0) removed.push(trimmed);
      else errors.push(`${trimmed}: ${r.stderr.trim() || '删除失败'}`);
    } catch (e) {
      errors.push(`${trimmed}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { removed, errors };
}

// —— 数据卷 ——

export async function listDockerVolumes(): Promise<DockerVolumeInfo[]> {
  const { code, stdout, stderr } = await runDocker(['volume', 'ls', '--format', '{{json .}}']);
  if (code !== 0) {
    throw new Error(stderr.trim() || 'docker volume ls 失败');
  }

  const volumes: DockerVolumeInfo[] = [];
  for (const line of stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)) {
    try {
      const r = JSON.parse(line) as {
        Name?: string;
        Driver?: string;
        Mountpoint?: string;
        Labels?: string;
        CreatedAt?: string;
      };
      const name = r.Name || '';
      volumes.push({
        name,
        driver: r.Driver || 'local',
        mountpoint: r.Mountpoint || '',
        labels: parseDockerLabels(r.Labels),
        createdAt: parseIso(r.CreatedAt),
        isSdpy: name.toLowerCase().includes('sdpy'),
      });
    } catch {
      // 忽略无法解析的行
    }
  }

  volumes.sort((a, b) => a.name.localeCompare(b.name));
  return volumes;
}

export async function removeVolumes(
  names: string[]
): Promise<{ removed: string[]; errors: string[] }> {
  const removed: string[] = [];
  const errors: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    try {
      const r = await runDocker(['volume', 'rm', trimmed]);
      if (r.code === 0) removed.push(trimmed);
      else errors.push(`${trimmed}: ${r.stderr.trim() || '删除失败（可能仍被容器占用）'}`);
    } catch (e) {
      errors.push(`${trimmed}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { removed, errors };
}

export async function pruneDockerVolumes(): Promise<{ message: string; reclaimed: string }> {
  const r = await runDocker(['volume', 'prune', '-f'], 180000);
  if (r.code !== 0) {
    throw new Error(r.stderr.trim() || '清理数据卷失败');
  }
  return { message: '已清理无主数据卷', reclaimed: r.stdout.trim() };
}

// —— 网络 ——

export async function listDockerNetworks(): Promise<DockerNetworkInfo[]> {
  const { code, stdout, stderr } = await runDocker(['network', 'ls', '--format', '{{json .}}']);
  if (code !== 0) {
    throw new Error(stderr.trim() || 'docker network ls 失败');
  }

  const networks: DockerNetworkInfo[] = [];
  for (const line of stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)) {
    try {
      const r = JSON.parse(line) as {
        ID?: string;
        Name?: string;
        Driver?: string;
        Scope?: string;
        IPv6?: string | boolean;
        Internal?: string | boolean;
        Labels?: string;
        CreatedAt?: string;
      };
      const name = r.Name || '';
      networks.push({
        id: (r.ID || '').replace(/^sha256:/, ''),
        name,
        driver: r.Driver || 'bridge',
        scope: r.Scope || 'local',
        ipv6: r.IPv6 === 'true' || r.IPv6 === true,
        internal: r.Internal === 'true' || r.Internal === true,
        labels: parseDockerLabels(r.Labels),
        createdAt: parseIso(r.CreatedAt),
        isSdpy: name.toLowerCase().includes('sdpy'),
      });
    } catch {
      // 忽略无法解析的行
    }
  }

  networks.sort((a, b) => a.name.localeCompare(b.name));
  return networks;
}

export async function removeNetworks(
  names: string[]
): Promise<{ removed: string[]; errors: string[] }> {
  const removed: string[] = [];
  const errors: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    try {
      const r = await runDocker(['network', 'rm', trimmed]);
      if (r.code === 0) removed.push(trimmed);
      else errors.push(`${trimmed}: ${r.stderr.trim() || '删除失败（可能仍被容器使用）'}`);
    } catch (e) {
      errors.push(`${trimmed}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { removed, errors };
}

export async function pruneDockerNetworks(): Promise<{ message: string; reclaimed: string }> {
  const r = await runDocker(['network', 'prune', '-f'], 180000);
  if (r.code !== 0) {
    throw new Error(r.stderr.trim() || '清理网络失败');
  }
  return { message: '已清理未使用网络', reclaimed: r.stdout.trim() };
}

// —— 系统概览（磁盘占用 + 守护进程 / 主机信息） ——

export async function listDockerSystemDf(): Promise<DockerDiskUsageRow[]> {
  const { code, stdout, stderr } = await runDocker(['system', 'df', '--format', '{{json .}}']);
  if (code !== 0) {
    throw new Error(stderr.trim() || 'docker system df 失败');
  }

  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const r = JSON.parse(line) as {
          Type?: string;
          TotalCount?: number;
          Active?: number;
          Size?: string;
          Reclaimable?: string;
        };
        const size = r.Size || '0B';
        const reclaimable = r.Reclaimable || '0B (0%)';
        return {
          type: r.Type || '',
          totalCount: r.TotalCount ?? 0,
          active: r.Active ?? 0,
          size,
          reclaimable,
          sizeBytes: parseSizeToBytes(size),
          reclaimableBytes: parseSizeToBytes((reclaimable.split(/\s/)[0] || '0B')),
        } satisfies DockerDiskUsageRow;
      } catch {
        return null;
      }
    })
    .filter((r): r is DockerDiskUsageRow => Boolean(r));
}

export async function listDockerSystemInfo(): Promise<DockerSystemInfo> {
  const { code, stdout, stderr } = await runDocker(['info', '--format', '{{json .}}']);
  if (code !== 0) {
    throw new Error(stderr.trim() || 'docker info 失败');
  }
  const info = JSON.parse(stdout) as {
    Name?: string;
    ServerVersion?: string;
    OperatingSystem?: string;
    Architecture?: string;
    NCPU?: number;
    MemTotal?: number;
    Containers?: number;
    ContainersRunning?: number;
    ContainersStopped?: number;
    Images?: number;
    DockerRootDir?: string;
  };
  return {
    name: info.Name || '—',
    serverVersion: info.ServerVersion || '—',
    operatingSystem: info.OperatingSystem || '—',
    architecture: info.Architecture || '—',
    ncpu: info.NCPU ?? 0,
    memTotalBytes: info.MemTotal ?? 0,
    containers: info.Containers ?? 0,
    containersRunning: info.ContainersRunning ?? 0,
    containersStopped: info.ContainersStopped ?? 0,
    images: info.Images ?? 0,
    dockerRootDir: info.DockerRootDir,
  };
}

export async function reloadGateway(): Promise<{ ok: boolean; message: string }> {
  try {
    regenerateNginxRoutes((line) => {
      console.log('[gateway]', line);
    });
    const cmd = process.env.GATEWAY_RELOAD_CMD?.trim();
    if (!cmd) {
      return { ok: true, message: '已重写 modules.conf（未配置 GATEWAY_RELOAD_CMD，请手动 reload nginx）' };
    }
    // regenerateNginxRoutes 已异步触发 reload；再显式跑一次确保
    await new Promise<void>((resolve, reject) => {
      const isWin = process.platform === 'win32';
      const child = spawn(isWin ? 'cmd.exe' : 'sh', isWin ? ['/c', cmd] : ['-c', cmd]);
      let err = '';
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(err.trim() || `reload 退出码 ${code}`));
      });
    });
    return { ok: true, message: '已重写路由并 reload 网关' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

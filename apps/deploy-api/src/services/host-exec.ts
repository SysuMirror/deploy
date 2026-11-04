/**
 * 宿主机执行原语 —— 「在宿主命名空间里跑一条命令并拿回输出」。
 *
 * 为什么需要它：
 *   deploy-api 是非特权容器，只挂了 sse-sdpy 自己的目录，容器里的 `/root/SSE_Market`
 *   是镜像内的另一个目录（inode 与宿主不同），`/root/SSE_Market/iWiki` 之类根本不存在。
 *   所以在 Node 进程里做 `fs.realpath` / `fs.existsSync` 判断宿主路径是**错的** ——
 *   要么恒为「不存在」，要么看到的是容器的文件系统。
 *
 *   任何「宿主路径是否合法 / 指向哪里」的判断，都必须进宿主挂载命名空间去做，
 *   否则校验看到的和执行看到的不是同一个文件系统。
 *
 * 机制与脚本执行完全一致（也共用 helperContainerArgs，避免两条路径漂移）：
 *
 *   docker run --rm --name sdpy-check-xxx --pid=host --privileged <image> \
 *     nsenter -t 1 -m -u -i -n -p -- sh -c "<script>"
 */
import { execFile, type ExecException } from 'node:child_process';
import { nanoid } from 'nanoid';

export function runImage(): string {
  return process.env.SCRIPT_RUN_IMAGE?.trim() || 'busybox:latest';
}

/** 组装「一次性特权容器 + nsenter 进宿主命名空间」的 docker 参数 */
export function helperContainerArgs(opts: { name: string; script: string }): string[] {
  return [
    'run',
    '--rm',
    '--name',
    opts.name,
    '--pid=host',
    '--privileged',
    runImage(),
    'nsenter',
    '-t',
    '1',
    '-m',
    '-u',
    '-i',
    '-n',
    '-p',
    '--',
    'sh',
    '-c',
    opts.script,
  ];
}

/** 单引号转义，供拼接宿主 shell 命令使用 */
function shq(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

export type HostCapture = { code: number; stdout: string; stderr: string };

/**
 * 在宿主命名空间里跑一条命令并缓冲输出。
 *
 * 与 script-runner 的流式执行分开：这里只需要一次性的短命令（校验、探测），
 * 所以要的是「跑完拿结果」，不是「边跑边推给前端」。
 */
export function runOnHostCapture(script: string, timeoutMs = 20000): Promise<HostCapture> {
  const name = `sdpy-check-${nanoid(10)}`;
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      helperContainerArgs({ name, script }),
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const e = err as ExecException;
        // execFile 超时/被杀：容器可能没自己退干净，尽力收尸再报错
        if (e.killed) {
          execFile('docker', ['rm', '-f', name], () =>
            reject(new Error(`宿主命令超时（${timeoutMs}ms）`))
          );
          return;
        }
        if (typeof e.code === 'number') {
          // 命令跑了但退出码非 0：交给调用方看 stdout/stderr
          resolve({ code: e.code, stdout, stderr });
          return;
        }
        reject(new Error(`无法启动宿主校验容器：${e.message}`));
      }
    );
  });
}

/** 白名单目录里是否包含某个（已解析的）绝对路径 */
export function isInside(path: string, roots: string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(`${r}/`));
}

/**
 * 在**宿主机上**解析根目录的真实路径，并确认它落在白名单内。
 *
 * 为什么必须解析：
 *   `validateWorkdir` 只做纯字符串规范化（挡得住 `..` 穿越），但挡不住白名单目录内
 *   的符号链接指向外面 —— 例如 `/root/SSE_Market/xxx/link → /etc`，
 *   字符串前缀看起来完全合法，`cd` 进去却在白名单之外。
 *
 * 一次容器调用同时探测「白名单根」和「目标目录」（而不是各起一个容器）：
 *   - 根目录自己也解析一遍：配置里写 `/root/SSE_Market` 而它本身是软链时，
 *     只有解析后比对才是对的；
 *   - 目标目录不存在时明确区分出来，让调用方能提示「目录不存在」而不是笼统的越界。
 *
 * @returns 解析后的绝对路径（调用方应落库这个值，而不是用户原始输入）
 */
export async function resolveWorkdirOnHost(workdir: string, roots: string[]): Promise<string> {
  const targets = [...roots, workdir];
  // 用 \t 分隔并带类型标记：readlink -f 的结果里不会有制表符，切分安全
  const script = [
    `for p in ${targets.map(shq).join(' ')}; do`,
    '  if [ -d "$p" ]; then',
    '    r=$(readlink -f "$p" 2>/dev/null)',
    '    printf \'D\\t%s\\t%s\\n\' "$p" "$r"',
    '  else',
    '    printf \'N\\t%s\\t\\n\' "$p"',
    '  fi',
    'done',
  ].join('\n');

  const res = await runOnHostCapture(script);
  if (res.code !== 0) {
    // 探测脚本本身不会失败，非 0 说明 docker / nsenter / 镜像有问题 → 失败关闭，
    // 不放行未经校验的目录（执行同样依赖这套机制，这里不通也跑不了脚本）
    const detail = (res.stderr || res.stdout || '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
    throw new Error(`无法在宿主机上校验根目录（执行器不可用）：${detail || '未知错误'}`);
  }

  const parsed = new Map<string, string | null>();
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [kind, orig, resolved] = line.split('\t');
    if (!orig) continue;
    parsed.set(orig, kind === 'D' && resolved ? resolved : null);
  }

  // 白名单根：解析成功就用解析值，没解析出来就退回字面量（配置写错时至少不静默放行）
  const resolvedRoots = roots.map((r) => parsed.get(r) ?? r.replace(/\/+$/, ''));
  const resolvedWorkdir = parsed.get(workdir);

  if (!resolvedWorkdir) {
    throw new Error(`根目录不存在：${workdir}（请先在宿主机上创建该目录）`);
  }
  if (!isInside(resolvedWorkdir, resolvedRoots)) {
    throw new Error(
      `根目录解析后不在允许范围内：${workdir} → ${resolvedWorkdir}（允许：${resolvedRoots.join('、')}）`
    );
  }
  return resolvedWorkdir;
}

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { db, getBaseDomain } from '../db/init.js';
import { getNginxDir, getPublicBasePath } from '../config/paths.js';
import { listEnabledDomainsForGateway } from './module-domains.js';
import type { DeployEnv, ModulePublicUrls } from '../types.js';

/** 不可用作模块名的保留段（与平台 SPA / 根路径模式冲突） */
export const RESERVED_MODULE_NAMES = new Set([
  'test',
  'api',
  'oauth',
  'login',
  'projects',
  'modules',
  'assets',
  'console',
  'admin',
  'health',
  'healthz',
  '_platform',
  'sdpy',
  'sdpy-api',
  'favicon.ico',
]);

export function composeProjectName(moduleName: string, env: DeployEnv): string {
  return `sdpy-${env}-${moduleName}`;
}

/** 模块挂载路径模式：'root' 根路径 / 'subpath' /sdpy 前缀 / 'domain' 仅子域名 / '' 跟随平台默认 */
export type ModulePathMode = 'root' | 'subpath' | 'domain' | '';

/** 是否「仅子域名」访问（不出 /{module}、/test/{module} 路径路由） */
export function isDomainOnlyMode(pathMode?: string): boolean {
  return (pathMode ?? '') === 'domain';
}

/** 计算某模块的挂载基路径：显式 root / subpath 优先，否则跟随平台默认 */
export function moduleBasePath(pathMode?: string): string {
  if (pathMode === 'root') return '';
  if (pathMode === 'subpath') return '/sdpy';
  if (pathMode === 'domain') return getPublicBasePath();
  return getPublicBasePath();
}

export function buildPathPrefix(
  moduleName: string,
  env: DeployEnv,
  kind: 'web' | 'api',
  pathMode?: string
): string {
  const base = moduleBasePath(pathMode); // '' = 根路径模式
  if (env === 'test') {
    return kind === 'web' ? `${base}/test/${moduleName}` : `${base}/test/${moduleName}-api`;
  }
  return kind === 'web' ? `${base}/${moduleName}` : `${base}/${moduleName}-api`;
}

export function buildPublicUrl(
  moduleName: string,
  env: DeployEnv,
  kind: 'web' | 'api' = 'web',
  pathMode?: string
): string {
  const domain = getBaseDomain();
  const prefix = buildPathPrefix(moduleName, env, kind, pathMode);
  return `https://${domain}${prefix}`;
}

export function buildModulePublicUrls(moduleName: string, pathMode?: string): ModulePublicUrls {
  return {
    test: buildPublicUrl(moduleName, 'test', 'web', pathMode),
    testApi: buildPublicUrl(moduleName, 'test', 'api', pathMode),
    prod: buildPublicUrl(moduleName, 'prod', 'web', pathMode),
    prodApi: buildPublicUrl(moduleName, 'prod', 'api', pathMode),
  };
}

/** 仅子域名模式下的默认访问域名：prod={module}.base，test=test.{module}.base */
export function defaultModuleHost(moduleName: string, env: DeployEnv): string {
  const base = getBaseDomain();
  return env === 'test' ? `test.${moduleName}.${base}` : `${moduleName}.${base}`;
}

export function buildLocalUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function resolveAccessUrl(
  moduleName: string,
  env: DeployEnv,
  kind: 'web' | 'api',
  port: number,
  pathMode?: string
): string {
  return process.env.NODE_ENV === 'production'
    ? buildPublicUrl(moduleName, env, kind, pathMode)
    : buildLocalUrl(port);
}

/**
 * 从 sseinfra 组页 Web（如 http://ssemarket.cn:23002）解析 frp 宿主机端口，
 * 供平台网关 modules.conf 反代；用户访问仍用 /sdpy/{模块} 路径。
 */
export function parseFrpWebPort(webUrl: string): number {
  const u = parseFrpWebUrl(webUrl);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (!Number.isFinite(port) || port <= 0) throw new Error(`无法从组 Web 地址解析端口: ${webUrl}`);
  if (port === 80 || port === 443) {
    throw new Error(`组 Web 无独立端口（像是面板而非 frp）: ${webUrl}`);
  }
  return port;
}

/** 解析组 Web 地址的 hostname（供部署后就绪探测用） */
export function parseFrpWebHost(webUrl: string): string {
  return parseFrpWebUrl(webUrl).hostname;
}

function parseFrpWebUrl(webUrl: string): URL {
  const raw = (webUrl || '').trim();
  if (!raw) throw new Error('组 Web 地址为空，无法解析 frp 端口');
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch (e) {
    throw new Error(`无法解析组 Web 地址: ${raw}（${e instanceof Error ? e.message : String(e)}）`);
  }
}

export interface RouteEntry {
  moduleName: string;
  pathMode?: string;
  testWebPort?: number;
  testApiPort?: number;
  prodWebPort?: number;
  prodApiPort?: number;
}

export function listActiveRoutes(): RouteEntry[] {
  const rows = db
    .prepare(
      `SELECT name,
              path_mode as pathMode,
              active_test_web_port as testWebPort,
              active_test_api_port as testApiPort,
              active_prod_web_port as prodWebPort,
              active_prod_api_port as prodApiPort,
              active_test_port as legacyTestPort,
              active_prod_port as legacyProdPort
       FROM modules
       WHERE active_test_web_port IS NOT NULL
          OR active_test_api_port IS NOT NULL
          OR active_prod_web_port IS NOT NULL
          OR active_prod_api_port IS NOT NULL
          OR active_test_port IS NOT NULL
          OR active_prod_port IS NOT NULL`
    )
    .all() as Array<{
    name: string;
    pathMode: string | null;
    testWebPort: number | null;
    testApiPort: number | null;
    prodWebPort: number | null;
    prodApiPort: number | null;
    legacyTestPort: number | null;
    legacyProdPort: number | null;
  }>;

  return rows.map((r) => ({
    moduleName: r.name,
    pathMode: r.pathMode ?? '',
    testWebPort: r.testWebPort ?? r.legacyTestPort ?? undefined,
    testApiPort: r.testApiPort ?? undefined,
    prodWebPort: r.prodWebPort ?? r.legacyProdPort ?? undefined,
    prodApiPort: r.prodApiPort ?? undefined,
  }));
}

const PROXY_HEADERS = [
  '  proxy_http_version 1.1;',
  '  proxy_set_header Host $host;',
  '  proxy_set_header X-Real-IP $remote_addr;',
  '  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
  '  proxy_set_header X-Forwarded-Proto $scheme;',
  '  proxy_set_header Upgrade $http_upgrade;',
  '  proxy_set_header Connection $connection_upgrade;',
].join('\n');

/** Host server 常挂在 conf.d（可能早于主配置 map），避免依赖 $connection_upgrade */
const PROXY_HEADERS_HOST = [
  '  proxy_http_version 1.1;',
  '  proxy_set_header Host $host;',
  '  proxy_set_header X-Real-IP $remote_addr;',
  '  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
  '  proxy_set_header X-Forwarded-Proto $scheme;',
  '  proxy_set_header Upgrade $http_upgrade;',
  '  proxy_set_header Connection "";',
].join('\n');

/** 网关容器内访问宿主机端口时用 host.docker.internal；宿主机跑网关则用 127.0.0.1 */
export function gatewayUpstreamHost(): string {
  return (process.env.GATEWAY_UPSTREAM_HOST || '127.0.0.1').trim() || '127.0.0.1';
}

/**
 * frp 上游协议：跳板机 frp 对外端口可能经 nginx ssl 化（listen <port> ssl → 内部 frps），
 * 此时网关必须用 https 连上游，否则明文 HTTP 打 TLS 端口会 400。
 * 由 GATEWAY_UPSTREAM_SCHEME 控制（http/https），默认 http 保持旧行为。
 */
export function gatewayUpstreamScheme(): 'http' | 'https' {
  const s = (process.env.GATEWAY_UPSTREAM_SCHEME || 'http').trim().toLowerCase();
  return s === 'https' ? 'https' : 'http';
}

function locationBlock(pathPrefix: string, port: number): string {
  const upstream = gatewayUpstreamHost();
  const scheme = gatewayUpstreamScheme();
  return [
    `location = ${pathPrefix} { return 301 ${pathPrefix}/; }`,
    `location ${pathPrefix}/ {`,
    `  proxy_pass ${scheme}://${upstream}:${port}/;`,
    PROXY_HEADERS,
    '}',
    '',
  ].join('\n');
}

function nginxModulesContent(routes: RouteEntry[]): string {
  const blocks: string[] = [
    '# Auto-generated by SSE Deploy — module location blocks only',
    `# Updated: ${new Date().toISOString()}`,
    '# Include inside server {} of platform gateway / 公共 nginx 主站 443。',
    '',
  ];

  for (const r of routes) {
    // 「仅子域名」模式：不生成路径路由，访问只走 Host server（module_domains）
    if (isDomainOnlyMode(r.pathMode)) continue;
    if (r.testWebPort) {
      blocks.push(locationBlock(buildPathPrefix(r.moduleName, 'test', 'web', r.pathMode), r.testWebPort));
    }
    if (r.testApiPort) {
      blocks.push(locationBlock(buildPathPrefix(r.moduleName, 'test', 'api', r.pathMode), r.testApiPort));
    }
    if (r.prodWebPort) {
      blocks.push(locationBlock(buildPathPrefix(r.moduleName, 'prod', 'web', r.pathMode), r.prodWebPort));
    }
    if (r.prodApiPort) {
      blocks.push(locationBlock(buildPathPrefix(r.moduleName, 'prod', 'api', r.pathMode), r.prodApiPort));
    }
  }

  return blocks.join('\n');
}

/** 通配符证书（*.ssemarket.cn，只覆盖单级子域名） */
function wildcardCert(): string {
  return (
    process.env.GATEWAY_SSL_CERT?.trim() ||
    '/etc/letsencrypt/live/ssemarket.cn/fullchain.pem'
  );
}

function wildcardKey(): string {
  return (
    process.env.GATEWAY_SSL_KEY?.trim() ||
    '/etc/letsencrypt/live/ssemarket.cn/privkey.pem'
  );
}

function letsEncryptLiveDir(): string {
  return process.env.LETSENCRYPT_LIVE_DIR?.trim() || '/etc/letsencrypt/live';
}

/**
 * 通配符证书只覆盖 `<label>.base` 单级子域名；
 * 多级（如 test.image.ssemarket.cn）须为该 host 单独签发。
 */
export function hostCoveredByWildcard(host: string): boolean {
  const base = getBaseDomain().toLowerCase();
  const h = host.toLowerCase();
  if (h === base) return true;
  if (!h.endsWith(`.${base}`)) return false;
  return !h.slice(0, -(base.length + 1)).includes('.');
}

/** 该 host 应使用的证书路径：有独立证书用独立的，否则退回通配符 */
export function certPathsForHost(host: string): { cert: string; key: string } {
  if (!hostCoveredByWildcard(host)) {
    const cert = join(letsEncryptLiveDir(), host.toLowerCase(), 'fullchain.pem');
    const key = join(letsEncryptLiveDir(), host.toLowerCase(), 'privkey.pem');
    if (existsSync(cert) && existsSync(key)) return { cert, key };
  }
  return { cert: wildcardCert(), key: wildcardKey() };
}

/**
 * 子域名 / 自定义域名：完整 server {}，须 include 在公共 nginx 的 http {} 内
 *（与 cloud.ssemarket.cn / sso 并列），不能塞进主站 server。
 * gray_match_* 暂写入注释，后续用 map/$http_ 做灰度分流。
 */
function nginxHostServersContent(): string {
  const domains = listEnabledDomainsForGateway();
  const upstream = gatewayUpstreamHost();
  const lines: string[] = [
    '# Auto-generated by SSE Deploy — Host-based module servers',
    `# Updated: ${new Date().toISOString()}`,
    '# Include inside http {}（现网：挂载到 /etc/nginx/conf.d/sdpy-modules-hosts.conf）。',
    '# 勿 include 进主站 server{}；勿重复定义 map $connection_upgrade。',
    '',
  ];

  for (const d of domains) {
    const { cert, key } = certPathsForHost(d.host);
    if (!d.upstreamPort) {
      lines.push(`# skip ${d.host} — module ${d.moduleName} [${d.env}] 尚未部署（无上游端口）`);
      lines.push('');
      continue;
    }
    const grayNote =
      d.grayMatchType && d.grayMatchType !== 'none'
        ? `# TODO gray: type=${d.grayMatchType} key=${d.grayMatchKey} value=${d.grayMatchValue}`
        : '# gray: none';
    lines.push(`# module=${d.moduleName} env=${d.env} kind=${d.kind} ${grayNote}`);
    lines.push('server {');
    lines.push('  listen 80;');
    lines.push(`  server_name ${d.host};`);
    lines.push('  location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; }');
    lines.push('  location / { return 301 https://$host$request_uri; }');
    lines.push('}');
    lines.push('');
    lines.push('server {');
    lines.push('  listen 443 ssl;');
    lines.push('  http2 on;');
    lines.push(`  server_name ${d.host};`);
    lines.push(`  ssl_certificate     ${cert};`);
    lines.push(`  ssl_certificate_key ${key};`);
    lines.push('  ssl_protocols TLSv1.2 TLSv1.3;');
    lines.push('  client_max_body_size 200m;');
    lines.push('  location / {');
    lines.push(
      `    proxy_pass ${gatewayUpstreamScheme()}://${upstream}:${d.upstreamPort}/;`
    );
    lines.push(PROXY_HEADERS_HOST);
    lines.push('  }');
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

export function getGatewayModulesPath(): string {
  return join(getNginxDir(), 'modules.conf');
}

/** Host 路由文件：公共 nginx http {} include */
export function getGatewayHostsPath(): string {
  return join(getNginxDir(), 'modules-hosts.conf');
}

export function regenerateNginxRoutes(log?: (line: string) => void): void {
  const routes = listActiveRoutes();
  const modulesPath = getGatewayModulesPath();
  const hostsPath = getGatewayHostsPath();
  mkdirSync(dirname(modulesPath), { recursive: true });
  const body = nginxModulesContent(routes);
  writeFileSync(modulesPath, body, 'utf8');
  log?.(`已更新平台网关模块路由: ${modulesPath} (${routes.length} 个模块)`);

  const hostsBody = nginxHostServersContent();
  writeFileSync(hostsPath, hostsBody, 'utf8');
  const hostCount = (hostsBody.match(/^server \{/gm) || []).length / 2;
  log?.(
    `已更新 Host 路由: ${hostsPath}（约 ${Math.floor(hostCount)} 个域名；须在公共 nginx http{} include）`
  );

  const locs = [...body.matchAll(/^location (= )?(\/\S+)/gm)].map((m) => m[2]);
  if (locs.length) {
    log?.(`[gateway] locations: ${locs.slice(0, 12).join(' ')}${locs.length > 12 ? ' …' : ''}`);
  }
  log?.(
    `[gateway] 公共 nginx：主站 server include modules.conf；http{} include modules-hosts.conf`
  );

  const reloadCmd = process.env.GATEWAY_RELOAD_CMD?.trim();
  if (reloadCmd) {
    runShell(reloadCmd, log).catch((e) => {
      log?.(`[警告] 网关 reload 失败: ${e instanceof Error ? e.message : String(e)}`);
    });
  } else {
    log?.('[警告] 未配置 GATEWAY_RELOAD_CMD，请手动 nginx -s reload');
  }
}

/**
 * 部署/路由更新后：为「多级子域名」补签证书（HTTP-01 需网关先放行 80 端口 ACME 路径）。
 * 有新证书时重写一次 Host 路由（换用新证书）并再次 reload。
 * 返回 true 表示证书状态有变化。
 */
export async function refreshGatewayCertificates(
  log?: (line: string) => void
): Promise<boolean> {
  const domains = listEnabledDomainsForGateway().filter((d) => d.upstreamPort);
  if (!domains.length) return false;
  const { ensureHostCertificates } = await import('./cert-issuer.js');
  const pending = domains.filter((d) => !hostCoveredByWildcard(d.host));
  if (pending.length) {
    // HTTP-01 需要网关先放行该 host 的 80 端口 ACME 路径：先同步 reload 一次
    const reloadCmd = process.env.GATEWAY_RELOAD_CMD?.trim();
    if (reloadCmd) {
      await runShell(reloadCmd, log).catch((e) => {
        log?.(`[警告] 网关 reload 失败: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }
  const changed = await ensureHostCertificates(
    domains.map((d) => d.host),
    (line) => log?.(line)
  );
  if (changed) {
    log?.('[cert] 证书有更新，重写网关 Host 路由并 reload…');
    writeFileSync(getGatewayHostsPath(), nginxHostServersContent(), 'utf8');
    const reloadCmd = process.env.GATEWAY_RELOAD_CMD?.trim();
    if (reloadCmd) {
      await runShell(reloadCmd, log).catch((e) => {
        log?.(`[警告] 网关 reload 失败: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }
  return changed;
}

function runShell(cmd: string, log?: (line: string) => void): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'cmd.exe' : 'sh', isWin ? ['/c', cmd] : ['-c', cmd], {
      cwd: getNginxDir(),
    });
    child.stdout.on('data', (d: Buffer) => log?.(d.toString().trim()));
    child.stderr.on('data', (d: Buffer) => log?.(d.toString().trim()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`命令退出码 ${code}`));
    });
  });
}

export async function stopComposeProject(
  projectName: string,
  cwd: string,
  log?: (line: string) => void
): Promise<void> {
  try {
    await runShellIn(cwd, `docker compose -p ${projectName} down --remove-orphans`, log);
  } catch {
    // may not exist
  }
}

function runShellIn(
  cwd: string,
  cmd: string,
  log?: (line: string) => void,
  opts?: { signal?: AbortSignal }
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'cmd.exe' : 'sh', isWin ? ['/c', cmd] : ['-c', cmd], { cwd });
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // 进程已退出
      }
    };
    if (opts?.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (line.trim()) log?.(line);
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (line.trim()) log?.(line);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      opts?.signal?.removeEventListener('abort', onAbort);
      if (aborted) {
        reject(new Error('已取消'));
        return;
      }
      if (code === 0) resolvePromise();
      else reject(new Error(`命令退出码 ${code}: ${cmd}`));
    });
  });
}

export { runShellIn as runShellCommand };

/**
 * 平台子域名证书：
 * - 通配符 *.ssemarket.cn 已覆盖单级子域名（image.ssemarket.cn）
 * - 多级子域名（test.image.ssemarket.cn）不在通配符内，须按 host 单独签发
 * 通过宿主机 docker 跑 certbot webroot（与 certbot-renew.sh 同一挂载约定），
 * HTTP-01 校验由网关为该 host 生成的 80 端口 server 完成。
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { getBaseDomain } from '../db/init.js';
import { hostCoveredByWildcard, certPathsForHost } from './routing.js';

const CERTBOT_IMAGE = process.env.CERTBOT_IMAGE?.trim() || 'certbot/certbot';
/** 宿主机路径（docker -v 由宿主机守护进程解析，必须传宿主机路径） */
const CERTBOT_WWW_HOST_DIR = process.env.CERTBOT_WWW_HOST_DIR?.trim() || '/root/SSE_Market/certbot/www';
const LETSENCRYPT_HOST_DIR = process.env.LETSENCRYPT_HOST_DIR?.trim() || '/root/SSE_Market/Nginx';
/** 容器内可读路径（用于判断证书是否已存在） */
const LETSENCRYPT_CONTAINER_DIR =
  process.env.LETSENCRYPT_LIVE_DIR?.trim() || '/etc/letsencrypt/live';

const CERT_TIMEOUT_MS = Number(process.env.CERTBOT_TIMEOUT_MS || 180_000);

function run(cmd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { cwd: '/' });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 该 host 是否已有可用证书（独立证书存在，或被通配符覆盖） */
export function hostHasCertificate(host: string): boolean {
  if (hostCoveredByWildcard(host)) return true;
  return certPathsForHost(host).cert.includes(host.toLowerCase());
}

/**
 * 为缺证书的多级子域名签发证书。返回 true 表示证书发生了变化（需重载网关）。
 * 失败不抛错：仅记录日志，网关继续用通配符证书（多级域名浏览器会提示，但不影响访问）。
 */
export async function issueHostCertificate(
  host: string,
  log: (line: string) => void
): Promise<boolean> {
  const h = host.toLowerCase().trim();
  const base = getBaseDomain().toLowerCase();
  if (hostCoveredByWildcard(h)) return false;
  if (!h.endsWith(`.${base}`)) {
    log(`[cert] ${h} 非平台子域名，跳过自动签发（请自行配置证书）`);
    return false;
  }
  if (hostHasCertificate(h)) return false;

  log(`[cert] ${h} 不在通配符 *.${base} 内，开始单独签发证书…`);
  const cmd =
    `docker run --rm ` +
    `-v ${CERTBOT_WWW_HOST_DIR}:/var/www/certbot ` +
    `-v ${LETSENCRYPT_HOST_DIR}:/etc/letsencrypt ` +
    `${CERTBOT_IMAGE} certonly --webroot -w /var/www/certbot ` +
    `-d ${h} --non-interactive --agree-tos --keep-until-expiring ` +
    `--cert-name ${h} --register-unsafely-without-email`;
  const res = await run(cmd, CERT_TIMEOUT_MS);
  const out = `${res.stdout}\n${res.stderr}`.trim();
  if (res.code !== 0) {
    log(`[cert] ${h} 签发失败（exit=${res.code}）：${out.slice(-400).replace(/\n+/g, ' | ')}`);
    return false;
  }
  const certPath = join(LETSENCRYPT_CONTAINER_DIR, h, 'fullchain.pem');
  if (!existsSync(certPath)) {
    log(`[cert] ${h} certbot 返回成功但未找到证书文件 ${certPath}：${out.slice(-300)}`);
    return false;
  }
  log(`[cert] ${h} 证书签发成功 → ${certPath}`);
  return true;
}

/** 为所有启用域名补签证书；返回是否有新证书（需要重载网关） */
export async function ensureHostCertificates(
  hosts: string[],
  log: (line: string) => void
): Promise<boolean> {
  let changed = false;
  for (const host of hosts) {
    try {
      if (await issueHostCertificate(host, log)) changed = true;
    } catch (e) {
      log(`[cert] ${host} 签发异常：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return changed;
}

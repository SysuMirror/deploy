import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

function applyEnvFile(envPath: string) {
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    // 不覆盖已有环境变量（便于 start-api.sh 注入绝对路径）
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadEnvFile() {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    process.env.DEPLOY_ENV_FILE,
    resolve(here, '../../.env'), // apps/deploy-api/.env
    resolve(here, '../../../.env'), // sse-deploy/.env（如 k8s_password）
  ].filter(Boolean) as string[];
  for (const f of files) applyEnvFile(f);

  // 兼容键名：面板密码
  if (!process.env.SSEINFRA_PASSWORD) {
    process.env.SSEINFRA_PASSWORD =
      process.env.K8S_PASSWORD || process.env.k8s_password || '';
  }
  if (!process.env.SSEINFRA_USERNAME) {
    process.env.SSEINFRA_USERNAME =
      process.env.K8S_USERNAME || process.env.k8s_username || 'admin';
  }
  if (!process.env.DEPLOY_RUNTIME) {
    process.env.DEPLOY_RUNTIME = 'sseinfra';
  }
}

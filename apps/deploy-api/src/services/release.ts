import type { DeployEnv } from '../types.js';

export function validateDeployEnv(env?: string): DeployEnv {
  if (!env || env === 'test') return 'test';
  if (env === 'prod') return 'prod';
  throw new Error('环境仅支持 test 或 prod');
}

/**
 * 压缩包是否具备 deploy.sh / 能否 Agent 生成（供前端确认弹窗）。
 */
import { existsSync } from 'fs';
import { isLlmConfigured } from './llm.js';
import { isSseinfraRuntime } from './sseinfra-client.js';
import { hasDeploySh } from './package-store.js';
import { resolvePackageForDeploy } from './project.js';

export function getPackageDeployShStatus(
  moduleId: string,
  packageVersion?: string
): {
  runtime: 'sseinfra' | 'compose';
  hasDeploySh: boolean;
  llmReady: boolean;
  needsAgentConfirm: boolean;
  packageVersion: string | null;
  message: string;
} {
  const runtime = isSseinfraRuntime() ? 'sseinfra' : 'compose';
  const pkg = resolvePackageForDeploy(moduleId, packageVersion);
  const has =
    Boolean(pkg.packagePath && existsSync(pkg.packagePath)) && hasDeploySh(pkg.packagePath);
  const llmReady = isLlmConfigured();
  const needsAgentConfirm = runtime === 'sseinfra' && !has;
  let message = '压缩包已含 deploy.sh，可直接部署';
  if (runtime === 'compose') {
    message = '当前为 compose 运行时，不强制要求 deploy.sh';
  } else if (!has && llmReady) {
    message =
      '压缩包缺少 deploy.sh（组内无 Docker）。确认后将由部署 Agent 自动生成；部署过程中可随时取消。';
  } else if (!has && !llmReady) {
    message =
      '压缩包缺少 deploy.sh，且未配置 AI/vLLM，无法自动生成。请上传模板包、手写脚本，或配置管理台 LLM。';
  }
  return {
    runtime,
    hasDeploySh: has,
    llmReady,
    needsAgentConfirm,
    packageVersion: pkg.version || null,
    message,
  };
}

/**
 * sseinfra 面板登录与跳板配置。
 * 优先级：环境变量锁定项 > platform_settings（管理台）> 默认值。
 * 密码永不回传明文，仅 masked / configured / envLocked。
 */
import { getPlatformSetting, setPlatformSetting } from '../db/init.js';

const KEYS = {
  baseUrl: 'sseinfra_base_url',
  username: 'sseinfra_username',
  password: 'sseinfra_password',
  groupPrefix: 'sseinfra_group_prefix',
  sshHost: 'sseinfra_ssh_host',
  sshUser: 'sseinfra_ssh_user',
  giteeToken: 'sseinfra_gitee_token',
  defaultCpu: 'sseinfra_default_cpu',
  defaultMem: 'sseinfra_default_mem',
  defaultStorage: 'sseinfra_default_storage',
} as const;

function maskSecret(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 2)}****${trimmed.slice(-2)}`;
}

function envPassword(): string {
  return (
    process.env.SSEINFRA_PASSWORD?.trim() ||
    process.env.K8S_PASSWORD?.trim() ||
    process.env.k8s_password?.trim() ||
    ''
  );
}

function envUsername(): string {
  return (
    process.env.SSEINFRA_USERNAME?.trim() ||
    process.env.K8S_USERNAME?.trim() ||
    process.env.k8s_username?.trim() ||
    ''
  );
}

function envBaseUrl(): string {
  return (process.env.SSEINFRA_BASE_URL || '').trim();
}

export type SseinfraRuntimeConfig = {
  baseUrl: string;
  username: string;
  password: string;
  groupPrefix: string;
  sshHost: string;
  sshUser: string;
  giteeToken: string;
  defaultCpu: string;
  defaultMem: string;
  defaultStorage: string;
};

/** 运行时真实配置（含明文密码，仅服务端内部使用） */
export function getSseinfraRuntimeConfig(): SseinfraRuntimeConfig {
  const envPass = envPassword();
  const dbPass = (getPlatformSetting(KEYS.password) || '').trim();
  const envUser = envUsername();
  const dbUser = (getPlatformSetting(KEYS.username) || '').trim();
  const envBase = envBaseUrl();
  const dbBase = (getPlatformSetting(KEYS.baseUrl) || '').trim();

  return {
    baseUrl: (envBase || dbBase || 'http://ssemarket.cn:24000').replace(/\/$/, ''),
    username: envUser || dbUser,
    password: envPass || dbPass,
    groupPrefix:
      (process.env.SSEINFRA_GROUP_PREFIX || getPlatformSetting(KEYS.groupPrefix) || 'sdpy')
        .replace(/[^a-z0-9-]/gi, '')
        .toLowerCase() || 'sdpy',
    sshHost:
      process.env.SSEINFRA_SSH_HOST?.trim() ||
      getPlatformSetting(KEYS.sshHost)?.trim() ||
      'ssemarket.cn',
    sshUser:
      process.env.SSEINFRA_SSH_USER?.trim() ||
      getPlatformSetting(KEYS.sshUser)?.trim() ||
      'root',
    giteeToken:
      process.env.SSEINFRA_GITEE_TOKEN?.trim() ||
      getPlatformSetting(KEYS.giteeToken)?.trim() ||
      '',
    defaultCpu:
      process.env.SSEINFRA_DEFAULT_CPU?.trim() ||
      getPlatformSetting(KEYS.defaultCpu)?.trim() ||
      '2',
    defaultMem:
      process.env.SSEINFRA_DEFAULT_MEM?.trim() ||
      getPlatformSetting(KEYS.defaultMem)?.trim() ||
      '4Gi',
    defaultStorage:
      process.env.SSEINFRA_DEFAULT_STORAGE?.trim() ||
      getPlatformSetting(KEYS.defaultStorage)?.trim() ||
      '10',
  };
}

export type SseinfraAdminView = {
  baseUrl: string;
  username: string;
  groupPrefix: string;
  sshHost: string;
  sshUser: string;
  defaultCpu: string;
  defaultMem: string;
  defaultStorage: string;
  cpuEnvLocked: boolean;
  memEnvLocked: boolean;
  storageEnvLocked: boolean;
  configured: boolean;
  usernameSource: 'env' | 'database' | 'none';
  usernameEnvLocked: boolean;
  passwordSource: 'env' | 'database' | 'none';
  passwordEnvLocked: boolean;
  maskedPassword: string | null;
  hasGiteeToken: boolean;
  giteeTokenEnvLocked: boolean;
  maskedGiteeToken: string | null;
};

export function getSseinfraSettingsForAdmin(): SseinfraAdminView {
  const runtime = getSseinfraRuntimeConfig();
  const envPass = envPassword();
  const dbPass = (getPlatformSetting(KEYS.password) || '').trim();
  const envUser = envUsername();
  const dbUser = (getPlatformSetting(KEYS.username) || '').trim();
  const envGitee = (process.env.SSEINFRA_GITEE_TOKEN || '').trim();
  const dbGitee = (getPlatformSetting(KEYS.giteeToken) || '').trim();

  let passwordSource: SseinfraAdminView['passwordSource'] = 'none';
  if (envPass) passwordSource = 'env';
  else if (dbPass) passwordSource = 'database';

  let usernameSource: SseinfraAdminView['usernameSource'] = 'none';
  if (envUser) usernameSource = 'env';
  else if (dbUser) usernameSource = 'database';

  return {
    baseUrl: runtime.baseUrl,
    username: runtime.username,
    groupPrefix: runtime.groupPrefix,
    sshHost: runtime.sshHost,
    sshUser: runtime.sshUser,
    defaultCpu: runtime.defaultCpu,
    defaultMem: runtime.defaultMem,
    defaultStorage: runtime.defaultStorage,
    cpuEnvLocked: Boolean(process.env.SSEINFRA_DEFAULT_CPU?.trim()),
    memEnvLocked: Boolean(process.env.SSEINFRA_DEFAULT_MEM?.trim()),
    storageEnvLocked: Boolean(process.env.SSEINFRA_DEFAULT_STORAGE?.trim()),
    configured: Boolean(runtime.password && runtime.username),
    usernameSource,
    usernameEnvLocked: Boolean(envUser),
    passwordSource,
    passwordEnvLocked: Boolean(envPass),
    maskedPassword: runtime.password ? maskSecret(runtime.password) : null,
    hasGiteeToken: Boolean(envGitee || dbGitee),
    giteeTokenEnvLocked: Boolean(envGitee),
    maskedGiteeToken: envGitee || dbGitee ? maskSecret(envGitee || dbGitee) : null,
  };
}

export type SseinfraSettingsInput = {
  baseUrl?: string;
  username?: string;
  password?: string;
  clearPassword?: boolean;
  groupPrefix?: string;
  sshHost?: string;
  sshUser?: string;
  giteeToken?: string;
  clearGiteeToken?: boolean;
  defaultCpu?: string;
  defaultMem?: string;
  defaultStorage?: string;
};

export function saveSseinfraSettings(
  input: SseinfraSettingsInput,
  updatedBy?: string
): SseinfraAdminView {
  if (typeof input.baseUrl === 'string') {
    const base = input.baseUrl.trim().replace(/\/$/, '');
    if (base && !/^https?:\/\//i.test(base)) {
      throw new Error('面板地址须以 http:// 或 https:// 开头');
    }
    if (!envBaseUrl()) {
      setPlatformSetting(KEYS.baseUrl, base || 'http://ssemarket.cn:24000', updatedBy);
    }
  }

  if (typeof input.groupPrefix === 'string' && !process.env.SSEINFRA_GROUP_PREFIX) {
    const p =
      input.groupPrefix.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 20) || 'sdpy';
    setPlatformSetting(KEYS.groupPrefix, p, updatedBy);
  }

  if (typeof input.sshHost === 'string' && !process.env.SSEINFRA_SSH_HOST) {
    setPlatformSetting(KEYS.sshHost, input.sshHost.trim() || 'ssemarket.cn', updatedBy);
  }
  if (typeof input.sshUser === 'string' && !process.env.SSEINFRA_SSH_USER) {
    setPlatformSetting(KEYS.sshUser, input.sshUser.trim() || 'root', updatedBy);
  }

  if (!envPassword()) {
    if (input.clearPassword) {
      setPlatformSetting(KEYS.password, '', updatedBy);
    } else if (typeof input.password === 'string' && input.password.trim()) {
      setPlatformSetting(KEYS.password, input.password.trim(), updatedBy);
    }
  }

  if (!envUsername()) {
    if (typeof input.username === 'string') {
      setPlatformSetting(KEYS.username, input.username.trim(), updatedBy);
    }
  }

  if (!process.env.SSEINFRA_GITEE_TOKEN?.trim()) {
    if (input.clearGiteeToken) {
      setPlatformSetting(KEYS.giteeToken, '', updatedBy);
    } else if (typeof input.giteeToken === 'string' && input.giteeToken.trim()) {
      setPlatformSetting(KEYS.giteeToken, input.giteeToken.trim(), updatedBy);
    }
  }

  if (typeof input.defaultCpu === 'string' && !process.env.SSEINFRA_DEFAULT_CPU?.trim()) {
    const cpu = input.defaultCpu.trim() || '2';
    setPlatformSetting(KEYS.defaultCpu, cpu, updatedBy);
  }
  if (typeof input.defaultMem === 'string' && !process.env.SSEINFRA_DEFAULT_MEM?.trim()) {
    const mem = input.defaultMem.trim() || '4Gi';
    setPlatformSetting(KEYS.defaultMem, mem, updatedBy);
  }
  if (typeof input.defaultStorage === 'string' && !process.env.SSEINFRA_DEFAULT_STORAGE?.trim()) {
    const st = input.defaultStorage.trim().replace(/[^0-9.]/g, '') || '10';
    setPlatformSetting(KEYS.defaultStorage, st, updatedBy);
  }

  return getSseinfraSettingsForAdmin();
}

import { loadEnvFile } from './load-env.js';

loadEnvFile();

/** 灰度 Header 配置（初版已弱化，保留兼容） */
export const grayConfig = {
  headerName: process.env.GRAY_HEADER_NAME ?? 'X-SSE-Gray',
  headerValues: parseHeaderValues(process.env.GRAY_HEADER_VALUES ?? 'canary,test,1,true'),
  recommendedValue: process.env.GRAY_HEADER_VALUE ?? 'canary',
  versionHeaderName: process.env.GRAY_VERSION_HEADER ?? 'X-SSE-Version',
};

function parseHeaderValues(raw: string): string[] {
  const values = raw
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return values.length ? values : ['canary'];
}

/** X-SSE-Gray → $http_x_sse_gray */
export function toNginxHttpVar(headerName: string): string {
  return '$http_' + headerName.toLowerCase().replace(/-/g, '_');
}

export function grayValuesNginxRegex(): string {
  return grayConfig.headerValues.map((v) => escapeRegex(v)).join('|');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getGrayReleaseInfo(moduleName: string, prodUrl: string) {
  const { headerName, recommendedValue, headerValues, versionHeaderName } = grayConfig;
  return {
    headerName,
    headerValue: recommendedValue,
    headerValues,
    versionHeaderName,
    description: `在正式域名上携带灰度 Header 将路由到测试容器，否则走正式版本`,
    curlExample: `curl -H "${headerName}: ${recommendedValue}" ${prodUrl}`,
    enabled: true,
    moduleName,
  };
}

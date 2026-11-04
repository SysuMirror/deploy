import axios, { type AxiosError } from 'axios';
import { toast } from 'vue-sonner';

/** 去掉末尾斜杠 */
function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * API 根地址（不含 /api）。
 * 生产部署在 /sdpy/test/{module}/ 下时，必须带 BASE_URL，否则会请求到站点根 /api。
 */
export function resolveApiUrl(): string {
  const fromEnv = import.meta.env.VITE_API_URL;
  if (fromEnv !== undefined && String(fromEnv).trim() !== '') {
    return stripTrailingSlash(String(fromEnv));
  }
  if (import.meta.env.DEV) return '';
  const base = import.meta.env.BASE_URL || '/';
  if (base === '/') return '';
  return stripTrailingSlash(base);
}

export const API_URL = resolveApiUrl();

export function appPath(path: string): string {
  const base = stripTrailingSlash(import.meta.env.BASE_URL || '/');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}` || p;
}

export function extractErrorMessage(data: unknown, fallback = '未知错误'): string {
  if (!data) return fallback;
  if (typeof data === 'string') return data;
  if (typeof data !== 'object') return fallback;
  const obj = data as Record<string, unknown>;
  if (typeof obj.message === 'string' && obj.message) return obj.message;
  if (typeof obj.error === 'string' && obj.error) return obj.error;
  const detail = obj.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'msg' in item) {
          return String((item as { msg: unknown }).msg);
        }
        return JSON.stringify(item);
      })
      .join('；');
  }
  return fallback;
}

export const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<Record<string, unknown>>) => {
    const status = error.response?.status;
    if (status === 401) {
      localStorage.removeItem('token');
      if (typeof window !== 'undefined') {
        const loginPath = appPath('/login');
        if (!window.location.pathname.startsWith(loginPath)) {
          const redirect = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = `${loginPath}?redirect=${redirect}`;
        }
      }
    }
    const serverMsg = extractErrorMessage(error.response?.data, error.message || '未知错误');
    const label = status ? `[${status}] ` : '';
    toast.error(`${label}${serverMsg}`, {
      description: error.config
        ? `${error.config.method?.toUpperCase()} ${error.config.url}`
        : undefined,
      duration: 5000,
    });
    return Promise.reject(error);
  },
);

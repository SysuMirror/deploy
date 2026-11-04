import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: string | Date | null | undefined): string {
  if (date == null || date === '') return '—';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function formatNumber(num: number): string {
  if (num >= 10000) return `${(num / 10000).toFixed(1)}万`;
  return num.toString();
}

export function translateAuthError(error: unknown): string {
  const message =
    (error as { message?: string })?.message ||
    (error as { body?: { message?: string } })?.body?.message ||
    '未知错误';

  const errorMap: Record<string, string> = {
    'Invalid email or password': '邮箱或密码错误',
    'Email already registered': '该邮箱已被注册',
    'User not found': '用户不存在',
    'Invalid token': '无效的令牌',
    'Password too short': '密码长度过短',
    'Failed to fetch': '连接服务器失败，请检查网络',
    'Network Error': '网络错误，请稍后重试',
    'Internal Server Error': '服务器内部错误',
  };

  if (errorMap[message]) return errorMap[message];
  for (const [key, value] of Object.entries(errorMap)) {
    if (message.includes(key)) return value;
  }
  return message;
}

export function newId(prefix = 'id'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 脚本应用（非部署台应用）—— 前端共用的命令拼装与状态文案。
 *
 * 列表页、详情页、运行抽屉都要显示「即将执行的命令」，
 * 这套规则必须和后端 `services/script-apps.ts` 的 `assembleCommandLine()` 完全一致，
 * 否则页面上预览的、和历史记录里落库的、真正下发的会是三条不同的命令。
 */

import type { ScriptParam } from '@/services/api';

/** 与后端同规则的转义（单引号包起来，内部单引号用 '\'' 转义） */
export function shellQuote(v: string) {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/**
 * 按「命令主体 + flag1 值1 + flag2 值2」拼接。
 * 值为空即视为「不传该参数」，直接跳过；开关型参数只拼 flag。
 */
export function assembleCommandLine(
  mainCommand: string,
  params: ScriptParam[],
  values: Record<string, string>
) {
  const parts = [mainCommand.trim()];
  for (const p of params) {
    const raw = (values[p.id] ?? '').trim();
    if (p.valueMode === 'switch') {
      if (raw && raw !== '0' && raw !== 'false') parts.push(p.flag);
      continue;
    }
    if (!raw) continue;
    parts.push(p.flag, shellQuote(raw));
  }
  return parts.join(' ');
}

/**
 * 实际下发的完整脚本 = 先 cd 到根目录再跑命令。
 * 与后端 buildScript() 保持一致 —— 只显示 `python3 iwiki.py deploy ...`
 * 会让人不确定它在哪个目录下跑的，而目录恰好是这个功能最容易踩坑的地方。
 */
export function buildFullScript(workdir: string, commandLine: string) {
  if (!workdir) return commandLine;
  return `cd ${shellQuote(workdir)} && ${commandLine}`;
}

const STATUS_TEXT: Record<string, string> = {
  running: '执行中',
  success: '成功',
  failed: '失败',
  canceled: '已终止',
  timeout: '超时终止',
  interrupted: '已中断',
};

export function scriptStatusText(s: string) {
  return STATUS_TEXT[s] ?? s;
}

/**
 * 展示执行时间。
 * 后端存的是 UTC ISO（`toISOString()`），直接切字符串会显示成 UTC ——
 * 北京时间会差 8 小时，用户看到「刚跑完的记录显示 8 小时前」会以为平台坏了。
 * 用 Date 解析后按浏览器本地时区输出（与 MonitorLogView / ProcessView 的做法一致）。
 */
export function formatRunTime(t?: string | null) {
  if (!t) return '—';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t; // 非 ISO 文本时原样返回，别显示 Invalid Date
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

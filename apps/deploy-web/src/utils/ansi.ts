/**
 * 终端输出高亮：把脚本输出渲染成带颜色的 HTML。
 *
 * 两层高亮：
 *   1. ANSI 转义序列（脚本自己带的颜色，如 iwiki.py 的青色标题）
 *   2. 语义关键字（日志里没上色的 ERROR / 警告 / 成功）
 *
 * ⚠️ 安全前提：输出是用户脚本产生的任意内容，**必须先 HTML 转义再拼标签**。
 *    顺序不能反 —— 先转义可保证内容里即便写了 `<img onerror=...>` 也只会当文本显示。
 */

/** 支持的 ANSI 前景色（30-37 基本色 / 90-97 亮色） */
const FG: Record<number, string> = {
  30: '#64748b', // 黑（深色背景上太黑的看不清，提亮成灰）
  31: '#f87171', // 红
  32: '#4ade80', // 绿
  33: '#fbbf24', // 黄
  34: '#60a5fa', // 蓝
  35: '#c084fc', // 品红
  36: '#22d3ee', // 青
  37: '#e2e8f0', // 白
  90: '#94a3b8',
  91: '#fca5a5',
  92: '#86efac',
  93: '#fde68a',
  94: '#93c5fd',
  95: '#d8b4fe',
  96: '#67e8f9',
  97: '#f8fafc',
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type AnsiState = { fg?: number; bold: boolean; dim: boolean };

/** 把一行里的 ANSI SGR 序列转成 span；返回 HTML（输入需已转义） */
function applyAnsi(escapedLine: string): string {
  // eslint-disable-next-line no-control-regex
  const re = /\u001b\[([0-9;]*)m/g;
  let out = '';
  let last = 0;
  const st: AnsiState = { bold: false, dim: false };
  const openSpan = () => {
    if (st.fg === undefined && !st.bold && !st.dim) return '';
    const style: string[] = [];
    if (st.fg !== undefined) style.push(`color:${FG[st.fg] ?? '#e2e8f0'}`);
    if (st.bold) style.push('font-weight:600');
    if (st.dim) style.push('opacity:.7');
    return `<span style="${style.join(';')}">`;
  };

  for (let m = re.exec(escapedLine); m; m = re.exec(escapedLine)) {
    // 关掉上一段样式，写入文本，再按新状态重开
    out += openSpan() + escapedLine.slice(last, m.index);
    if (st.fg !== undefined || st.bold || st.dim) out += '</span>';
    last = m.index + m[0].length;

    const codes = (m[1] || '0').split(';').filter((x) => x !== '');
    if (!codes.length) codes.push('0');
    for (const c of codes) {
      const n = Number(c);
      if (n === 0) {
        st.fg = undefined;
        st.bold = false;
        st.dim = false;
      } else if (n === 1) st.bold = true;
      else if (n === 2) st.dim = true;
      else if (n === 22) {
        st.bold = false;
        st.dim = false;
      } else if (n === 39) st.fg = undefined;
      else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) st.fg = n;
      // 背景色 / 其余控制码（光标移动等）忽略：终端日志里几乎不用，画出来反而花
    }
  }
  out += openSpan() + escapedLine.slice(last);
  if (st.fg !== undefined || st.bold || st.dim) out += '</span>';
  return out;
}

/** 语义关键字：给没上色的日志补上醒目颜色 */
const KEYWORD_RULES: { re: RegExp; cls: string }[] = [
  // 失败 / 错误：最常见的排查目标，优先匹配
  { re: /(\[错误\]|\[失败\]|\[error\]|\berror\b|\bfailed\b|\bfail\b|\bexception\b|\btraceback\b|✗|✘|✖)/i, cls: 'ln-bad' },
  // 警告
  { re: /(\[警告\]|\[warn\]|\bwarn(ing)?\b|⚠)/i, cls: 'ln-warn' },
  // 成功 / 完成
  { re: /(\[成功\]|\[完成\]|\[ok\]|\bsuccess\b|\bsucceed(ed)?\b|\bdone\b|\bpassed\b|✓|✔)/i, cls: 'ln-ok' },
  // 进度 / 提示
  { re: /(\[系统\]|\[取消\]|\[超时\]|\[目录\]|\[执行位置\]|\[命令组\])/, cls: 'ln-info' },
];

/**
 * 单行语义着色。
 * 两种情况下不做语义标记：
 *   - 整行已有 ANSI 颜色：尊重脚本自己的配色，否则会出现「脚本标绿、我们刷红」的打架效果
 *   - 命令行回显（`$ ...`）：那是命令本身而非日志内容，命令里出现 grep error 会把整行刷红，误导排查
 */
function markKeywords(html: string, hasAnsi: boolean, isEcho: boolean): string {
  if (hasAnsi || isEcho) return html;
  for (const { re, cls } of KEYWORD_RULES) {
    if (re.test(html)) return `<span class="${cls}">${html}</span>`;
  }
  return html;
}

/** 把原始输出（含 ANSI）转成可直接 v-html 的 HTML */
export function renderAnsi(raw: string): string {
  if (!raw) return '';
  return raw
    .split('\n')
    .map((line) => {
      const escaped = escapeHtml(line);
      const hasAnsi = /\u001b\[[0-9;]*m/.test(line);
      const isEcho = line.startsWith('$ ');
      // 行内 ANSI 处理完再做语义标记，避免关键字规则去匹配 span 标签里的属性文本
      return markKeywords(applyAnsi(escaped), hasAnsi, isEcho);
    })
    .join('\n');
}

/** 复制用纯文本：去掉 ANSI 控制码，否则粘到别处是一堆 [0;36m */
export function stripAnsi(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

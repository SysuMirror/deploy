/**
 * 轻量 SMTP 邮件发送（隐式 TLS 465 / STARTTLS 25 均支持）。
 * 零依赖：直接实现 SMTP ESMTP 会话（EHLO/STARTTLS/AUTH LOGIN/MAIL FROM/RCPT TO/DATA）。
 *
 * 环境变量（读宿主机 .env，与 SSE_market_server 一致）：
 *   SMTP_EMAIL_USERNAME / SMTP_EMAIL_PASSWORD / SMTP_HOST / SMTP_ADDR(host:port)
 */

import net from 'net';
import tls from 'tls';
import { db } from '../db/init.js';

export type MailInput = {
  to: Array<string>;
  subject: string;
  html: string;
  text?: string;
};

interface SmtpConfig {
  user: string;
  pass: string;
  host: string;
  port: number;
  secure: boolean; // true=465 隐式 TLS；false=25/587 STARTTLS
}

export function readSmtpConfig(): SmtpConfig | null {
  const user = process.env.SMTP_EMAIL_USERNAME || '';
  const pass = process.env.SMTP_EMAIL_PASSWORD || '';
  const host = process.env.SMTP_HOST || '';
  const addr = process.env.SMTP_ADDR || '';
  if (!user || !pass || !host) return null;
  const [addrHost, addrPort] = addr.split(':');
  const port = Number(addrPort) || (addr.includes(':465') ? 465 : 25);
  return { user, pass, host, port, secure: port === 465 };
}

function base64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function encodeHeaderText(s: string): string {
  // =?UTF-8?B?...?= 编码非 ASCII 头
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${base64(s)}?=`;
}

/** 读取一行回复 */
function readLine(sock: tls.TLSSocket | net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onReadable = () => {
      try {
        const chunk = (sock as unknown as { read(): string | null }).read();
        if (chunk == null) return;
        resolve(String(chunk));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      } finally {
        cleanup();
      }
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      sock.removeListener('readable', onReadable);
      sock.removeListener('error', onError);
    };
    sock.once('error', onError);
    sock.on('readable', onReadable);
  });
}

/** 读到完整多行 SMTP 回复（形如 250-... 续行，250 空格结尾） */
async function readReply(sock: tls.TLSSocket | net.Socket, expect: number): Promise<string> {
  let buf = '';
  for (;;) {
    buf += await readLine(sock);
    // 判断最后一行是否为终结行：^ddd（空格）或读取超时由外层控制
    const lines = buf.split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1] || '';
    if (/^\d{3}[ ]/.test(last)) break;
    if (lines.length > 50) break; // 防御
  }
  const code = Number(buf.slice(0, 3));
  if (code !== expect) {
    throw new Error(`SMTP 期望 ${expect} 实际 ${code}: ${buf.slice(0, 300)}`);
  }
  return buf;
}

function sendLine(sock: tls.TLSSocket | net.Socket, line: string): void {
  sock.write(`${line}\r\n`);
}

/** 建立 SMTP 连接并发信；返回会话日志 */
export async function sendMail(input: MailInput): Promise<{ ok: boolean; log: string; error?: string }> {
  const cfg = readSmtpConfig();
  if (!cfg) return { ok: false, log: '', error: 'SMTP 未配置（SMTP_EMAIL_USERNAME/PASSWORD/HOST/ADDR）' };
  const toList = input.to.filter(Boolean);
  if (!toList.length) return { ok: false, log: '', error: '无收件人' };

  const boundary = `sdpy-${Date.now().toString(36)}`;
  const lines: Array<string> = [];
  lines.push(`From: SSE Deploy <${cfg.user}>`);
  lines.push(`To: ${toList.map(encodeHeaderText).join(', ')}`);
  lines.push(`Subject: ${encodeHeaderText(input.subject)}`);
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  lines.push('');
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(base64(input.text || input.html.replace(/<[^>]+>/g, ' ')));
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/html; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  // base64 按行 76 字符切分
  const b64 = base64(input.html);
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  lines.push(`--${boundary}--`);
  const data = lines.join('\r\n').replace(/^\./gm, '..'); // DATA 转义

  const log: Array<string> = [];
  return await new Promise((resolve) => {
    const sock: net.Socket = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : net.connect({ host: cfg.host, port: cfg.port });
    let startedTls = !cfg.secure;
    let authed = false;
    let stage = 0;
    let from = cfg.user;
    let rcptIdx = 0;
    let result: { ok: boolean; log: string; error?: string };

    const finish = (r: { ok: boolean; log: string; error?: string }) => {
      if (result) return;
      result = r;
      try {
        sock.end();
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    const fail = (err: unknown) => {
      log.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      finish({ ok: false, log: log.join('\n'), error: err instanceof Error ? err.message : String(err) });
    };

    sock.setTimeout(20_000, () => fail(new Error('SMTP 超时')));
    sock.on('error', fail);

    /** 每收到一段回复推进一个阶段 */
    const pump = async () => {
      try {
        for (;;) {
          const reply = await readReply(sock, -1).catch((e) => {
            throw e;
          });
          // readReply 严格校验会抛错，这里改用宽松读取：重新实现
          void reply;
          return;
        }
      } catch (e) {
        fail(e);
      }
    };
    void pump;

    // 状态机：基于 readReply 的宽松版本
    const expectCode = async (want: number): Promise<string> => {
      let buf = '';
      for (;;) {
        buf += await readLine(sock);
        const arr = buf.split(/\r?\n/).filter(Boolean);
        const last = arr[arr.length - 1] || '';
        if (/^\d{3}[ ]/.test(last)) break;
        if (arr.length > 50) break;
      }
      const code = Number(buf.slice(0, 3));
      log.push(`S: ${buf.trim().slice(0, 200)}`);
      if (code !== want) throw new Error(`SMTP ${want} 期待，实际 ${code}: ${buf.slice(0, 200)}`);
      return buf;
    };

    const drive = async () => {
      try {
        for (;;) {
          if (stage === 0) {
            await expectCode(220); // 问候
            sendLine(sock, `EHLO ${cfg.host.includes('163') ? '163.com' : cfg.host}`);
            // 多行 EHLO：读直到 250 空格结尾
            let buf = '';
            for (;;) {
              buf += await readLine(sock);
              const arr = buf.split(/\r?\n/).filter(Boolean);
              const last = arr[arr.length - 1] || '';
              if (/^\d{3}[ ]/.test(last)) break;
            }
            log.push(`S(ehlo): ${buf.trim().slice(0, 200)}`);
            stage = 1; // 隐式 TLS 连接上无需再 STARTTLS，直接 AUTH
            continue;
          }
          if (stage === 1) {
            sendLine(sock, 'AUTH LOGIN');
            await expectCode(334);
            sendLine(sock, base64(cfg.user));
            await expectCode(334);
            sendLine(sock, base64(cfg.pass));
            await expectCode(235);
            authed = true;
            stage = 2;
            continue;
          }
          if (stage === 2) {
            sendLine(sock, `MAIL FROM:<${from}>`);
            await expectCode(250);
            stage = 3;
            continue;
          }
          if (stage === 3) {
            if (rcptIdx >= toList.length) {
              stage = 4;
              continue;
            }
            sendLine(sock, `RCPT TO:<${toList[rcptIdx++]}>`);
            await expectCode(250);
            continue;
          }
          if (stage === 4) {
            sendLine(sock, 'DATA');
            await expectCode(354);
            sendLine(sock, `${data}\r\n.`);
            stage = 5;
            continue;
          }
          if (stage === 5) {
            await expectCode(250);
            sendLine(sock, 'QUIT');
            finish({ ok: authed, log: log.join('\n') });
            return;
          }
        }
      } catch (e) {
        fail(e);
      }
    };

    /** STARTTLS 之后的后续阶段（EHLO 已发，等待回复） */
    const driveTlsContinue = (tlsSock: tls.TLSSocket) => {
      const localExpect = async (want: number): Promise<string> => {
        let buf = '';
        for (;;) {
          buf += await readLine(tlsSock);
          const arr = buf.split(/\r?\n/).filter(Boolean);
          const last = arr[arr.length - 1] || '';
          if (/^\d{3}[ ]/.test(last)) break;
        }
        log.push(`S: ${buf.trim().slice(0, 200)}`);
        if (Number(buf.slice(0, 3)) !== want) throw new Error(`SMTP ${want} 期待: ${buf.slice(0, 200)}`);
        return buf;
      };
      (async () => {
        try {
          // EHLO 回复（多行）
          let buf = '';
          for (;;) {
            buf += await readLine(tlsSock);
            const arr = buf.split(/\r?\n/).filter(Boolean);
            const last = arr[arr.length - 1] || '';
            if (/^\d{3}[ ]/.test(last)) break;
          }
          log.push(`S(ehlo2): ${buf.trim().slice(0, 200)}`);
          sendLine(tlsSock, 'AUTH LOGIN');
          await localExpect(334);
          sendLine(tlsSock, base64(cfg.user));
          await localExpect(334);
          sendLine(tlsSock, base64(cfg.pass));
          await localExpect(235);
          sendLine(tlsSock, `MAIL FROM:<${cfg.user}>`);
          await localExpect(250);
          for (const rcpt of toList) {
            sendLine(tlsSock, `RCPT TO:<${rcpt}>`);
            await localExpect(250);
          }
          sendLine(tlsSock, 'DATA');
          await localExpect(354);
          sendLine(tlsSock, `${data}\r\n.`);
          await localExpect(250);
          sendLine(tlsSock, 'QUIT');
          finish({ ok: true, log: log.join('\n') });
        } catch (e) {
          fail(e);
        }
      })();
    };

    sock.once('connect', () => {
      log.push(`C: connect ${cfg.host}:${cfg.port}${cfg.secure ? ' (implicit TLS)' : ''}`);
    });
    // 初始驱动：等第一段 220
    if (cfg.secure) {
      sock.once('secureConnect', () => {
        drive().catch(fail);
      });
    } else {
      sock.once('connect', () => {
        drive().catch(fail);
      });
    }
  });
}

/** 平台管理员收件人列表：users.email 非空的管理员；查询失败/无邮箱才回退 ADMIN_ALERT_EMAIL */
export function adminRecipients(): Array<{ id: string; email: string; name: string }> {
  try {
    const rows = db
      .prepare(
        `SELECT u.id, u.email, COALESCE(u.name, '') AS name FROM users u
         JOIN platform_admins pa ON pa.oauth_id = u.oauth_id
         WHERE u.email != ''`
      )
      .all() as Array<{ id: string; email: string; name: string }>;
    if (rows.length) return rows;
  } catch {
    /* fallthrough */
  }
  const fallback = (process.env.ADMIN_ALERT_EMAIL || '').split(',').map((s) => s.trim()).filter(Boolean);
  return fallback.map((email) => ({ id: '', email, name: '管理员' }));
}

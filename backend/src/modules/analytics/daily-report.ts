/**
 * daily-report.ts — Tiểu Mỹ báo cáo 21:00 hằng ngày qua Telegram (1 tin / tổ chức):
 *   1. Nhân viên phản hồi khách Zalo hôm nay (theo nick, kèm người phụ trách) — response-report.ts
 *   2. Thứ Hai: thêm tổng kết 7 ngày qua
 *   3. AI trả lời Zalo 24 giờ qua (nếu có nick bật AI) — ai-monitor.buildAiDailySection
 * Gửi qua bot Tiểu Mỹ (HANDOFF_TELEGRAM_*).
 */
import cron from 'node-cron';
import { config } from '../../config/index.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { buildAiDailySection } from '../ai/auto-reply/ai-monitor.js';
import { defaultHandoffChatId, isTelegramConfigured, sendTelegram } from '../ai/auto-reply/handoff-notify.js';
import { computeResponseReport, formatResponseReport, vnDayStart } from './response-report.js';

const SLOW_MINUTES = 30;

export async function buildDailyReport(orgId: string, now = new Date()): Promise<string> {
  const vnDate = new Date(now.getTime() + 7 * 3_600_000);
  const dd = `${String(vnDate.getUTCDate()).padStart(2, '0')}/${String(vnDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const parts: string[] = [`📊 <b>Tiểu Mỹ báo cáo ngày ${dd}</b>`, ''];
  const today = await computeResponseReport({ orgId, from: vnDayStart(now, 0), to: now, slowMinutes: SLOW_MINUTES, now });
  parts.push(formatResponseReport(today, 'Nhân viên phản hồi khách hôm nay', config.appUrl));
  if (vnDate.getUTCDay() === 1) {
    const week = await computeResponseReport({ orgId, from: vnDayStart(now, 7), to: vnDayStart(now, 0), slowMinutes: SLOW_MINUTES, now: vnDayStart(now, 0) });
    week.nicks.forEach((n) => { n.waiting = []; }); // tuần: không liệt kê khách chờ (đã báo từng ngày)
    parts.push('', formatResponseReport(week, 'Tổng kết 7 ngày qua'));
  }
  const ai = await buildAiDailySection(orgId, now).catch(() => null);
  if (ai) parts.push('', ai);
  return parts.join('\n');
}

export async function sendDailyReports(now = new Date()): Promise<number> {
  const chat = defaultHandoffChatId();
  if (!isTelegramConfigured() || !chat) return 0;
  let sent = 0;
  const orgs = await prisma.organization.findMany({ where: { zaloAccounts: { some: { purged: false } } }, select: { id: true } });
  for (const o of orgs) {
    try {
      const text = await buildDailyReport(o.id, now);
      // Telegram giới hạn 4096 ký tự / tin → chia theo dòng.
      let chunk = '';
      for (const line of text.split('\n')) {
        if ((chunk + line).length > 3800) { await sendTelegram(chat, chunk); chunk = ''; }
        chunk += (chunk ? '\n' : '') + line;
      }
      if (chunk) await sendTelegram(chat, chunk);
      sent++;
    } catch (err) {
      logger.warn(`[daily-report] báo cáo org ${o.id} lỗi:`, err);
    }
  }
  logger.info(`[daily-report] đã gửi báo cáo 21:00 cho ${sent} tổ chức`);
  return sent;
}

let started = false;
export function startDailyReport(): void {
  if (started) return;
  started = true;
  cron.schedule('0 21 * * *', () => { void sendDailyReports(); }, { timezone: 'Asia/Ho_Chi_Minh' });
}

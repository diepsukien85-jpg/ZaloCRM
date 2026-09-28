/**
 * ai-monitor.ts — Tiểu Mỹ canh gác AI trả lời Zalo: AI không làm việc thì PHẢI báo, không được im.
 *
 * Mỗi 5 phút, với từng nick đang bật AI:
 *   1. Nick mất kết nối Zalo → AI không đọc / trả lời được.
 *   2. AI của tổ chức tắt / thiếu khoá.
 *   3. Có lượt lỗi (gọi AI lỗi, gửi Zalo lỗi, kiểm duyệt lỗi…).
 *   4. Zalo có tin mới mà AI không nhận được sự kiện (listener chết).
 *   5. Tin khách / nhân viên chờ quá 20 phút chưa ai trả lời (kèm lý do AI chưa trả lời).
 * 21:00 mỗi ngày: báo cáo ngày (tin đến, AI trả lời, chuyển người, hỏi danh tính, bỏ qua theo lý do, lỗi).
 * Gửi qua bot Telegram Tiểu Mỹ (HANDOFF_TELEGRAM_*), chống báo trùng theo từng loại.
 */
import { config } from '../../../config/index.js';
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import { zaloPool } from '../../zalo/zalo-pool.js';
import { getAiConfig, getProviderApiKey } from '../ai-service.js';
import { parseOffsetMinutes } from '../daily-brief-service.js';
import { listProfiles, type AutoReplyProfile } from './config-service.js';
import { groupOfTags, threadZaloLabels } from './contact-classifier.js';
import { defaultHandoffChatId, isTelegramConfigured, sendTelegram } from './handoff-notify.js';
import { localHour, withinHours } from './guardrails.js';

const TICK_MS = 5 * 60_000;
const WAIT_ALERT_MIN = 20;
const REPORT_HOUR = 21;
const startedAt = Date.now();
const lastEventByNick = new Map<string, number>();
const lastAlert = new Map<string, number>();
const alertedWaits = new Set<string>();
let lastReportDay = '';

/** Gọi mỗi khi AI nhận được sự kiện tin mới của nick (để biết listener còn sống). */
export function noteAiEvent(zaloAccountId: string): void {
  lastEventByNick.set(zaloAccountId, Date.now());
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function alert(key: string, throttleMs: number, html: string, chatId?: string | null): Promise<boolean> {
  const now = Date.now();
  if (now - (lastAlert.get(key) ?? 0) < throttleMs) return false;
  const chat = chatId?.trim() || defaultHandoffChatId();
  if (!isTelegramConfigured() || !chat) return false;
  try {
    await sendTelegram(chat, html);
    lastAlert.set(key, now);
    return true;
  } catch (err: any) {
    logger.warn(`[ai-monitor] gửi Telegram lỗi: ${err?.message ?? err}`);
    return false;
  }
}

const link = (convId: string) => `${config.appUrl.replace(/\/$/, '')}/chat/${convId}`;
const hhmm = (d: Date, offsetMin: number) => new Date(d.getTime() + offsetMin * 60_000).toISOString().slice(11, 16);

/** Hàm thuần: tin báo tin chờ lâu. */
export function formatWaiting(nick: string, items: Array<{ name: string; minutes: number; reason: string; convId: string; text: string }>): string {
  return [
    `⏰ <b>Tiểu Mỹ báo: ${items.length} tin chờ quá ${WAIT_ALERT_MIN} phút chưa ai trả lời</b> · nick ${esc(nick)}`,
    ...items.map((i) => `• <b>${esc(i.name)}</b> (${i.minutes} phút): "${esc(i.text.slice(0, 80))}"\n  AI chưa trả lời vì: ${esc(i.reason)}\n  ${link(i.convId)}`),
  ].join('\n');
}

type Nick = { id: string; orgId: string; displayName: string | null };

async function waitingConversations(nick: Nick, cfg: AutoReplyProfile, now: Date) {
  const from = new Date(now.getTime() - 180 * 60_000);
  const to = new Date(now.getTime() - WAIT_ALERT_MIN * 60_000);
  const convs = await prisma.conversation.findMany({
    where: { zaloAccountId: nick.id, threadType: 'user', lastMessageAt: { gte: from, lte: to } },
    select: { id: true, externalThreadId: true, contact: { select: { crmName: true, fullName: true, tags: true } } },
    take: 200,
  });
  const out: Array<{ name: string; minutes: number; reason: string; convId: string; text: string; msgId: string }> = [];
  for (const cv of convs) {
    const last = await prisma.message.findFirst({
      where: { conversationId: cv.id, isDeleted: false },
      orderBy: { sentAt: 'desc' },
      select: { id: true, senderType: true, sentAt: true, content: true, contentType: true },
    });
    if (!last || last.senderType !== 'contact' || last.sentAt > to || last.sentAt < from) continue;
    if (alertedWaits.has(last.id)) continue;
    const log = await prisma.aiAutoReplyLog.findFirst({
      where: { conversationId: cv.id, createdAt: { gte: new Date(last.sentAt.getTime() - 60_000) } },
      orderBy: { createdAt: 'desc' },
      select: { audience: true, decision: true, reason: true },
    });
    let reason: string | null = null;
    if (log) {
      if ((log.audience === 'customer' || log.audience === 'staff') && (log.decision === 'skipped' || log.decision === 'error')) reason = log.reason ?? log.decision;
    } else {
      // Không có nhật ký: chỉ báo khi người này thuộc nhóm AI phải trả lời (khách / nhân viên theo thẻ).
      const labels = cv.externalThreadId ? await threadZaloLabels(nick.id, cv.externalThreadId) : null;
      const g = labels ? groupOfTags(labels, [], cfg) : null;
      if (g && (g.group === 'customer' || g.group === 'staff')) reason = 'AI chưa xét tin này (có thể không nhận được tin)';
    }
    if (!reason) continue;
    out.push({
      name: cv.contact?.crmName || cv.contact?.fullName || 'Không tên',
      minutes: Math.round((now.getTime() - last.sentAt.getTime()) / 60_000),
      reason,
      convId: cv.id,
      text: last.contentType === 'text' ? (last.content ?? '') : `(gửi ${last.contentType})`,
      msgId: last.id,
    });
  }
  return out;
}

async function dailyReport(nicks: Array<{ nick: Nick; cfg: AutoReplyProfile }>, now: Date, offsetMin: number): Promise<void> {
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const parts: string[] = [`📊 <b>Tiểu Mỹ báo cáo AI trả lời Zalo — 24 giờ qua</b>`];
  for (const { nick, cfg } of nicks) {
    const logs = await prisma.aiAutoReplyLog.findMany({
      where: { zaloAccountId: nick.id, createdAt: { gte: since } },
      select: { audience: true, decision: true, reason: true },
    });
    const incoming = await prisma.conversation.count({
      where: { zaloAccountId: nick.id, threadType: 'user', messages: { some: { senderType: 'contact', sentAt: { gte: since } } } },
    });
    const n = (f: (l: typeof logs[number]) => boolean) => logs.filter(f).length;
    const skipped = new Map<string, number>();
    for (const l of logs.filter((x) => x.decision === 'skipped')) {
      const k = (l.reason ?? '').replace(/\(.*$/, '').replace(/·.*$/, '').trim().slice(0, 50) || 'khác';
      skipped.set(k, (skipped.get(k) ?? 0) + 1);
    }
    const topSkip = [...skipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} (${v})`).join('; ');
    const unanswered = (await waitingConversations(nick, cfg, now).catch(() => [])).length;
    parts.push(
      '',
      `<b>${esc(nick.displayName || nick.id.slice(0, 8))}</b> · ${cfg.mode === 'auto' ? 'tự gửi' : 'chạy thử'}${cfg.classifyContacts ? ' · tự phân loại' : ''}`,
      `• Người nhắn riêng: ${incoming}`,
      `• AI trả lời khách: ${n((l) => l.audience === 'customer' && (l.decision === 'sent' || l.decision === 'dry_run'))} · nhân viên: ${n((l) => l.audience === 'staff' && (l.decision === 'sent' || l.decision === 'dry_run'))}`,
      `• Chuyển anh xử lý: ${n((l) => l.decision === 'handoff')} · hỏi danh tính: ${n((l) => l.audience === 'classify' && l.decision === 'sent')}`,
      `• Bỏ qua: ${n((l) => l.decision === 'skipped')}${topSkip ? ` — ${esc(topSkip)}` : ''}`,
      `• Lỗi: ${n((l) => l.decision === 'error')}${unanswered ? ` · ⚠️ đang có ${unanswered} tin chờ chưa ai trả lời` : ''}`,
    );
  }
  parts.push('', `(${hhmm(now, offsetMin)} — muốn xem chi tiết: CRM → Cài đặt → AI tự trả lời → Nhật ký)`);
  await alert(`report:${now.toISOString().slice(0, 10)}`, 0, parts.join('\n'));
}

/** Một vòng canh gác. Trả số tin báo đã gửi (cho test). */
export async function monitorTick(now = new Date()): Promise<number> {
  let sent = 0;
  const orgIds = [...new Set((await prisma.aiAutoReplyProfile.findMany({ where: { enabled: true }, select: { orgId: true } })).map((p) => p.orgId))];
  for (const orgId of orgIds) {
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
    const offsetMin = parseOffsetMinutes(org?.timezone);
    const profiles = (await listProfiles(orgId)).filter((p) => p.enabled);
    const accounts = await prisma.zaloAccount.findMany({
      where: { id: { in: profiles.map((p) => p.zaloAccountId) } },
      select: { id: true, orgId: true, displayName: true },
    });
    const nicks = profiles
      .map((cfg) => ({ cfg, nick: accounts.find((a) => a.id === cfg.zaloAccountId) }))
      .filter((x): x is { cfg: AutoReplyProfile; nick: Nick } => !!x.nick);

    // 2. AI của tổ chức
    const ai = await getAiConfig(orgId);
    const key = ai.enabled ? await getProviderApiKey(orgId, ai.provider) : null;
    if (!ai.enabled || !key) {
      if (await alert(`aicfg:${orgId}`, 6 * 3_600_000, `⚠️ <b>Tiểu Mỹ báo: AI trả lời Zalo đang KHÔNG chạy</b>\n${!ai.enabled ? 'AI của tổ chức đang tắt' : `thiếu khoá AI (${esc(ai.provider)})`} — ${nicks.length} nick đang bật AI sẽ không trả lời ai.`)) sent++;
    }

    for (const { nick, cfg } of nicks) {
      const name = esc(nick.displayName || nick.id.slice(0, 8));
      const inHours = withinHours(localHour(now, offsetMin), cfg.hourStart, cfg.hourEnd);
      // 1. Mất kết nối
      const status = zaloPool.getInstance(nick.id)?.status;
      if (status !== 'connected') {
        if (await alert(`disc:${nick.id}`, 3_600_000, `⚠️ <b>Tiểu Mỹ báo: nick ${name} mất kết nối Zalo</b> (${esc(String(status ?? 'không chạy'))})\nAI không đọc / trả lời được tin của nick này. Vào CRM → Tài khoản Zalo để kết nối lại.`, cfg.handoffChatId)) sent++;
        continue;
      }
      // 3. Lỗi gần đây
      const errs = await prisma.aiAutoReplyLog.findMany({
        where: { zaloAccountId: nick.id, decision: 'error', createdAt: { gte: new Date(now.getTime() - TICK_MS - 60_000) } },
        orderBy: { createdAt: 'desc' },
        select: { reason: true },
      });
      if (errs.length) {
        if (await alert(`err:${nick.id}`, 30 * 60_000, `⚠️ <b>Tiểu Mỹ báo: AI nick ${name} gặp ${errs.length} lỗi</b> trong vài phút qua\nLỗi gần nhất: ${esc(errs[0].reason ?? '')}`, cfg.handoffChatId)) sent++;
      }
      // 4. Listener: Zalo có tin mới mà AI không nhận sự kiện
      const newest = await prisma.message.findFirst({
        where: { senderType: 'contact', conversation: { zaloAccountId: nick.id, threadType: 'user' }, sentAt: { gte: new Date(now.getTime() - 20 * 60_000) } },
        orderBy: { sentAt: 'desc' },
        select: { sentAt: true },
      });
      const lastEvent = lastEventByNick.get(nick.id) ?? startedAt;
      if (newest && now.getTime() - newest.sentAt.getTime() > 3 * 60_000 && newest.sentAt.getTime() - lastEvent > 2 * 60_000) {
        if (await alert(`listen:${nick.id}`, 3_600_000, `⚠️ <b>Tiểu Mỹ báo: AI nick ${name} không nhận được tin mới</b>\nZalo có tin lúc ${hhmm(newest.sentAt, offsetMin)} nhưng AI không được báo — AI đang không trả lời. Cần khởi động lại ZaloCRM.`, cfg.handoffChatId)) sent++;
      }
      // 5. Tin chờ lâu chưa ai trả lời (trong khung giờ AI làm việc)
      if (inHours && cfg.mode === 'auto') {
        const waits = await waitingConversations(nick, cfg, now);
        if (waits.length) {
          const ok = await alert(`wait:${nick.id}:${waits.map((w) => w.msgId).join(',')}`, 0, formatWaiting(nick.displayName || nick.id.slice(0, 8), waits.slice(0, 10)), cfg.handoffChatId);
          if (ok) { sent++; waits.forEach((w) => alertedWaits.add(w.msgId)); }
        }
      }
    }

    // Báo cáo ngày lúc 21:00 (giờ tổ chức)
    const day = new Date(now.getTime() + offsetMin * 60_000).toISOString().slice(0, 10);
    if (localHour(now, offsetMin) === REPORT_HOUR && lastReportDay !== `${orgId}:${day}` && nicks.length) {
      lastReportDay = `${orgId}:${day}`;
      await dailyReport(nicks, now, offsetMin).then(() => { sent++; }).catch((err) => logger.warn('[ai-monitor] báo cáo ngày lỗi:', err));
    }
  }
  if (alertedWaits.size > 5000) alertedWaits.clear();
  return sent;
}

let timer: NodeJS.Timeout | null = null;
export function startAiMonitor(): void {
  if (timer) return;
  timer = setInterval(() => void monitorTick().catch((err) => logger.warn('[ai-monitor] vòng canh gác lỗi:', err)), TICK_MS);
  timer.unref?.();
}

/** Chỉ cho test. */
export function _resetMonitor(): void {
  lastEventByNick.clear();
  lastAlert.clear();
  alertedWaits.clear();
  lastReportDay = '';
}

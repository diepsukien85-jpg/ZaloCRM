/**
 * handoff-notify.ts — báo chủ shop qua Telegram khi AI chuyển hội thoại cho người thật.
 *
 * Mẫu tin theo skill ai-chatbot (08 — luật chuyển tin). Token bot để ở server:
 *   HANDOFF_TELEGRAM_BOT_TOKEN   (dùng chung bot Telegram báo cáo của bot-noi-bo)
 *   HANDOFF_TELEGRAM_CHAT_ID     (chat mặc định của chủ shop; từng nick có thể đổi)
 * Chống spam: cùng hội thoại chỉ báo 1 lần trong `pauseMinutes` (trừ tin KHẨN).
 */
import { logger } from '../../../shared/utils/logger.js';
import { config } from '../../../config/index.js';

const API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const lastSent = new Map<string, number>(); // conversationId → ms

export function isTelegramConfigured(): boolean {
  return !!process.env.HANDOFF_TELEGRAM_BOT_TOKEN;
}

export function defaultHandoffChatId(): string | null {
  return process.env.HANDOFF_TELEGRAM_CHAT_ID?.trim() || null;
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendTelegram(chatId: string, html: string): Promise<void> {
  const token = process.env.HANDOFF_TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Chưa cấu hình HANDOFF_TELEGRAM_BOT_TOKEN');
  const res = await fetch(`${API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: html.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram ${res.status}: ${body.slice(0, 200)}`);
  }
}

export type HandoffInfo = {
  conversationId: string;
  nickName: string;
  customerName: string;
  customerPhone?: string | null;
  urgent: boolean;
  reason: string;
  customerText: string;
  botReply: string | null;
  dryRun?: boolean;
  /** customer (mặc định) | staff = nhân viên cần chủ xử lý | identity = người nhắn chưa rõ / người thân. */
  kind?: 'customer' | 'staff' | 'identity';
  /** Đã dời hội thoại vào thẻ Zalo "Chờ người thật". */
  held?: boolean;
};

/** Hàm thuần: soạn tin Telegram theo mẫu của skill. */
export function formatHandoff(h: HandoffInfo, appUrl = config.appUrl): string {
  const link = `${appUrl.replace(/\/$/, '')}/chat/${h.conversationId}`;
  const heldLine = h.held ? '📌 Đã chuyển vào thẻ Zalo "Chờ người thật" — trả lời khách xong, thẻ cũ tự trả lại.' : null;
  if (h.kind === 'staff' || h.kind === 'identity') {
    const staff = h.kind === 'staff';
    return [
      staff
        ? `👷 <b>NHÂN VIÊN CẦN ANH MẪN — ${h.urgent ? '🚨 KHẨN' : 'BÌNH THƯỜNG'}</b>${h.dryRun ? ' <i>(AI đang chạy thử)</i>' : ''}`
        : '❓ <b>NGƯỜI NHẮN ZALO — CẦN ANH XEM</b>',
      `Kênh: Zalo · nick ${esc(h.nickName)}`,
      `${staff ? 'Nhân viên' : 'Người nhắn'}: ${esc(h.customerName)}${h.customerPhone ? ` · SĐT: ${esc(h.customerPhone)}` : ''}`,
      `${staff ? 'Việc cần anh' : 'Tình trạng'}: ${esc(h.reason || 'không rõ')}`,
      `Tin nhắn: ${esc(h.customerText.slice(0, 600))}`,
      `Bot đã trả lời: ${h.botReply ? esc(h.botReply.slice(0, 400)) : '(chưa trả lời)'}`,
      `Link hội thoại: ${link}`,
      heldLine,
    ].filter(Boolean).join('\n');
  }
  return [
    `🔔 <b>CẦN ANH MẪN XỬ LÝ — ${h.urgent ? '🚨 KHẨN' : 'BÌNH THƯỜNG'}</b>${h.dryRun ? ' <i>(AI đang chạy thử)</i>' : ''}`,
    `Kênh: Zalo · nick ${esc(h.nickName)}`,
    `Khách: ${esc(h.customerName)}${h.customerPhone ? ` · SĐT: ${esc(h.customerPhone)}` : ''}`,
    `Lý do chuyển: ${esc(h.reason || 'không rõ')}`,
    `Khách nhắn: ${esc(h.customerText.slice(0, 600))}`,
    `Bot đã trả lời: ${h.botReply ? esc(h.botReply.slice(0, 400)) : '(chưa trả lời khách)'}`,
    `Link hội thoại: ${link}`,
    heldLine,
  ].filter(Boolean).join('\n');
}

/**
 * Gửi báo chuyển người. Trả true nếu đã gửi, false nếu bỏ qua (chưa cấu hình /
 * vừa báo hội thoại này gần đây). Không ném lỗi — lỗi ghi log.
 */
export type NotifyStatus = 'sent' | 'throttled' | 'off' | 'error';

/**
 * Gửi báo chuyển người, trả trạng thái (để ghi vào nhật ký AI). Không ném lỗi.
 * `key` = khoá chống báo trùng (mặc định theo hội thoại; tin "khách nhắn thêm" dùng khoá riêng).
 */
export async function notifyHandoffStatus(h: HandoffInfo, opts: { chatId?: string | null; pauseMinutes?: number; key?: string }): Promise<NotifyStatus> {
  const chatId = opts.chatId?.trim() || defaultHandoffChatId();
  if (!isTelegramConfigured() || !chatId) return 'off';
  const key = opts.key ?? h.conversationId;
  const now = Date.now();
  const last = lastSent.get(key) ?? 0;
  if (!h.urgent && now - last < (opts.pauseMinutes ?? 60) * 60_000) return 'throttled';
  try {
    await sendTelegram(chatId, formatHandoff(h));
    lastSent.set(key, now);
    if (lastSent.size > 5000) for (const [k, t] of lastSent) if (now - t > 86_400_000) lastSent.delete(k);
    logger.info(`[ai-handoff] đã báo Telegram (${h.kind ?? 'customer'}${h.urgent ? ', KHẨN' : ''}) conv=${h.conversationId}: ${h.reason.slice(0, 100)}`);
    return 'sent';
  } catch (err: any) {
    logger.warn(`[ai-handoff] gửi Telegram lỗi: ${err?.message ?? err}`);
    return 'error';
  }
}

/** Như notifyHandoffStatus, trả true nếu đã gửi. */
export async function notifyHandoff(h: HandoffInfo, opts: { chatId?: string | null; pauseMinutes?: number; key?: string }): Promise<boolean> {
  return (await notifyHandoffStatus(h, opts)) === 'sent';
}

/** Chỉ cho test. */
export function _resetHandoffNotify(): void {
  lastSent.clear();
}

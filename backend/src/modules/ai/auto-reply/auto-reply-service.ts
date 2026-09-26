/**
 * auto-reply-service.ts — AI tự trả lời khách 1-1, CHỈ ở hội thoại có thẻ kích hoạt.
 *
 * Tiết kiệm AI: mỗi tin đến chỉ tốn vài truy vấn DB rẻ (config cache + thẻ của
 * cặp nick×khách). Không có thẻ kích hoạt → dừng, không gọi AI.
 *
 * Luồng:
 *   message_received → lọc (bật? nick? 1-1? có thẻ?) → gom tin `debounceSeconds`
 *   → evaluate: khung giờ, nhường nhân viên, từ khoá nhạy cảm, trần/ngày
 *   → AI viết (hoặc handoff) → lớp chặn bằng code → kiểm duyệt căn cứ (lượt AI 2)
 *   → soát lại lần cuối (nhân viên vừa trả lời? khách nhắn thêm?) → gửi Zalo.
 *
 * Phỏng theo phần AI của ZL-CRM (Thầy Nguyễn Tất Kiểm, Apache-2.0), đổi từ
 * "soạn nháp" / "trả lời nhóm" sang tự gửi 1-1 có cổng thẻ phân loại.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import { zaloOps } from '../../../shared/zalo-operations.js';
import { zaloPool } from '../../zalo/zalo-pool.js';
import { automationEventBus } from '../../automation/engine/event-bus.js';
import { applyContactAggregateFromMessage, applyFriendAggregate } from '../../contacts/contact-aggregate.js';
import { getAiConfig, getProviderApiKey, generateText } from '../ai-service.js';
import { parseOffsetMinutes, orgDayRange } from '../daily-brief-service.js';
import { getProfile } from './config-service.js';
import { activeLessons, startLearningScheduler } from './learning-service.js';
import { buildAutoReplyContext, buildSystemPrompt, pickGuideFiles, renderReferences, renderSources, renderUserPrompt } from './context-builder.js';
import {
  cleanStyle, enforceHonesty, enforceNoCredentials, localHour, matchesAnyKeyword,
  normalizeTagName, parseDecision, withinHours,
} from './guardrails.js';

export type Decision = 'sent' | 'dry_run' | 'handoff' | 'skipped' | 'error';

// ── Thẻ của hội thoại ──────────────────────────────────────────────────────

/**
 * Thẻ gắn với hội thoại 1-1: Tag CRM cấp khách (Contact.tags) + thẻ riêng cặp
 * nick×khách (Friend.crmTagsPerNick, gồm thẻ Zalo mirror "🔵 X") + thẻ phân loại
 * Zalo (Friend.zaloLabels, đồng bộ từ app Zalo ~60 giây/lần).
 */
export async function getConversationTags(conv: {
  zaloAccountId: string; externalThreadId: string | null; contactId: string | null;
}): Promise<string[]> {
  const [contact, friend] = await Promise.all([
    conv.contactId
      ? prisma.contact.findUnique({ where: { id: conv.contactId }, select: { tags: true } })
      : null,
    conv.externalThreadId
      ? prisma.friend.findUnique({
          where: { zaloAccountId_zaloUidInNick: { zaloAccountId: conv.zaloAccountId, zaloUidInNick: conv.externalThreadId } },
          select: { crmTagsPerNick: true, zaloLabels: true },
        })
      : null,
  ]);
  const out = new Set<string>();
  const addAll = (v: unknown) => {
    if (!Array.isArray(v)) return;
    for (const t of v) {
      if (typeof t === 'string' && t.trim()) out.add(t.trim());
      else if (t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string') out.add((t as { name: string }).name);
    }
  };
  addAll(contact?.tags);
  addAll(friend?.crmTagsPerNick);
  addAll(friend?.zaloLabels);
  return [...out];
}

/** Thẻ kích hoạt đầu tiên khớp (so theo tên đã chuẩn hoá), null nếu không khớp. */
export function matchTriggerTag(tags: string[], triggerTags: string[]): string | null {
  if (!tags.length || !triggerTags.length) return null;
  const have = new Set(tags.map(normalizeTagName).filter(Boolean));
  return triggerTags.find((t) => have.has(normalizeTagName(t))) ?? null;
}

// ── Nhật ký ────────────────────────────────────────────────────────────────

type LogTarget = { orgId: string; conversationId: string; zaloAccountId: string };

async function writeLog(t: LogTarget, sourceMessageId: string | null, decision: Decision, reason: string, content?: string | null, latencyMs?: number, customerText?: string) {
  const { orgId, conversationId, zaloAccountId } = t;
  await prisma.aiAutoReplyLog.create({
    data: {
      orgId, conversationId, zaloAccountId, sourceMessageId, decision, reason: reason.slice(0, 500),
      content: content ?? null, latencyMs: latencyMs ?? null,
      // Tin khách đã trả lời — vòng tự học cần để đối chiếu với cách nhân viên xử lý.
      customerText: customerText ? customerText.slice(0, 2000) : null,
    },
  }).catch((err) => logger.warn('[ai-auto-reply] ghi nhật ký lỗi:', err));
}

// ── Kiểm duyệt căn cứ (lượt AI thứ 2) ─────────────────────────────────────

async function verifyGrounding(p: { provider: string; apiKey: string; model: string; reply: string; sources: string }): Promise<{ ok: boolean; text: string } | null> {
  const system = [
    'Bạn KIỂM DUYỆT một tin nhắn shop sắp gửi cho khách trên Zalo.',
    'Bạn nhận NGUỒN (kho kịch bản, mẫu tin, hồ sơ khách, lịch sử chat) và TIN SẮP GỬI.',
    'Việc duy nhất: tìm mọi KHẲNG ĐỊNH SỰ THẬT hoặc CAM KẾT mà NGUỒN không nêu rõ:',
    'giá, phí ship, khuyến mãi, còn hàng, thời gian giao, chính sách đổi trả, thông số sản phẩm, "sẽ gửi", bất kỳ con số nào.',
    'KHÔNG tính: lời chào, cảm ơn, câu hỏi lại khách, câu ghi nhận, câu hẹn "em kiểm tra rồi báo lại".',
    'Nếu có khẳng định không căn cứ: viết lại TOÀN BỘ tin, giữ xưng hô, giữ phần có căn cứ, thay phần không căn cứ bằng câu hẹn kiểm tra và báo lại. Không thêm thông tin mới.',
    'Trả DUY NHẤT JSON: {"ok": true|false, "rewrite": "tin đã viết lại, rỗng nếu ok"}',
  ].join('\n');
  const prompt = ['<nguon>', p.sources, '</nguon>', '', '<tin_sap_gui>', p.reply, '</tin_sap_gui>'].join('\n');
  let raw: string;
  try {
    raw = await generateText(p.provider, p.apiKey, p.model, system, prompt, 800);
  } catch {
    return null;
  }
  let t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    const parsed = JSON.parse(t.slice(a, b + 1)) as { ok?: unknown; rewrite?: unknown };
    if (parsed.ok === true) return { ok: true, text: p.reply };
    const rewrite = typeof parsed.rewrite === 'string' ? parsed.rewrite.trim() : '';
    return rewrite ? { ok: false, text: rewrite } : null;
  } catch {
    return null;
  }
}

function applyGuards(text: string, customerText: string): string {
  let out = cleanStyle(text);
  out = enforceHonesty(out, customerText).text;
  out = enforceNoCredentials(out).text;
  return out;
}

// ── Xét một hội thoại ──────────────────────────────────────────────────────

export type EvaluateResult = { decision: Decision; reason: string; content?: string };

export async function evaluateConversation(
  orgId: string,
  conversationId: string,
  /** test = chạy thử từ trang cài đặt: bỏ qua công tắc/khung giờ/tuổi tin/nhường nhân viên, KHÔNG gửi, KHÔNG ghi nhật ký. */
  opts: { now?: Date; test?: boolean } = {},
): Promise<EvaluateResult> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const test = !!opts.test;
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, orgId },
    select: { id: true, threadType: true, zaloAccountId: true, externalThreadId: true, contactId: true },
  });
  if (!conv || conv.threadType !== 'user' || !conv.externalThreadId) return { decision: 'skipped', reason: 'không phải chat 1-1' };

  // Cấu hình RIÊNG của nick nhận tin (xưng hô, lời dặn, giờ, thẻ, trần).
  const cfg = await getProfile(orgId, conv.zaloAccountId);
  if (!cfg) return { decision: 'skipped', reason: 'nick này chưa cấu hình AI' };
  if (!cfg.enabled && !test) return { decision: 'skipped', reason: 'tắt' };
  // Chạy thử không ghi nhật ký (không tính vào trần ngày).
  const target: LogTarget = { orgId, conversationId, zaloAccountId: conv.zaloAccountId };
  const log = test
    ? async (..._args: unknown[]) => {}
    : (...args: [string | null, Decision, string, (string | null)?, number?, string?]) => writeLog(target, ...args);

  const tags = await getConversationTags(conv);
  const trigger = matchTriggerTag(tags, cfg.triggerTags);
  if (!trigger) return { decision: 'skipped', reason: 'không có thẻ kích hoạt' };

  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
  const offset = parseOffsetMinutes(org?.timezone);
  if (!test && !withinHours(localHour(now, offset), cfg.hourStart, cfg.hourEnd)) {
    return { decision: 'skipped', reason: 'ngoài khung giờ' };
  }

  // Tin khách chưa được trả lời = tin contact sau tin self cuối cùng.
  const lastSelf = await prisma.message.findFirst({
    where: { conversationId, senderType: 'self', isDeleted: false },
    orderBy: { sentAt: 'desc' },
    select: { sentAt: true, sentVia: true },
  });
  let pending = await prisma.message.findMany({
    where: {
      conversationId, senderType: 'contact', isDeleted: false,
      ...(lastSelf ? { sentAt: { gt: lastSelf.sentAt } } : {}),
    },
    orderBy: { sentAt: 'asc' },
    take: 20,
    select: { id: true, content: true, contentType: true, sentAt: true },
  });
  if (pending.length === 0 && test) {
    // Chạy thử trên hội thoại đã trả lời: lấy 3 tin gần nhất của khách làm "tin chờ".
    pending = (await prisma.message.findMany({
      where: { conversationId, senderType: 'contact', isDeleted: false },
      orderBy: { sentAt: 'desc' },
      take: 3,
      select: { id: true, content: true, contentType: true, sentAt: true },
    })).reverse();
  }
  if (pending.length === 0) return { decision: 'skipped', reason: 'không còn tin chờ' };
  const lastPending = pending[pending.length - 1];

  // Tin chờ quá cũ (vd listener đồng bộ lại) → không trả lời muộn.
  if (!test && now.getTime() - lastPending.sentAt.getTime() > 30 * 60_000) {
    return { decision: 'skipped', reason: 'tin chờ đã quá 30 phút' };
  }

  // Nhân viên đang trực hội thoại này → nhường.
  if (!test && lastSelf && lastSelf.sentVia !== 'automation' && cfg.skipIfStaffRepliedWithinMin > 0
    && now.getTime() - lastSelf.sentAt.getTime() < cfg.skipIfStaffRepliedWithinMin * 60_000) {
    await log(lastPending.id, 'skipped', 'nhân viên vừa trả lời');
    return { decision: 'skipped', reason: 'nhân viên vừa trả lời' };
  }

  const texts = pending
    .filter((m) => (m.contentType === 'text' || m.contentType === 'rich' || m.contentType === 'link') && m.content?.trim())
    .map((m) => m.content!.trim());
  if (texts.length === 0) return { decision: 'skipped', reason: 'khách chỉ gửi ảnh/sticker' };
  const customerText = texts.join('\n');

  const blocked = matchesAnyKeyword(customerText, cfg.blockedKeywords);
  if (blocked) {
    await log(lastPending.id, 'handoff', `từ khoá cần người thật: "${blocked}"`);
    return { decision: 'handoff', reason: `từ khoá "${blocked}"` };
  }

  const { start: dayStart } = orgDayRange(now, org?.timezone);
  const [nickToday, convToday] = await Promise.all([
    prisma.aiAutoReplyLog.count({ where: { orgId, zaloAccountId: conv.zaloAccountId, decision: { in: ['sent', 'dry_run'] }, createdAt: { gte: dayStart } } }),
    prisma.aiAutoReplyLog.count({ where: { conversationId, decision: { in: ['sent', 'dry_run'] }, createdAt: { gte: dayStart } } }),
  ]);
  if (!test && nickToday >= cfg.maxRepliesPerDay) {
    await log(lastPending.id, 'skipped', 'hết trần tin AI trong ngày của nick');
    return { decision: 'skipped', reason: 'hết trần ngày' };
  }
  if (!test && convToday >= cfg.maxRepliesPerConvPerDay) {
    await log(lastPending.id, 'skipped', 'hết trần tin AI cho khách này hôm nay');
    return { decision: 'skipped', reason: 'hết trần khách' };
  }

  const ai = await getAiConfig(orgId);
  if (!ai.enabled) return { decision: 'skipped', reason: 'AI của tổ chức đang tắt' };
  const apiKey = await getProviderApiKey(orgId, ai.provider);
  if (!apiKey) {
    await log(lastPending.id, 'error', `chưa cấu hình khoá AI (${ai.provider})`);
    return { decision: 'error', reason: 'thiếu khoá AI' };
  }

  // Tài liệu tham khảo của skill: file "luôn dùng" + file khớp chủ đề câu khách hỏi
  // (các tin khách đang chờ trả lời).
  const references = pickGuideFiles(cfg.guideFiles ?? [], customerText);
  // Vòng tự học: bài học đang bật của nick này.
  const lessons = cfg.learningEnabled ? (await activeLessons(conv.zaloAccountId)).map((l) => l.content) : [];
  const ctx = await buildAutoReplyContext({ orgId, conversationId, zaloAccountId: conv.zaloAccountId, contactId: conv.contactId, pendingCustomerText: customerText, tags });
  let raw: string;
  try {
    raw = await generateText(ai.provider, apiKey, ai.model, buildSystemPrompt(cfg.persona, cfg.extraInstruction, lessons, references), renderUserPrompt(ctx), 900);
  } catch (err: any) {
    await log(lastPending.id, 'error', `gọi AI lỗi: ${err?.message ?? err}`);
    return { decision: 'error', reason: 'gọi AI lỗi' };
  }
  const decision = parseDecision(raw);
  if (!decision) {
    await log(lastPending.id, 'error', 'AI trả về không đúng định dạng', raw.slice(0, 1000));
    return { decision: 'error', reason: 'AI trả sai định dạng' };
  }
  if (decision.action === 'handoff') {
    await log(lastPending.id, 'handoff', decision.reason || 'AI chuyển nhân viên', null, Date.now() - started);
    return { decision: 'handoff', reason: decision.reason };
  }

  let text = applyGuards(decision.reply, customerText);
  if (cfg.verifyGrounding) {
    const checked = await verifyGrounding({ provider: ai.provider, apiKey, model: ai.model, reply: text, sources: renderSources(ctx)
      + (cfg.extraInstruction?.trim() ? `\n\n<huong_dan_cua_shop>\n${cfg.extraInstruction.trim()}\n</huong_dan_cua_shop>` : '')
      + (references.length ? `\n\n${renderReferences(references)}` : '')
      + (lessons.length ? `\n\n<bai_hoc>\n${lessons.map((l) => `- ${l}`).join('\n')}\n</bai_hoc>` : '') });
    if (!checked) {
      await log(lastPending.id, 'error', 'kiểm duyệt căn cứ lỗi, không gửi cho an toàn', text);
      return { decision: 'error', reason: 'kiểm duyệt lỗi' };
    }
    if (!checked.ok) text = applyGuards(checked.text, customerText);
  }
  if (!text.trim()) {
    await log(lastPending.id, 'error', 'tin sau lớp chặn bị rỗng');
    return { decision: 'error', reason: 'tin rỗng' };
  }

  // Soát lần cuối: trong lúc AI nghĩ, nhân viên đã trả lời hoặc khách nhắn thêm?
  const newest = await prisma.message.findFirst({
    where: { conversationId, isDeleted: false },
    orderBy: { sentAt: 'desc' },
    select: { id: true, senderType: true },
  });
  if (!test && newest && newest.id !== lastPending.id) {
    const reason = newest.senderType === 'self' ? 'nhân viên trả lời trong lúc AI soạn' : 'khách nhắn thêm, đợi lượt sau';
    if (newest.senderType === 'self') await log(lastPending.id, 'skipped', reason, text);
    return { decision: 'skipped', reason };
  }

  const latency = Date.now() - started;
  if (cfg.mode === 'dry_run' || test) {
    await log(lastPending.id, 'dry_run', `thẻ "${trigger}" · ${decision.reason}`, text, latency, customerText);
    return { decision: 'dry_run', reason: decision.reason, content: text };
  }

  try {
    await sendReply(orgId, conv as { id: string; zaloAccountId: string; externalThreadId: string; contactId: string | null }, text);
  } catch (err: any) {
    await log(lastPending.id, 'error', `gửi Zalo lỗi: ${err?.code ?? ''} ${err?.message ?? err}`, text, latency);
    return { decision: 'error', reason: 'gửi lỗi' };
  }
  await log(lastPending.id, 'sent', `thẻ "${trigger}" · ${decision.reason}`, text, latency, customerText);
  logger.info(`[ai-auto-reply] đã trả lời conv=${conversationId} (${latency}ms)`);
  return { decision: 'sent', reason: decision.reason, content: text };
}

async function sendReply(
  orgId: string,
  conv: { id: string; zaloAccountId: string; externalThreadId: string; contactId: string | null },
  text: string,
): Promise<void> {
  const raw = await zaloOps.sendMessage(conv.zaloAccountId, conv.externalThreadId, 0, { msg: text }) as
    { message?: { msgId?: number | string } | null; msgId?: number | string } | null;
  const zaloMsgId = String(raw?.message?.msgId ?? raw?.msgId ?? '') || null;
  const sentAt = new Date();
  const message = await prisma.message.create({
    data: {
      id: randomUUID(),
      conversationId: conv.id,
      zaloMsgId,
      zaloMsgIdNum: zaloMsgId && /^\d+$/.test(zaloMsgId) ? BigInt(zaloMsgId) : null,
      senderType: 'self',
      senderUid: '',
      senderName: 'AI',
      content: text,
      contentType: 'text',
      sentAt,
      sentVia: 'automation',
    },
  });
  await prisma.conversation.update({
    where: { id: conv.id },
    data: { lastMessageAt: sentAt, isReplied: true, unreadCount: 0 },
  }).catch(() => {});
  const aggInput = {
    conversationId: conv.id,
    message: { id: message.id, content: message.content, contentType: message.contentType, sentAt, senderType: 'self' as const },
    outboundUserId: null,
  };
  void applyContactAggregateFromMessage(aggInput);
  void applyFriendAggregate(aggInput);
  // Echo tự nghe về sau sẽ bị message-handler bỏ qua (trùng nội dung trong 30s),
  // nên tự đẩy tin lên giao diện ở đây.
  zaloPool.getIO()?.to(`org:${orgId}`).emit('chat:message', {
    accountId: conv.zaloAccountId,
    message,
    conversationId: conv.id,
  });
}

// ── Lắng nghe tin đến + gom tin ────────────────────────────────────────────

type PendingEntry = { timer: NodeJS.Timeout | null; orgId: string; running: boolean; rerun: boolean; delayMs: number };
const pendingByConv = new Map<string, PendingEntry>();

/** Lọc rẻ trước khi hẹn giờ: nick có cấu hình bật + chat 1-1 + khách mang thẻ kích hoạt. Trả debounce (ms) hoặc null. */
async function quickFilter(orgId: string, conversationId: string, zaloAccountId: string | undefined): Promise<number | null> {
  let accountId = zaloAccountId;
  if (accountId) {
    const early = await getProfile(orgId, accountId);
    if (!early?.enabled || early.triggerTags.length === 0) return null;
  }
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, orgId },
    select: { threadType: true, zaloAccountId: true, externalThreadId: true, contactId: true },
  });
  if (!conv || conv.threadType !== 'user') return null;
  accountId = conv.zaloAccountId;
  const cfg = await getProfile(orgId, accountId);
  if (!cfg?.enabled || cfg.triggerTags.length === 0) return null;
  if (!matchTriggerTag(await getConversationTags(conv), cfg.triggerTags)) return null;
  return cfg.debounceSeconds * 1000;
}

function schedule(orgId: string, conversationId: string, delayMs: number) {
  const entry = pendingByConv.get(conversationId) ?? { timer: null, orgId, running: false, rerun: false, delayMs };
  entry.delayMs = delayMs;
  pendingByConv.set(conversationId, entry);
  if (entry.running) {
    entry.rerun = true; // đang xét dở → xét lại sau khi xong
    return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => void run(conversationId), delayMs);
}

async function run(conversationId: string) {
  const entry = pendingByConv.get(conversationId);
  if (!entry) return;
  entry.timer = null;
  entry.running = true;
  try {
    await evaluateConversation(entry.orgId, conversationId);
  } catch (err) {
    logger.error(`[ai-auto-reply] xét conv=${conversationId} lỗi:`, err);
  } finally {
    entry.running = false;
    if (entry.rerun) {
      entry.rerun = false;
      schedule(entry.orgId, conversationId, entry.delayMs);
    } else {
      pendingByConv.delete(conversationId);
    }
  }
}

let started = false;

export function startAiAutoReply(): void {
  if (started) return;
  started = true;
  automationEventBus.onType(['message_received'], async (event) => {
    const payload = event.payload as { conversationId?: string; zaloAccountId?: string } | undefined;
    if (!payload?.conversationId) return;
    const delayMs = await quickFilter(event.orgId, payload.conversationId, payload.zaloAccountId);
    if (delayMs === null) return;
    schedule(event.orgId, payload.conversationId, delayMs);
  });
  startLearningScheduler();
  logger.info('[ai-auto-reply] listener đã bật — chỉ trả lời hội thoại 1-1 có thẻ kích hoạt');
}

/** Chỉ cho test. */
export function _pendingCount(): number {
  return pendingByConv.size;
}

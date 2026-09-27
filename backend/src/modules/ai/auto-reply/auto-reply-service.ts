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
import { zaloGender } from '../../zalo/zalo-message-helpers.js';
import { automationEventBus } from '../../automation/engine/event-bus.js';
import { applyContactAggregateFromMessage, applyFriendAggregate } from '../../contacts/contact-aggregate.js';
import { getAiConfig, getProviderApiKey, generateText } from '../ai-service.js';
import { parseOffsetMinutes, orgDayRange } from '../daily-brief-service.js';
import { getProfile } from './config-service.js';
import { activeLessons, splitLessons, startLearningScheduler } from './learning-service.js';
import { isCatalogEnabled, renderProducts, searchProducts, type CatalogProduct, type ProductQuery } from './catalog-service.js';
import { notifyHandoff } from './handoff-notify.js';
import { imageUrlOf, understandCustomerImages } from './image-understanding.js';
import { sendToThread } from '../../api/public-api-routes.js';
import { buildAutoReplyContext, buildSystemPrompt, pickGuideFiles, renderReferences, renderSources, renderUserPrompt } from './context-builder.js';
import {
  cleanStyle, enforceHonesty, enforceNoCredentials, fold, localHour, matchesAnyKeyword,
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

// ── Thẻ phân loại Zalo "sống" (không chờ đồng bộ 15 phút) ──────────────────

const LIVE_LABEL_TTL_MS = 60_000;
const liveLabelCache = new Map<string, { at: number; labels: Array<{ text: string; conversations: string[] }> }>();

/**
 * Thẻ phân loại Zalo của 1 hội thoại, đọc thẳng từ Zalo (getLabels) — vì đồng bộ
 * thẻ về CRM chạy 15 phút/lần, chủ shop vừa gắn thẻ "Bot AI" mà khách nhắn ngay
 * thì DB chưa có. Cache 60 giây mỗi nick (tối đa 1 lần gọi Zalo / phút / nick).
 * Lỗi / nick mất kết nối → [].
 */
export async function liveZaloLabels(zaloAccountId: string, threadId: string | null): Promise<string[]> {
  if (!threadId || zaloPool.getInstance(zaloAccountId)?.status !== 'connected') return [];
  let hit = liveLabelCache.get(zaloAccountId);
  if (!hit || Date.now() - hit.at > LIVE_LABEL_TTL_MS) {
    try {
      const res = await zaloOps.exec(
        { accountId: zaloAccountId, category: 'query', operation: 'getLabels(ai)' },
        (api: any) => api.getLabels(),
      ) as { labelData?: Array<{ text?: string; conversations?: unknown[] }> } | null;
      hit = {
        at: Date.now(),
        labels: (res?.labelData ?? []).map((l) => ({
          text: String(l.text ?? ''),
          conversations: Array.isArray(l.conversations) ? l.conversations.map(String) : [],
        })),
      };
      liveLabelCache.set(zaloAccountId, hit);
    } catch (err: any) {
      logger.debug(`[ai-auto-reply] getLabels lỗi nick=${zaloAccountId}: ${err?.message ?? err}`);
      return [];
    }
  }
  return hit.labels.filter((l) => l.text && l.conversations.includes(threadId)).map((l) => l.text);
}

/** Thẻ của hội thoại từ DB; nếu chưa khớp thẻ kích hoạt thì hỏi thêm Zalo (thẻ vừa gắn). */
async function conversationTagsWithLive(conv: { zaloAccountId: string; externalThreadId: string | null; contactId: string | null }, triggerTags: string[]): Promise<string[]> {
  const tags = await getConversationTags(conv);
  if (matchTriggerTag(tags, triggerTags)) return tags;
  const live = await liveZaloLabels(conv.zaloAccountId, conv.externalThreadId);
  return live.length ? [...new Set([...tags, ...live])] : tags;
}

/** Chỉ cho test. */
export function _clearLiveLabelCache(): void {
  liveLabelCache.clear();
}

/** Thẻ kích hoạt đầu tiên khớp (so theo tên đã chuẩn hoá), null nếu không khớp. */
export function matchTriggerTag(tags: string[], triggerTags: string[]): string | null {
  if (!tags.length || !triggerTags.length) return null;
  const have = new Set(tags.map(normalizeTagName).filter(Boolean));
  return triggerTags.find((t) => have.has(normalizeTagName(t))) ?? null;
}

// ── Giới tính khách (để gọi anh / chị) ─────────────────────────────────────

/**
 * Giới tính khách: lấy từ hồ sơ CRM; chưa có thì hỏi Zalo (getUserInfo qua đúng
 * nick của hội thoại, đi qua rate limiter) rồi lưu lại. Không lấy được → null.
 */
export async function resolveCustomerGender(conv: {
  zaloAccountId: string; externalThreadId: string | null; contactId: string | null;
}): Promise<'male' | 'female' | null> {
  if (!conv.contactId) return null;
  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId }, select: { gender: true } });
  if (contact?.gender === 'male' || contact?.gender === 'female') return contact.gender;
  if (!conv.externalThreadId || zaloPool.getInstance(conv.zaloAccountId)?.status !== 'connected') return null;
  try {
    const uid = conv.externalThreadId;
    const res = await zaloOps.exec(
      { accountId: conv.zaloAccountId, category: 'query', operation: 'getUserInfo(gender)' },
      (api: any) => api.getUserInfo(uid),
    ) as { changed_profiles?: Record<string, { gender?: unknown }> } | null;
    const profile = res?.changed_profiles?.[uid] ?? res?.changed_profiles?.[`${uid}_0`];
    const gender = zaloGender(profile?.gender);
    if (gender) {
      await prisma.contact.updateMany({
        where: { id: conv.contactId, OR: [{ gender: null }, { gender: '' }, { gender: 'unknown' }] },
        data: { gender },
      });
    }
    return gender;
  } catch (err: any) {
    logger.debug(`[ai-auto-reply] không lấy được giới tính khách: ${err?.message ?? err}`);
    return null;
  }
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

const MONEY_RE = /(\d{1,3}(?:[.,]\d{3})+|\d+)\s*(k|nghìn|ngàn|vnđ|vnd|đồng|đ)(?![\p{L}\p{N}])/giu;

/** Số tiền trong một đoạn (vd "72.000đ", "1.440.000 đ", "79k") → số đồng. Hàm thuần. */
export function moneyAmounts(text: string): number[] {
  const out: number[] = [];
  // Không dùng \\b: "đ" không phải ký tự \\w nên \\b không khớp sau "72.000đ".
  for (const m of text.matchAll(MONEY_RE)) {
    const n = Number(m[1].replace(/[.,]/g, ''));
    if (!Number.isFinite(n)) continue;
    out.push(/^(k|nghìn|ngàn)$/i.test(m[2]) ? n * 1000 : n);
  }
  return out;
}

/**
 * Số tiền trong tin có căn cứ không: có trong nguồn, hoặc = giá trong nguồn × số lượng
 * (1-1000, vd "20 chai thì tổng 1.440.000đ"). Hàm thuần.
 */
export function unsupportedAmounts(reply: string, sources: string): number[] {
  const known = new Set(moneyAmounts(sources));
  return moneyAmounts(reply).filter((n) => {
    if (known.has(n)) return false;
    for (const k of known) if (k > 0 && n % k === 0 && n / k <= 1000) return false;
    return true;
  });
}

/** Câu nhắc chính sách / cam kết — nhóm dễ bịa nhất, luôn cần căn cứ. */
const POLICY_WORDS = /(bao hanh|doi tra|hoan tien|mien phi|freeship|phi ship|phi giao|giao (trong|ngay|toi|hang)|ship|khuyen mai|giam gia|tang kem|qua tang|cam ket|dam bao|chinh hang|tron doi|het han|con \d+ (cai|chai|hop|goi))/;

/**
 * Câu bị kiểm duyệt nghi là bịa có THẬT SỰ đáng ngờ không. Báo nhầm (bỏ qua) khi câu
 * không nhắc chính sách / cam kết và mọi số tiền trong câu đều có trong nguồn
 * (hoặc là tổng từ giá trong nguồn). Hàm thuần.
 */
export function isRealGroundingIssue(sentence: string, sources: string): boolean {
  if (POLICY_WORDS.test(fold(sentence))) return true;
  if (unsupportedAmounts(sentence, sources).length) return true;
  // Không số tiền, không chính sách: chỉ đáng ngờ nếu có con số khác (dung tích, thời gian…) không có trong nguồn.
  const withoutMoney = sentence.replace(MONEY_RE, ' ');
  const nums = withoutMoney.match(/\d+(?:[.,]\d+)?/g) ?? [];
  return nums.some((n) => !sources.includes(n));
}

/**
 * Nguồn giá của đúng các món AI chọn gửi ảnh (tin đang tư vấn chính các món đó) —
 * chặn lấy nhầm giá biến thể khác (vd giá 25ml cho chai 20ml). Hàm thuần.
 */
export function focusPriceSource(products: Array<{ id: number; name: string; priceRetail: number | null; priceCtv: number | null; priceNpp: number | null }>, ids: number[]): string | null {
  const focus = products.filter((p) => ids.includes(p.id));
  if (!focus.length) return null;
  return focus.map((p) => `${p.name}: giá lẻ ${p.priceRetail ?? '?'}đ · CTV ${p.priceCtv ?? '?'}đ · NPP ${p.priceNpp ?? '?'}đ`).join('\n');
}

async function verifyGrounding(p: { provider: string; apiKey: string; model: string; reply: string; sources: string; moneySources?: string | null }): Promise<{ ok: boolean; text: string } | null> {
  const badMoney = unsupportedAmounts(p.reply, p.moneySources ?? p.sources);
  const system = [
    'Bạn KIỂM DUYỆT một tin nhắn shop sắp gửi cho khách trên Zalo.',
    'Bạn nhận NGUỒN (sản phẩm trong kho, kho kịch bản, hướng dẫn, mẫu tin, hồ sơ khách, lịch sử chat, tin khách vừa gửi) và TIN SẮP GỬI.',
    'Việc: liệt kê NGUYÊN VĂN các câu trong tin có KHẲNG ĐỊNH SỰ THẬT hoặc CAM KẾT mà NGUỒN không nêu',
    '(giá, phí ship, khuyến mãi, còn hàng, thời gian giao, bảo hành / đổi trả, thông số, "sẽ gửi", con số).',
    'CÓ CĂN CỨ (không liệt kê): tên món, giá lẻ / CTV / NPP, ngưỡng số lượng, còn hàng từ <san_pham_trong_kho>; tổng tiền = giá × số lượng;',
    'nói món trong ảnh khách gửi ("[Khách gửi ảnh: …]") chính là món trong kho khi loại / thương hiệu / dung tích khớp; "em gửi ảnh anh/chị xem";',
    'lời chào, giới thiệu trợ lý, cảm ơn, câu hỏi lại, câu ghi nhận, câu hẹn "em kiểm tra rồi báo lại".',
    badMoney.length
      ? `Hệ thống đã đối chiếu: số tiền ${badMoney.map((n) => n.toLocaleString('vi-VN') + 'đ').join(', ')} KHÔNG đúng giá của món đang tư vấn → phải sửa.`
        + (p.moneySources ? ` Giá ĐÚNG của món đang tư vấn: ${p.moneySources.replace(/\n/g, ' | ')} — sửa về đúng giá này (hoặc tổng = giá × số lượng).` : '')
      : 'Hệ thống đã đối chiếu: mọi số tiền trong tin đều có trong nguồn.',
    'Nếu có câu không căn cứ: kèm "rewrite" = toàn bộ tin, giữ NGUYÊN VĂN mọi câu khác, chỉ sửa câu sai (sai giá thì thay bằng giá đúng nếu hệ thống đã đưa; không có thì thay bằng câu hẹn kiểm tra và báo lại).',
    'Trả DUY NHẤT JSON: {"unsupported": ["câu nguyên văn"], "rewrite": "tin đã viết lại, rỗng nếu không có câu nào"}',
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
    const parsed = JSON.parse(t.slice(a, b + 1)) as { unsupported?: unknown; rewrite?: unknown; ok?: unknown };
    const flagged = (Array.isArray(parsed.unsupported) ? parsed.unsupported : [])
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    // Code thẩm tra lại: bỏ các câu báo nhầm (chỉ chứa giá / tổng tiền đúng nguồn, không nhắc chính sách).
    const real = flagged.filter((sentence) => isRealGroundingIssue(sentence, p.sources));
    if (real.length === 0 && badMoney.length === 0) return { ok: true, text: p.reply };
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

  const tags = await conversationTagsWithLive(conv, cfg.triggerTags);
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
  // Ảnh khách gửi (vd ảnh sản phẩm hỏi "có bán không") — AI sẽ nhìn ảnh ở bước sau.
  const imageUrls = pending
    .filter((m) => m.contentType === 'image')
    .map((m) => imageUrlOf(m.content))
    .filter((u): u is string => !!u);
  if (texts.length === 0 && imageUrls.length === 0) return { decision: 'skipped', reason: 'khách chỉ gửi sticker / tệp' };
  let customerText = texts.join('\n');

  const convInfo = conv as { id: string; zaloAccountId: string; externalThreadId: string; contactId: string | null };

  /**
   * Chuyển cho người thật: (1) nói 1 câu với khách nếu có (không đánh dấu "đã trả lời"
   * để hội thoại vẫn nằm ở Chưa rep cho nhân viên thấy), (2) ghi nhật ký,
   * (3) báo Telegram chủ shop theo mẫu của skill.
   */
  const handoff = async (reason: string, reply: string | null, urgent: boolean): Promise<EvaluateResult> => {
    const say = reply?.trim() ? applyGuards(reply, customerText) : null;
    const live = !test && cfg.mode === 'auto';
    if (say && live) {
      try {
        await sendReply(orgId, convInfo, say, { markReplied: false });
      } catch (err: any) {
        logger.warn(`[ai-auto-reply] gửi câu báo chuyển người lỗi: ${err?.message ?? err}`);
      }
    }
    await log(lastPending.id, 'handoff', reason || 'AI chuyển người', say, Date.now() - started, customerText);
    if (!test && cfg.notifyHandoff) {
      const [contact, acc] = await Promise.all([
        conv.contactId
          ? prisma.contact.findUnique({ where: { id: conv.contactId }, select: { fullName: true, crmName: true, phone: true } })
          : null,
        prisma.zaloAccount.findUnique({ where: { id: conv.zaloAccountId }, select: { displayName: true } }),
      ]);
      void notifyHandoff({
        conversationId,
        nickName: acc?.displayName || 'Zalo',
        customerName: contact?.crmName || contact?.fullName || 'Khách',
        customerPhone: contact?.phone,
        urgent,
        reason,
        customerText,
        botReply: say && live ? say : null,
        dryRun: cfg.mode === 'dry_run',
      }, { chatId: cfg.handoffChatId, pauseMinutes: cfg.handoffPauseMinutes });
    }
    return { decision: 'handoff', reason, content: say ?? undefined };
  };

  const blocked = matchesAnyKeyword(customerText, cfg.blockedKeywords);
  if (blocked) return handoff(`KHẨN · khách nhắc tới "${blocked}"`, null, true);

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

  // Nhìn ảnh khách gửi → mô tả sản phẩm + truy vấn tra kho.
  const imageInsight = imageUrls.length
    ? await understandCustomerImages({ provider: ai.provider, apiKey, model: ai.model }, imageUrls, customerText)
    : null;
  if (imageUrls.length) {
    const note = imageInsight
      ? `[Khách gửi ${imageUrls.length > 1 ? `${imageUrls.length} ảnh` : 'ảnh'}: ${imageInsight.summary}]`
      : '[Khách gửi ảnh nhưng hệ thống chưa xem được ảnh — hỏi khách tên / loại món trong ảnh]';
    customerText = [customerText, note].filter(Boolean).join('\n');
  }

  // Tài liệu tham khảo của skill: file "luôn dùng" + file khớp chủ đề câu khách hỏi.
  const references = pickGuideFiles(cfg.guideFiles ?? [], customerText);
  // Xưng hô theo giới tính Zalo của khách (nữ → chị, nam → anh).
  const addressing = cfg.addressByGender
    ? { selfPronoun: cfg.selfPronoun || 'em', gender: await resolveCustomerGender(conv) }
    : null;
  // Vòng tự học: bài học đang bật của nick này.
  // Bài chủ shop dạy (teach/manual/feedback) luôn dùng; bài AI tự rút chỉ khi bật tự học.
  const { owner: ownerLessons, auto: autoLessons } = splitLessons(await activeLessons(conv.zaloAccountId));
  const lessons = cfg.learningEnabled ? autoLessons : [];
  const ctx = await buildAutoReplyContext({ orgId, conversationId, zaloAccountId: conv.zaloAccountId, contactId: conv.contactId, pendingCustomerText: customerText, tags });

  // Tra kho thật (bot-noi-bo): AI tách từ khoá sản phẩm → tìm hàng còn tồn + giá theo mức.
  let products: CatalogProduct[] = [];
  if (cfg.useProductCatalog && isCatalogEnabled()) {
    const textQueries = texts.length
      ? await extractProductQueries({ provider: ai.provider, apiKey, model: ai.model }, customerText, ctx.history)
      : [];
    // Truy vấn từ ảnh đứng trước (khách hỏi "cái này có bán không" thì ảnh mới nói món gì).
    const queries = [...(imageInsight?.queries ?? []), ...textQueries].slice(0, 4);
    if (queries.length) {
      products = await searchProducts(queries, 8).catch((err) => {
        logger.warn(`[ai-auto-reply] tra kho lỗi: ${err?.message ?? err}`);
        return [];
      });
    }
  }
  const productsBlock = renderProducts(products);

  let raw: string;
  try {
    raw = await generateText(ai.provider, apiKey, ai.model, buildSystemPrompt(cfg.persona, cfg.extraInstruction, lessons, references, addressing, productsBlock, {
      firstMessage: !ctx.history.some((h) => h.startsWith('shop')),
      ownerLessons,
    }), renderUserPrompt(ctx), 1000);
  } catch (err: any) {
    await log(lastPending.id, 'error', `gọi AI lỗi: ${err?.message ?? err}`);
    return { decision: 'error', reason: 'gọi AI lỗi' };
  }
  const decision = parseDecision(raw);
  if (!decision) {
    await log(lastPending.id, 'error', 'AI trả về không đúng định dạng', raw.slice(0, 1000));
    return { decision: 'error', reason: 'AI trả sai định dạng' };
  }
  if (decision.action === 'handoff') return handoff(decision.reason, decision.reply, decision.urgent);

  let text = applyGuards(decision.reply, customerText);
  let groundingRewrote = false;
  if (cfg.verifyGrounding) {
    const checked = await verifyGrounding({ provider: ai.provider, apiKey, model: ai.model, reply: text,
      moneySources: focusPriceSource(products, decision.productIds),
      sources: renderSources(ctx)
      // Tin khách đang chờ (kèm mô tả ảnh khách gửi) — thiếu phần này kiểm duyệt tưởng
      // "mẫu này bên em có bán" là bịa và viết lại thành "để em kiểm tra".
      + `\n\n<tin_khach_vua_gui>\n${customerText}\n</tin_khach_vua_gui>`
      + (cfg.extraInstruction?.trim() ? `\n\n<huong_dan_cua_shop>\n${cfg.extraInstruction.trim()}\n</huong_dan_cua_shop>` : '')
      + (references.length ? `\n\n${renderReferences(references)}` : '')
      + (productsBlock ? `\n\n${productsBlock}` : '')
      + ([...ownerLessons, ...lessons].length ? `\n\n<bai_hoc>\n${[...ownerLessons, ...lessons].map((l) => `- ${l}`).join('\n')}\n</bai_hoc>` : '') });
    if (!checked) {
      await log(lastPending.id, 'error', 'kiểm duyệt căn cứ lỗi, không gửi cho an toàn', text);
      return { decision: 'error', reason: 'kiểm duyệt lỗi' };
    }
    if (!checked.ok) {
      logger.info(`[ai-auto-reply] kiểm duyệt sửa tin conv=${conversationId}: "${text.slice(0, 120)}" → "${checked.text.slice(0, 120)}"`);
      text = applyGuards(checked.text, customerText);
      groundingRewrote = true;
    }
  }
  if (!text.trim()) {
    await log(lastPending.id, 'error', 'tin sau lớp chặn bị rỗng');
    return { decision: 'error', reason: 'tin rỗng' };
  }

  // Ảnh sản phẩm AI muốn gửi kèm (chỉ id có trong kết quả tra kho, có ảnh).
  const imageProducts = cfg.sendProductImages
    ? decision.productIds.map((id) => products.find((p) => p.id === id)).filter((p): p is CatalogProduct => !!p?.thumbnail).slice(0, 3)
    : [];
  const logText = imageProducts.length ? `${text}\n[Gửi ảnh: ${imageProducts.map((p) => p.name).join(', ')}]` : text;

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
  const productNote = (imageUrls.length ? ` · xem ${imageUrls.length} ảnh${imageInsight ? '' : ' (không đọc được)'}` : '')
    + (products.length ? ` · tra kho ${products.length} món` : '')
    + (groundingRewrote ? ' · kiểm duyệt đã sửa câu' : '');
  if (cfg.mode === 'dry_run' || test) {
    await log(lastPending.id, 'dry_run', `thẻ "${trigger}"${productNote} · ${decision.reason}`, logText, latency, customerText);
    return { decision: 'dry_run', reason: decision.reason, content: logText };
  }

  try {
    await sendReply(orgId, convInfo, text);
  } catch (err: any) {
    await log(lastPending.id, 'error', `gửi Zalo lỗi: ${err?.code ?? ''} ${err?.message ?? err}`, text, latency);
    return { decision: 'error', reason: 'gửi lỗi' };
  }
  if (imageProducts.length) {
    const api = zaloPool.getInstance(conv.zaloAccountId)?.api;
    if (api) {
      await sendToThread(api, orgId, conv.zaloAccountId, convInfo.externalThreadId, 0, '', imageProducts.map((p) => p.thumbnail!))
        .catch((err) => logger.warn(`[ai-auto-reply] gửi ảnh sản phẩm lỗi: ${err?.message ?? err}`));
    }
  }
  await log(lastPending.id, 'sent', `thẻ "${trigger}"${productNote} · ${decision.reason}`, logText, latency, customerText);
  logger.info(`[ai-auto-reply] đã trả lời conv=${conversationId} (${latency}ms)`);
  return { decision: 'sent', reason: decision.reason, content: logText };
}

/**
 * Lượt AI nhỏ: tách từ khoá sản phẩm khách đang hỏi (xét cả vài tin gần nhất để
 * hiểu "loại nào", "cái đó"). Không liên quan sản phẩm → []. Lỗi → [].
 */
export async function extractProductQueries(
  ai: { provider: string; apiKey: string; model: string },
  customerText: string,
  history: string[],
): Promise<ProductQuery[]> {
  const system = [
    'Bạn tách TỪ KHOÁ TÌM SẢN PHẨM trong kho của một cửa hàng (gia dụng, mỹ phẩm, ăn vặt, đồ chơi…) từ tin nhắn khách.',
    'Trả DUY NHẤT JSON: {"queries": [{"name": "tên loại sản phẩm ngắn gọn như trên nhãn, 1-4 từ, có dấu", "hints": ["đặc điểm khách muốn: giới tính, mùi, màu, dung tích, công dụng…"]}]}',
    'Tối đa 3 truy vấn, từ cụ thể đến chung (vd "nước hoa nữ" rồi "nước hoa"). Dùng lịch sử để hiểu khách đang nói về món nào.',
    'Tin không hỏi về sản phẩm (chào, cảm ơn, hỏi giờ mở cửa, địa chỉ, khiếu nại…) → {"queries": []}.',
  ].join('\n');
  const prompt = ['<lich_su_gan_day>', ...history.slice(-6), '</lich_su_gan_day>', '<tin_khach>', customerText.slice(0, 800), '</tin_khach>'].join('\n');
  try {
    const raw = await generateText(ai.provider, ai.apiKey, ai.model, system, prompt, 250);
    let t = raw.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a === -1 || b <= a) return [];
    const parsed = JSON.parse(t.slice(a, b + 1)) as { queries?: unknown };
    if (!Array.isArray(parsed.queries)) return [];
    return parsed.queries
      .filter((q): q is { name: string; hints?: unknown } => !!q && typeof (q as any).name === 'string' && (q as any).name.trim().length >= 2)
      .slice(0, 3)
      .map((q) => ({
        name: q.name.trim().slice(0, 60),
        hints: Array.isArray(q.hints) ? q.hints.filter((h): h is string => typeof h === 'string').slice(0, 5) : [],
      }));
  } catch {
    return [];
  }
}

async function sendReply(
  orgId: string,
  conv: { id: string; zaloAccountId: string; externalThreadId: string; contactId: string | null },
  text: string,
  opts: { markReplied?: boolean } = {},
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
    // Chuyển người: vẫn để "chưa rep" để nhân viên thấy mà vào xử lý.
    data: opts.markReplied === false ? { lastMessageAt: sentAt } : { lastMessageAt: sentAt, isReplied: true, unreadCount: 0 },
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
  if (!matchTriggerTag(await conversationTagsWithLive(conv, cfg.triggerTags), cfg.triggerTags)) return null;
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

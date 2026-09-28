/**
 * classify-flow.ts — quyết định AI trả lời ai (khách / nhân viên) cho 1 lượt tin 1-1, và vòng quét
 * gửi câu hỏi danh tính khi đã chờ đủ `askDelayMinutes` mà chủ nick chưa trả lời.
 *
 * Việc gửi tin / ghi nhật ký / lấy giới tính do auto-reply-service truyền vào (tránh import vòng).
 */
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import { getAiConfig, getProviderApiKey } from '../ai-service.js';
import { parseOffsetMinutes } from '../daily-brief-service.js';
import { getProfile, type AutoReplyProfile } from './config-service.js';
import {
  applyGroupLabel, buildAskQuestion, classifyAnswer, classifyContactByAi, groupOfTags, missingCoreLabels,
  MIN_CONFIDENCE, GROUP_LABEL_TEXT, type ContactGroup,
} from './contact-classifier.js';
import { localHour, withinHours } from './guardrails.js';

type Conv = { id: string; zaloAccountId: string; externalThreadId: string; contactId: string | null };
type AiRef = { provider: string; apiKey: string; model: string };

export type AudienceDecision =
  | { kind: 'reply'; audience: 'customer' | 'staff'; via: string; justAnswered?: boolean }
  | {
      kind: 'stop';
      reason: string;
      /** Ghi nhật ký lượt này (bỏ qua người thân / thẻ khác thì không ghi cho đỡ rối). */
      log?: boolean;
      /** Báo Telegram chủ nick. */
      notify?: string;
      /** Gửi 1 câu ngắn cho người nhắn (vd người thân vừa trả lời câu hỏi danh tính). */
      say?: string;
    };

async function aiRef(orgId: string): Promise<AiRef | null> {
  const ai = await getAiConfig(orgId);
  if (!ai.enabled) return null;
  const apiKey = await getProviderApiKey(orgId, ai.provider);
  return apiKey ? { provider: ai.provider, apiKey, model: ai.model } : null;
}

async function recentHistory(conversationId: string): Promise<string[]> {
  const msgs = await prisma.message.findMany({
    where: { conversationId, isDeleted: false },
    orderBy: { sentAt: 'desc' },
    take: 30,
    select: { senderType: true, content: true, contentType: true, sentVia: true },
  });
  return msgs.reverse().map((m) => {
    const who = m.senderType === 'self' ? (m.sentVia === 'automation' ? 'shop (AI)' : 'shop') : 'người nhắn';
    const text = m.contentType === 'text' || m.contentType === 'rich' ? (m.content ?? '').slice(0, 300) : `(gửi ${m.contentType})`;
    return `${who}: ${text}`;
  });
}

/** AI chỉ tự xếp KHÁCH HÀNG (và người thân để im). Nhân viên do chủ nick tự gắn thẻ Nhân Viên. */
function audienceOf(g: ContactGroup): 'customer' | null {
  return g === 'customer' ? g : null;
}

const STAFF_NOTE = 'Có vẻ là NHÂN VIÊN nhưng chưa có thẻ Nhân Viên — anh gắn thẻ Nhân Viên trên Zalo nếu đúng, AI sẽ trả lời theo kiểu nhân viên';

/**
 * Lượt tin này AI trả lời ai. zaloLabels = thẻ Zalo đang có của người nhắn (null = không đọc được Zalo),
 * nickLabelNames = mọi thẻ Zalo của nick (để biết đủ 3 thẻ chính chưa), crmTags = Tag CRM + thẻ trong DB.
 */
export async function resolveAudience(p: {
  orgId: string;
  conv: Conv;
  cfg: AutoReplyProfile;
  zaloLabels: string[] | null;
  nickLabelNames: string[] | null;
  crmTags: string[];
  pendingText: string;
  lastPendingAt: Date;
  displayName: string | null;
  test?: boolean;
}): Promise<AudienceDecision> {
  const { orgId, conv, cfg, test } = p;

  // 1. Đã có thẻ → theo thẻ.
  const byTag = groupOfTags(p.zaloLabels ?? [], p.crmTags, cfg);
  const row = await prisma.aiContactClass.findUnique({ where: { conversationId: conv.id } });
  if (byTag?.group === 'waiting') return { kind: 'stop', reason: `đang chờ người thật xử lý (thẻ "${byTag.tag}")` };
  if (byTag) {
    if (row && row.state !== 'classified' && !test) {
      await prisma.aiContactClass.update({
        where: { id: row.id },
        data: { state: 'classified', source: 'label', group: byTag.group === 'ignore' ? 'other' : byTag.group, reason: `thẻ "${byTag.tag}"` },
      }).catch(() => {});
    }
    if (byTag.group === 'customer' || byTag.group === 'staff') return { kind: 'reply', audience: byTag.group, via: `thẻ "${byTag.tag}"` };
    return { kind: 'stop', reason: byTag.group === 'family' ? `người thân (thẻ "${byTag.tag}")` : `thẻ "${byTag.tag}" không thuộc nhóm AI trả lời` };
  }
  if (!cfg.classifyContacts) return { kind: 'stop', reason: 'không có thẻ kích hoạt' };
  if (p.zaloLabels === null) return { kind: 'stop', reason: 'không đọc được thẻ Zalo, để lượt sau' };
  const missing = missingCoreLabels(p.nickLabelNames ?? []);
  if (missing.length) return { kind: 'stop', reason: `nick chưa có thẻ ${missing.join(', ')} trên Zalo` };

  /** Kết luận nhóm: gắn thẻ Zalo (nếu là 3 nhóm chính) + lưu trạng thái. */
  const settle = async (group: ContactGroup, source: 'ai' | 'answer', confidence: number, reason: string): Promise<AudienceDecision | null> => {
    let labelApplied = false;
    if (!test && (group === 'customer' || group === 'family')) {
      const res = await applyGroupLabel(orgId, conv.zaloAccountId, conv.externalThreadId, group);
      if (res === 'already_labeled') return { kind: 'stop', reason: 'người nhắn vừa được gắn thẻ, xét lại lượt sau' };
      labelApplied = res === 'applied';
    }
    if (!test) {
      await prisma.aiContactClass.upsert({
        where: { conversationId: conv.id },
        create: { orgId, zaloAccountId: conv.zaloAccountId, conversationId: conv.id, group, state: 'classified', source, confidence, reason, labelApplied, answeredAt: source === 'answer' ? new Date() : null },
        update: { group, state: 'classified', source, confidence, reason, labelApplied, ...(source === 'answer' ? { answeredAt: new Date() } : {}) },
      });
    }
    return null;
  };

  // 2. Đã từng xét hội thoại này.
  if (row) {
    if (row.state === 'classified') {
      // AI từng gắn thẻ mà giờ không còn thẻ → anh đã gỡ thẻ: tôn trọng, AI im.
      // (Chờ 2 phút sau lúc gắn: Zalo có thể trả danh sách thẻ cũ vài giây.)
      if (row.labelApplied && Date.now() - row.updatedAt.getTime() > 2 * 60_000) {
        if (!test) await prisma.aiContactClass.update({ where: { id: row.id }, data: { state: 'owner_cleared' } }).catch(() => {});
        return { kind: 'stop', reason: 'chủ nick đã gỡ thẻ AI gắn' };
      }
      const aud = audienceOf(row.group as ContactGroup);
      if (!aud) return { kind: 'stop', reason: row.group === 'family' ? 'người thân' : 'không thuộc nhóm AI trả lời' };
      // Lần trước gắn thẻ lỗi → thử gắn lại.
      if (!test) await applyGroupLabel(orgId, conv.zaloAccountId, conv.externalThreadId, aud).then((r) => {
        if (r === 'applied') return prisma.aiContactClass.update({ where: { id: row.id }, data: { labelApplied: true } });
      }).catch(() => {});
      return { kind: 'reply', audience: aud, via: `AI đã xếp nhóm ${GROUP_LABEL_TEXT[aud]}` };
    }
    if (row.state === 'owner_cleared') return { kind: 'stop', reason: 'chủ nick đã gỡ thẻ AI gắn' };
    if (row.state === 'unresolved') return { kind: 'stop', reason: 'chưa xác định được người nhắn (đã báo chủ nick)' };
    if (row.state === 'asked') {
      const ai = await aiRef(orgId);
      if (!ai) return { kind: 'stop', reason: 'AI tắt / thiếu khoá' };
      const q = await prisma.message.findFirst({
        where: { conversationId: conv.id, senderType: 'self', sentVia: 'automation' },
        orderBy: { sentAt: 'desc' },
        select: { content: true },
      });
      const res = await classifyAnswer(ai, q?.content ?? 'Anh/chị là khách hàng, nhân viên hay người thân?', p.pendingText);
      if (res.group === 'staff' && res.confidence >= 0.6) {
        if (!test) await prisma.aiContactClass.update({ where: { id: row.id }, data: { state: 'unresolved', group: 'staff', reason: res.reason, answeredAt: new Date() } }).catch(() => {});
        return { kind: 'stop', log: true, reason: `tự nhận là nhân viên (${res.reason})`, notify: STAFF_NOTE };
      }
      if ((res.group === 'customer' || res.group === 'family') && res.confidence >= 0.6) {
        const early = await settle(res.group, 'answer', res.confidence, res.reason);
        if (early) return early;
        if (res.group === 'family') {
          const chu = cfg.ownerTitle?.trim() || 'chủ shop';
          const toi = cfg.selfPronoun?.trim() || 'em';
          return { kind: 'stop', reason: 'người nhắn là người thân (tự trả lời)', log: true, say: `Dạ ${toi} cảm ơn, ${toi} báo ${chu} liền ạ.`, notify: 'Người thân nhắn (đã tự xác nhận) — AI không trả lời tiếp' };
        }
        return { kind: 'reply', audience: res.group, via: `tự xác nhận là ${GROUP_LABEL_TEXT[res.group]}`, justAnswered: true };
      }
      if (!test) {
        await prisma.aiContactClass.update({
          where: { id: row.id },
          data: { state: res.group === 'other' ? 'classified' : 'unresolved', group: res.group === 'other' ? 'other' : 'unknown', reason: res.reason, answeredAt: new Date() },
        }).catch(() => {});
      }
      return {
        kind: 'stop', log: true,
        reason: res.group === 'other' ? `người nhắn không thuộc 3 nhóm (${res.reason})` : `chưa rõ người nhắn sau khi hỏi (${res.reason})`,
        notify: 'Người nhắn chưa rõ là khách / nhân viên / người thân — cần anh xem',
      };
    }
    // 'asking': đang chờ hỏi — tin mới có thể đã đủ rõ, thử phân loại lại.
  }

  // 3. Chưa có thẻ → AI đoán.
  const ai = await aiRef(orgId);
  if (!ai) return { kind: 'stop', reason: 'AI tắt / thiếu khoá' };
  const res = await classifyContactByAi(ai, {
    displayName: p.displayName,
    ownerTitle: cfg.ownerTitle,
    history: await recentHistory(conv.id),
    pendingText: p.pendingText,
  });
  // Giống nhân viên: không gắn thẻ, không hỏi — báo anh tự gắn thẻ Nhân Viên.
  if (res.group === 'staff' && res.confidence >= MIN_CONFIDENCE) {
    if (!test) {
      await prisma.aiContactClass.upsert({
        where: { conversationId: conv.id },
        create: { orgId, zaloAccountId: conv.zaloAccountId, conversationId: conv.id, group: 'staff', state: 'unresolved', source: 'ai', confidence: res.confidence, reason: res.reason },
        update: { group: 'staff', state: 'unresolved', source: 'ai', confidence: res.confidence, reason: res.reason },
      }).catch(() => {});
    }
    return { kind: 'stop', log: true, reason: `AI thấy giống nhân viên (${res.reason})`, notify: STAFF_NOTE };
  }
  if (res.group !== 'unknown' && res.confidence >= MIN_CONFIDENCE) {
    const early = await settle(res.group, 'ai', res.confidence, res.reason);
    if (early) return early;
    const aud = audienceOf(res.group);
    if (aud) return { kind: 'reply', audience: aud, via: `AI xếp nhóm ${GROUP_LABEL_TEXT[aud]} (${res.reason})` };
    return { kind: 'stop', log: true, reason: res.group === 'family' ? `AI xếp người thân (${res.reason})` : `AI xếp ngoài 3 nhóm (${res.reason})` };
  }
  // Chưa rõ → hẹn hỏi sau askDelayMinutes (giữ hẹn cũ nếu đang chờ).
  if (!test && !row) {
    await prisma.aiContactClass.create({
      data: {
        orgId, zaloAccountId: conv.zaloAccountId, conversationId: conv.id, group: 'unknown', state: 'asking',
        reason: res.reason, confidence: res.confidence,
        askDueAt: new Date(p.lastPendingAt.getTime() + Math.max(0, cfg.askDelayMinutes) * 60_000),
      },
    }).catch(() => {}); // trùng khoá (2 lượt cùng lúc) → bỏ qua
  }
  return { kind: 'stop', log: !row, reason: `chưa rõ người nhắn, chờ ${cfg.askDelayMinutes} phút rồi hỏi (${res.reason})` };
}

// ── Vòng quét gửi câu hỏi danh tính ────────────────────────────────────────

export type SweepDeps = {
  send: (orgId: string, conv: Conv, text: string) => Promise<void>;
  gender: (conv: Conv) => Promise<'male' | 'female' | null>;
  threadLabels: (zaloAccountId: string, threadId: string) => Promise<string[] | null>;
  log: (t: { orgId: string; conversationId: string; zaloAccountId: string }, decision: 'sent' | 'dry_run' | 'error', reason: string, content?: string) => Promise<void>;
};

/** Gửi câu hỏi cho các hội thoại đã chờ đủ lâu. Trả số câu hỏi đã gửi. */
export async function processDueAsks(deps: SweepDeps, now = new Date()): Promise<number> {
  const due = await prisma.aiContactClass.findMany({
    where: { state: 'asking', askDueAt: { lte: now } },
    orderBy: { askDueAt: 'asc' },
    take: 20,
  });
  let sent = 0;
  for (const row of due) {
    try {
      const drop = () => prisma.aiContactClass.delete({ where: { id: row.id } }).catch(() => {});
      const cfg = await getProfile(row.orgId, row.zaloAccountId, { fresh: true });
      if (!cfg?.enabled || !cfg.classifyContacts) { await drop(); continue; }
      const conv = await prisma.conversation.findFirst({
        where: { id: row.conversationId },
        select: { id: true, zaloAccountId: true, externalThreadId: true, contactId: true, orgId: true },
      });
      if (!conv?.externalThreadId) { await drop(); continue; }
      // Chủ nick đã tự trả lời trong lúc chờ → thôi hỏi (lượt tin sau AI xét lại với lịch sử mới).
      const ownerReplied = await prisma.message.findFirst({
        where: { conversationId: conv.id, senderType: 'self', isDeleted: false, NOT: { sentVia: 'automation' }, sentAt: { gt: row.createdAt } },
        select: { id: true },
      });
      if (ownerReplied) { await drop(); continue; }
      const labels = await deps.threadLabels(conv.zaloAccountId, conv.externalThreadId);
      if (labels === null) continue; // Zalo chưa đọc được → thử lại vòng sau
      if (labels.length) { await drop(); continue; } // anh đã gắn thẻ trong lúc chờ
      const org = await prisma.organization.findUnique({ where: { id: row.orgId }, select: { timezone: true } });
      if (!withinHours(localHour(now, parseOffsetMinutes(org?.timezone)), cfg.hourStart, cfg.hourEnd)) continue;

      const c: Conv = { id: conv.id, zaloAccountId: conv.zaloAccountId, externalThreadId: conv.externalThreadId, contactId: conv.contactId };
      const question = buildAskQuestion(cfg.askTemplate, { gender: await deps.gender(c), ownerTitle: cfg.ownerTitle, selfPronoun: cfg.selfPronoun });
      const target = { orgId: row.orgId, conversationId: conv.id, zaloAccountId: conv.zaloAccountId };
      if (cfg.mode === 'dry_run') {
        await prisma.aiContactClass.update({ where: { id: row.id }, data: { state: 'unresolved', reason: 'chạy thử: không gửi câu hỏi' } });
        await deps.log(target, 'dry_run', 'hỏi danh tính (chạy thử, không gửi)', question);
        continue;
      }
      // Giữ chỗ trước khi gửi để 2 vòng quét không gửi trùng.
      const claimed = await prisma.aiContactClass.updateMany({ where: { id: row.id, state: 'asking' }, data: { state: 'asked', askedAt: now } });
      if (claimed.count !== 1) continue;
      try {
        await deps.send(row.orgId, c, question);
      } catch (err: any) {
        await prisma.aiContactClass.update({ where: { id: row.id }, data: { state: 'asking', askedAt: null, askDueAt: new Date(now.getTime() + 5 * 60_000) } });
        await deps.log(target, 'error', `gửi câu hỏi danh tính lỗi: ${err?.message ?? err}`, question);
        continue;
      }
      await deps.log(target, 'sent', 'hỏi danh tính (khách hàng / người thân)', question);
      sent++;
    } catch (err) {
      logger.warn(`[ai-classify] vòng quét lỗi conv=${row.conversationId}:`, err);
    }
  }
  return sent;
}

let sweeper: NodeJS.Timeout | null = null;
export function startClassifySweeper(deps: SweepDeps): void {
  if (sweeper) return;
  sweeper = setInterval(() => void processDueAsks(deps).catch((err) => logger.warn('[ai-classify] vòng quét lỗi:', err)), 60_000);
  sweeper.unref?.();
}

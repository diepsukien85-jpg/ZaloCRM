/**
 * handoff-hold.ts — AI chuyển cho người thật → gắn thẻ Zalo "Chờ người thật".
 *
 * Telegram nhiều tin dễ sót; thẻ Zalo là "hộp việc" anh mở ra xem trên app Zalo / CRM bất cứ lúc nào.
 *   - AI chuyển người (khách hoặc nhân viên) → dời hội thoại sang thẻ "Chờ người thật", NHỚ thẻ cũ
 *     (Zalo chỉ cho 1 thẻ / người) — AI im khi hội thoại mang thẻ này.
 *   - Người thật (anh / nhân viên, không phải AI) nhắn trả lời trong hội thoại → vòng quét trả lại thẻ cũ
 *     (không có thẻ cũ → gỡ thẻ) → AI làm việc lại.
 *   - Anh tự đổi thẻ khỏi "Chờ người thật" → tôn trọng, chỉ đóng phiếu giữ.
 * Nick chưa tạo thẻ "Chờ người thật" → bỏ qua (vẫn báo Telegram như cũ).
 */
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import { zaloOps } from '../../../shared/zalo-operations.js';
import { zaloPool } from '../../zalo/zalo-pool.js';
import { _dropNickLabelCache, coreGroupOfLabel, GROUP_LABEL_TEXT } from './contact-classifier.js';
import { normalizeTagName } from './guardrails.js';

type SdkLabel = { id?: number | string; text?: string; conversations?: unknown[] } & Record<string, unknown>;

/**
 * Dời 1 người sang thẻ khác (Zalo 1 thẻ / người). `target` = tên thẻ (so theo tên chuẩn hoá) hoặc null = gỡ thẻ.
 * `onlyIfCurrent`: chỉ dời khi thẻ hiện tại đúng là thẻ này (tránh ghi đè thẻ anh vừa tự đổi).
 * Trả { status, prev } — prev = tên thẻ đang gắn trước khi dời.
 */
export async function moveThreadLabel(
  orgId: string, zaloAccountId: string, threadId: string, target: string | null,
  opts: { onlyIfCurrent?: string } = {},
): Promise<{ status: 'moved' | 'missing_label' | 'not_current' | 'same' | 'error'; prev: string | null }> {
  if (zaloPool.getInstance(zaloAccountId)?.status !== 'connected') return { status: 'error', prev: null };
  try {
    const out = await zaloOps.exec(
      { accountId: zaloAccountId, category: 'friend_action', operation: 'updateLabels(ai-hold)' },
      async (api: any) => {
        const cur = await api.getLabels() as { labelData?: SdkLabel[]; version?: number };
        const labelData = (cur?.labelData ?? []).map((l) => ({ ...l, conversations: Array.isArray(l.conversations) ? l.conversations.map(String) : [] }));
        const current = labelData.find((l) => l.conversations.includes(threadId));
        const prev = current ? String(current.text ?? '') : null;
        if (opts.onlyIfCurrent && normalizeTagName(prev ?? '') !== normalizeTagName(opts.onlyIfCurrent)) return { status: 'not_current' as const, prev };
        const dest = target ? labelData.find((l) => normalizeTagName(String(l.text ?? '')) === normalizeTagName(target)) : null;
        if (target && !dest) return { status: 'missing_label' as const, prev };
        if (dest && current === dest) return { status: 'same' as const, prev };
        for (const l of labelData) l.conversations = l.conversations.filter((c) => c !== threadId);
        if (dest) dest.conversations.push(threadId);
        const written = await api.updateLabels({ labelData, version: cur?.version ?? 0 }) as { labelData?: SdkLabel[]; version?: number };
        return { status: 'moved' as const, prev, labelData: written?.labelData ?? labelData, version: written?.version ?? cur?.version ?? 0 };
      },
    ) as { status: 'moved' | 'missing_label' | 'not_current' | 'same'; prev: string | null; labelData?: SdkLabel[]; version?: number };
    if (out.status === 'moved') {
      _dropNickLabelCache(zaloAccountId);
      void import('../../zalo/zalo-labels-routes.js')
        .then((m) => m.syncLabelsForAccount(zaloAccountId, orgId, { seedLabelData: out.labelData as any, seedVersion: out.version, affectedUidsOnly: [threadId] }))
        .catch((err) => logger.debug(`[ai-hold] đồng bộ thẻ về CRM lỗi: ${err?.message ?? err}`));
    }
    return { status: out.status, prev: out.prev };
  } catch (err: any) {
    logger.warn(`[ai-hold] dời thẻ lỗi ${threadId}: ${err?.message ?? err}`);
    return { status: 'error', prev: null };
  }
}

/** AI chuyển người → gắn thẻ "Chờ người thật". Trả true nếu đã gắn (hoặc đang giữ sẵn). */
export async function holdForHuman(p: { orgId: string; zaloAccountId: string; conversationId: string; threadId: string; reason: string }): Promise<boolean> {
  const open = await prisma.aiHandoffHold.findFirst({ where: { conversationId: p.conversationId, releasedAt: null }, select: { id: true } });
  if (open) return true;
  const res = await moveThreadLabel(p.orgId, p.zaloAccountId, p.threadId, GROUP_LABEL_TEXT.waiting);
  if (res.status === 'same') return true;
  if (res.status !== 'moved') return false;
  await prisma.aiHandoffHold.create({
    data: {
      orgId: p.orgId, zaloAccountId: p.zaloAccountId, conversationId: p.conversationId, threadId: p.threadId,
      // Đang ở thẻ "Chờ người thật" từ trước (hiếm) thì không coi là thẻ cũ.
      prevLabel: res.prev && coreGroupOfLabel(res.prev) !== 'waiting' ? res.prev : null,
      reason: p.reason.slice(0, 300),
    },
  });
  logger.info(`[ai-hold] gắn thẻ "Chờ người thật" conv=${p.conversationId} (thẻ cũ: ${res.prev ?? 'không có'})`);
  return true;
}

/** Hàm thuần: có tin NGƯỜI THẬT trả lời sau lúc giữ không (bỏ tin AI + ảnh AI gửi kèm ≤30s sau tin AI). */
export function humanRepliedAfter(
  heldAt: Date,
  selfMessages: Array<{ sentAt: Date; sentVia: string | null; contentType: string | null }>,
): boolean {
  const auto = selfMessages.filter((m) => m.sentVia === 'automation').map((m) => m.sentAt.getTime());
  return selfMessages.some((m) => m.sentAt > heldAt && m.sentVia !== 'automation'
    && !(m.contentType !== 'text' && m.contentType !== 'rich' && auto.some((a) => a <= m.sentAt.getTime() && m.sentAt.getTime() - a < 30_000)));
}

/** Vòng quét: người thật đã trả lời → trả lại thẻ cũ. Trả số phiếu đã đóng. */
export async function releaseHolds(): Promise<number> {
  const holds = await prisma.aiHandoffHold.findMany({ where: { releasedAt: null }, orderBy: { heldAt: 'asc' }, take: 50 });
  let closed = 0;
  for (const h of holds) {
    try {
      const self = await prisma.message.findMany({
        where: { conversationId: h.conversationId, senderType: 'self', isDeleted: false, sentAt: { gt: new Date(h.heldAt.getTime() - 60_000) } },
        orderBy: { sentAt: 'asc' },
        take: 30,
        select: { sentAt: true, sentVia: true, contentType: true },
      });
      if (!humanRepliedAfter(h.heldAt, self)) continue;
      const res = await moveThreadLabel(h.orgId, h.zaloAccountId, h.threadId, h.prevLabel, { onlyIfCurrent: GROUP_LABEL_TEXT.waiting });
      if (res.status === 'error') continue; // nick mất kết nối → thử lại vòng sau
      const note = res.status === 'moved' ? `người thật đã trả lời → trả thẻ ${h.prevLabel ? `"${h.prevLabel}"` : '(không thẻ)'}`
        : res.status === 'not_current' ? `anh đã tự đổi thẻ (${res.prev ?? 'không thẻ'})`
        : res.status === 'missing_label' ? `thẻ cũ "${h.prevLabel}" không còn → giữ nguyên` : 'đã đúng thẻ';
      if (res.status === 'missing_label') await moveThreadLabel(h.orgId, h.zaloAccountId, h.threadId, null, { onlyIfCurrent: GROUP_LABEL_TEXT.waiting });
      await prisma.aiHandoffHold.update({ where: { id: h.id }, data: { releasedAt: new Date(), releaseNote: note } });
      logger.info(`[ai-hold] đóng phiếu conv=${h.conversationId}: ${note}`);
      closed++;
    } catch (err) {
      logger.warn(`[ai-hold] vòng quét lỗi conv=${h.conversationId}:`, err);
    }
  }
  return closed;
}

let timer: NodeJS.Timeout | null = null;
export function startHoldReleaser(): void {
  if (timer) return;
  timer = setInterval(() => void releaseHolds().catch((err) => logger.warn('[ai-hold] vòng quét lỗi:', err)), 60_000);
  timer.unref?.();
}

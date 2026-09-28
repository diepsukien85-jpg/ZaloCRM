/**
 * handoff-hold.ts — AI chuyển cho người thật → gắn thẻ Zalo "Chờ người thật".
 *
 * Telegram nhiều tin dễ sót; thẻ Zalo là "hộp việc" anh mở ra xem trên app Zalo / CRM bất cứ lúc nào.
 *   - AI chuyển người (khách hoặc nhân viên) → dời hội thoại sang thẻ "Chờ người thật", NHỚ thẻ cũ
 *     (Zalo chỉ cho 1 thẻ / người) — AI im khi hội thoại mang thẻ này.
 *   - Hội thoại NẰM YÊN ở thẻ này cho tới khi ANH tự đổi thẻ (Sếp chọn 28/09/2026 — tự trả thẻ khi có tin
 *     "người thật" dễ sai: tin do máy gửi qua API/chào hàng cũng ghi như tin gõ tay, và trả lời 1 câu là rời thẻ, dễ quên việc).
 *   - Anh đổi thẻ khác → AI làm việc lại theo thẻ mới; vòng quét chỉ đóng phiếu giữ (ghi thẻ anh đã chọn).
 * Nick chưa tạo thẻ "Chờ người thật" → bỏ qua (vẫn báo Telegram như cũ).
 */
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import { zaloOps } from '../../../shared/zalo-operations.js';
import { zaloPool } from '../../zalo/zalo-pool.js';
import { _dropNickLabelCache, coreGroupOfLabel, GROUP_LABEL_TEXT, threadZaloLabels } from './contact-classifier.js';
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

/** Vòng quét: hội thoại anh đã tự đổi khỏi thẻ "Chờ người thật" → đóng phiếu giữ. KHÔNG tự dời thẻ. */
export async function releaseHolds(): Promise<number> {
  const holds = await prisma.aiHandoffHold.findMany({ where: { releasedAt: null }, orderBy: { heldAt: 'asc' }, take: 100 });
  let closed = 0;
  for (const h of holds) {
    try {
      const labels = await threadZaloLabels(h.zaloAccountId, h.threadId);
      if (labels === null) continue; // nick mất kết nối → vòng sau
      if (labels.some((l) => coreGroupOfLabel(l) === 'waiting')) continue; // vẫn chờ anh xử lý
      const note = `anh đã đổi thẻ → ${labels.length ? labels.map((l) => `"${l}"`).join(', ') : '(không thẻ)'}`;
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

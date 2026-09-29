/**
 * avatar-refresh-service.ts — làm mới link avatar Zalo đã hết hạn.
 *
 * Link avatar Zalo có chữ ký kèm hạn dùng (`...jpg?key=...&time=<epoch giây>`).
 * Quá hạn thì CDN trả 403 → cửa sổ chat chỉ còn chữ viết tắt. Trước đây
 * updateContactAvatar chỉ ghi khi avatarUrl còn trống, nên link cũ không bao giờ
 * được thay (đo prod 26/09/2026: 23.542 / 32.665 avatar khách đã hết hạn).
 *
 * Làm mới theo yêu cầu: FE gửi các hội thoại đang hiển thị có avatar hết hạn →
 * gọi getUserInfo THEO LÔ qua chính nick của hội thoại (đi qua rate limiter
 * category 'query'), ghi lại Contact.avatarUrl + Friend.zaloAvatarUrl.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { zaloOps } from '../../shared/zalo-operations.js';
import { zaloPool } from '../zalo/zalo-pool.js';

const BATCH_SIZE = 50;
/** Không hỏi lại cùng (nick, uid) trong khoảng này — kể cả khi Zalo không trả avatar. */
const COOLDOWN_MS = 30 * 60_000;
/** Coi như hết hạn sớm hơn 1 giờ để khỏi trả về link sắp chết. */
const EXPIRY_MARGIN_MS = 60 * 60_000;

const lastTried = new Map<string, number>();

/** Hạn dùng của link avatar Zalo (từ tham số `time=`), null nếu link không có hạn. */
export function zaloAvatarExpiresAt(url: string | null | undefined): Date | null {
  if (!url) return null;
  const m = /[?&]time=(\d{9,11})(?:&|$)/.exec(url);
  return m ? new Date(Number(m[1]) * 1000) : null;
}

/** Link trống hoặc đã/sắp hết hạn. Link không có `time=` (vd ảnh mặc định) coi là còn dùng được. */
export function isAvatarStale(url: string | null | undefined, now = Date.now()): boolean {
  if (!url) return true;
  const exp = zaloAvatarExpiresAt(url);
  return exp !== null && exp.getTime() - EXPIRY_MARGIN_MS <= now;
}

function pickAvatar(profile: Record<string, unknown> | undefined): string | null {
  const url = profile && typeof profile.avatar === 'string' ? profile.avatar.trim() : '';
  return url && /^https?:\/\//.test(url) ? url : null;
}

export type AvatarRefreshResult = Record<string, string>; // conversationId → avatarUrl mới

/**
 * Làm mới avatar cho các hội thoại 1-1 (thuộc orgId) có avatar trống/hết hạn.
 * Trả về map conversationId → link mới cho những hội thoại lấy được link.
 */
export async function refreshConversationAvatars(orgId: string, conversationIds: string[]): Promise<AvatarRefreshResult> {
  if (conversationIds.length === 0) return {};
  const convs = await prisma.conversation.findMany({
    where: { id: { in: conversationIds }, orgId, threadType: 'user', contactId: { not: null }, externalThreadId: { not: null } },
    select: {
      id: true, zaloAccountId: true, externalThreadId: true, contactId: true,
      contact: { select: { avatarUrl: true } },
    },
  });

  const friendRows = convs.length
    ? await prisma.friend.findMany({
        where: { OR: convs.map((c) => ({ zaloAccountId: c.zaloAccountId, zaloUidInNick: c.externalThreadId! })) },
        select: { zaloAccountId: true, zaloUidInNick: true, zaloAvatarUrl: true },
      })
    : [];
  const friendAvatar = new Map(friendRows.map((f) => [`${f.zaloAccountId}:${f.zaloUidInNick}`, f.zaloAvatarUrl]));

  const result: AvatarRefreshResult = {};
  const now = Date.now();
  // nick → danh sách hội thoại cần hỏi Zalo
  const todo = new Map<string, typeof convs>();
  for (const c of convs) {
    const key = `${c.zaloAccountId}:${c.externalThreadId}`;
    const contactUrl = c.contact?.avatarUrl ?? null;
    const perNick = friendAvatar.get(key) ?? null;
    // Friend của nick này đã có link còn hạn (tin nhắn gần đây) → dùng luôn, khỏi gọi Zalo.
    if (!isAvatarStale(perNick, now)) {
      result[c.id] = perNick!;
      if (perNick !== contactUrl) {
        await prisma.contact.update({ where: { id: c.contactId! }, data: { avatarUrl: perNick } }).catch(() => {});
      }
      continue;
    }
    if (!isAvatarStale(contactUrl, now)) continue;
    if (now - (lastTried.get(key) ?? 0) < COOLDOWN_MS) continue;
    const list = todo.get(c.zaloAccountId) ?? [];
    list.push(c);
    todo.set(c.zaloAccountId, list);
  }

  for (const [accountId, list] of todo) {
    if (zaloPool.getInstance(accountId)?.status !== 'connected') continue;
    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      const batch = list.slice(i, i + BATCH_SIZE);
      const uids = batch.map((c) => c.externalThreadId!);
      for (const uid of uids) lastTried.set(`${accountId}:${uid}`, now);
      let profiles: Record<string, Record<string, unknown>> = {};
      try {
        const res = await zaloOps.exec(
          { accountId, category: 'query', operation: 'getUserInfo(avatar)' },
          (api: any) => api.getUserInfo(uids),
        ) as { changed_profiles?: Record<string, Record<string, unknown>> } | null;
        profiles = res?.changed_profiles ?? {};
      } catch (err: any) {
        logger.debug(`[avatar-refresh] getUserInfo lỗi nick=${accountId}: ${err?.message ?? err}`);
        break; // rate limit / mất kết nối → nick này để lượt sau
      }
      for (const c of batch) {
        const uid = c.externalThreadId!;
        const url = pickAvatar(profiles[uid] ?? profiles[`${uid}_0`]);
        if (!url) continue;
        result[c.id] = url;
        await Promise.all([
          prisma.contact.update({ where: { id: c.contactId! }, data: { avatarUrl: url } }),
          prisma.friend.updateMany({ where: { zaloAccountId: accountId, zaloUidInNick: uid }, data: { zaloAvatarUrl: url } }),
        ]).catch((err) => logger.debug('[avatar-refresh] ghi avatar lỗi:', err));
      }
    }
  }

  // Dọn map cooldown để không phình vô hạn.
  if (lastTried.size > 50_000) {
    for (const [k, t] of lastTried) if (now - t > COOLDOWN_MS) lastTried.delete(k);
  }
  return result;
}

/** Chỉ cho test. */
export function _resetAvatarRefreshCooldown(): void {
  lastTried.clear();
}

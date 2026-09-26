/**
 * use-avatar-refresh.ts — chọn link avatar Zalo còn hạn + xin backend làm mới link hết hạn.
 *
 * Link avatar Zalo có hạn (`...jpg?key=...&time=<epoch giây>`); quá hạn CDN trả 403
 * nên cửa sổ chat chỉ còn chữ viết tắt. Hội thoại có 2 nguồn avatar: Contact.avatarUrl
 * (cấp khách) và friendship.zaloAvatarUrl (khách nhìn từ nick này) → lấy link còn hạn
 * lâu hơn; cả hai hết hạn thì gom lại gửi POST /avatars/refresh theo lô.
 */
import type { Conversation } from '@/composables/use-chat';
import { api } from '@/api/index';

const MARGIN_MS = 60 * 60_000;

export function zaloAvatarTime(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = /[?&]time=(\d{9,11})(?:&|$)/.exec(url);
  return m ? Number(m[1]) * 1000 : null;
}

export function isAvatarStale(url: string | null | undefined): boolean {
  if (!url) return true;
  const t = zaloAvatarTime(url);
  return t !== null && t - MARGIN_MS <= Date.now();
}

type WithFriendAvatar = { friendship?: { zaloAvatarUrl?: string | null } | null };

/** Link avatar tốt nhất cho hội thoại 1-1 (còn hạn lâu nhất; link không có hạn coi là tốt). */
export function bestConversationAvatar(conv: Conversation): string | null {
  const candidates = [
    conv.contact?.avatarUrl ?? null,
    (conv as Conversation & WithFriendAvatar).friendship?.zaloAvatarUrl ?? null,
  ].filter((u): u is string => !!u);
  if (candidates.length === 0) return null;
  const score = (u: string) => zaloAvatarTime(u) ?? Number.MAX_SAFE_INTEGER;
  return candidates.sort((a, b) => score(b) - score(a))[0];
}

const queue = new Map<string, Conversation>();
const tried = new Map<string, number>(); // conversationId → lần xin gần nhất
const RETRY_MS = 30 * 60_000;
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  timer = null;
  const batch = [...queue.values()].slice(0, 100);
  for (const c of batch) queue.delete(c.id);
  if (batch.length === 0) return;
  try {
    const { data } = await api.post<{ avatars: Record<string, string> }>('/avatars/refresh', {
      conversationIds: batch.map((c) => c.id),
    });
    for (const c of batch) {
      const url = data.avatars?.[c.id];
      if (url && c.contact) c.contact.avatarUrl = url;
    }
  } catch {
    // Lỗi mạng/quyền → giữ chữ viết tắt, thử lại sau RETRY_MS.
  }
  if (queue.size > 0) timer = setTimeout(flush, 1500);
}

/** Xếp hàng xin link mới cho hội thoại 1-1 (gom lô, mỗi hội thoại tối đa 1 lần / 30 phút). */
export function requestAvatarRefresh(conv: Conversation): void {
  if (conv.threadType !== 'user' || !conv.contact) return;
  const last = tried.get(conv.id) ?? 0;
  if (Date.now() - last < RETRY_MS) return;
  tried.set(conv.id, Date.now());
  queue.set(conv.id, conv);
  if (!timer) timer = setTimeout(flush, 600);
}

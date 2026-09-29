/**
 * zalo-listener-factory.ts — sets up zca-js listener events for one Zalo account.
 * Handles message routing, user-info caching, group detection, and undo events.
 * Extracted from ZaloAccountPool to keep zalo-pool.ts under 200 lines.
 */
import type { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { logger } from '../../shared/utils/logger.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { handleIncomingMessage, handleMessageUndo } from '../chat/message-handler.js';
import { isGroupIgnored, recordIgnoredSelfEcho } from '../chat/ignored-groups-service.js';
import { detectContentType, extractAlbumInfo, updateContactAvatar, updateContactGender, zaloGender } from './zalo-message-helpers.js';
import { handleFriendEvent } from './friend-event-handler.js';
import { consumeIfExpected as consumeReactionEcho } from '../chat/reaction-echo-cache.js';

// Map Zalo Reactions enum code → display emoji (cùng map với chat-operations-routes)
const ZALO_REACTION_DISPLAY: Record<string, string> = {
  '/-heart': '❤️',
  '/-strong': '👍',
  ':>': '😆',
  ':o': '😮',
  ':-((': '😭',
  ':-h': '😡',
  '/-rose': '🌹',
  '/-break': '💔',
  '/-weak': '👎',
};

async function handleZaloReaction(accountId: string, io: Server | null, reaction: any) {
  try {
    const data = reaction?.data;
    const threadId = reaction?.threadId;
    if (!data || !threadId) return;

    // Reactor info: uidFrom là Zalo UID của người thả; rIcon là emoji code, rType=0 thường nghĩa "add"
    const reactorZaloUid: string = String(data.uidFrom || '');
    const rawIcon: string = String(data.content?.rIcon || '');
    const rType: number = Number(data.content?.rType || 0);
    // Target message: gMsgID là Zalo msgId của tin bị react
    const targetZaloMsgId: string = String(data.content?.rMsg?.[0]?.gMsgID || data.msgId || '');
    if (!targetZaloMsgId || !reactorZaloUid) return;

    // Tìm conversation theo externalThreadId + accountId
    const conversation = await prisma.conversation.findFirst({
      where: { zaloAccountId: accountId, externalThreadId: threadId },
      select: { id: true, contactId: true, orgId: true },
    });
    if (!conversation) return;

    // Tìm Message theo zaloMsgId
    const message = await prisma.message.findFirst({
      where: { conversationId: conversation.id, zaloMsgId: targetZaloMsgId },
      select: { id: true, senderType: true },
    });
    if (!message) return;

    const displayEmoji = ZALO_REACTION_DISPLAY[rawIcon] || rawIcon || '👍';
    const reactorName = String(data.dName || '');

    // Phase A v3 (2026-05-21) — selective self-echo guard via reaction-echo-cache.
    // BAD fix cũ: skip tất cả reactorUid === ownNickUid → SAI vì cũng skip genuine
    // reaction từ Zalo App của anh (cùng UID).
    // GOOD fix: chỉ skip nếu (zaloMsgId, emoji, reactorUid) match expected echo
    // được mark trong POST /reactions handler (5s window). Genuine app reaction
    // KHÔNG có matching mark → proceed bình thường → sync vào CRM.
    if (consumeReactionEcho(targetZaloMsgId, displayEmoji, reactorZaloUid)) {
      return; // confirmed CRM self-echo, POST handler đã ghi DB + emit socket
    }

    // rIcon rỗng = remove, có icon = add (Zalo gửi cùng 1 event cho cả 2 — phân biệt qua rIcon empty)
    if (!rawIcon || rType < 0) {
      // Remove tất cả emoji của reactor này trên message (Zalo client chỉ giữ 1 emoji per user)
      await prisma.messageReaction.deleteMany({
        where: { messageId: message.id, reactorId: reactorZaloUid, reactorSource: 'zalo' },
      });
    } else {
      // 18/09/2026: Zalo đôi khi bắn CÙNG 1 reaction 2 lần sát nhau → 2 upsert song song, Prisma upsert không
      // atomic (find-rồi-create) → cái sau đụng UNIQUE (message_id, reactor_id, emoji) = P2002 (2 lần/ngày, in stack).
      // Thử lại 1 lần: lần 2 thấy row → nhánh update, không mất gì.
      const upsertReaction = () => prisma.messageReaction.upsert({
        where: {
          messageId_reactorId_emoji: {
            messageId: message.id,
            reactorId: reactorZaloUid,
            emoji: displayEmoji,
          },
        },
        update: { reactorName: reactorName || undefined },
        create: {
          id: randomUUID(),
          messageId: message.id,
          reactorId: reactorZaloUid,
          reactorSource: 'zalo',
          reactorName: reactorName || null,
          emoji: displayEmoji,
        },
      });
      try {
        await upsertReaction();
      } catch (err) {
        if ((err as { code?: string })?.code !== 'P2002') throw err;
        await upsertReaction();
      }
    }

    // ANTI-DRIFT FIX 2026-05-22: emit authoritative totalCount từ DB sau upsert/delete.
    // Trước fix: Zalo gửi 10 reaction events liên tiếp → 10 socket emits với action='add'
    // → FE increment +1 mỗi event → count=10 realtime. Refresh page → REST trả 1 (DB chỉ
    // 1 row do composite key msg×reactor×emoji) → UI "rollback" về 1 → drift confused user.
    // Fix: query messageReaction.count({where: msg×emoji}) → emit totalCount. FE set thay
    // vì increment → realtime count = persisted count luôn.
    const newCount = await prisma.messageReaction.count({
      where: { messageId: message.id, emoji: displayEmoji },
    });

    io?.to(`org:${conversation.orgId}`).emit('chat:reactions', {
      conversationId: conversation.id,
      messageId: message.id,
      msgId: message.id,
      reactions: [{
        userId: reactorZaloUid,
        userName: reactorName,
        reaction: displayEmoji,
        action: (!rawIcon || rType < 0) ? 'remove' : 'add',
        source: 'zalo',
        totalCount: newCount, // authoritative count post-mutation
      }],
    });

    // Phase 8 — Engagement aggregate: count only KH-on-Sale reactions
    // (KH thả ❤️ vào tin sale gửi). Skip nếu sale thả vào tin KH (không phải signal).
    const isAddAction = !!rawIcon && rType >= 0;
    if (isAddAction && conversation.contactId && message.senderType === 'self') {
      void (async () => {
        try {
          const { incrementDailyAggregate } = await import('../engagement/engagement-service.js');
          await incrementDailyAggregate({
            contactId: conversation.contactId!,
            orgId: conversation.orgId,
            reaction: 1,
          });
        } catch {
          // silent — engagement best-effort
        }
      })();
    }
  } catch (err) {
    logger.warn(`[zalo:${accountId}] reaction handler error:`, err);
  }
}

// Cached user info entry with 5-minute TTL
export interface UserInfoCacheEntry {
  zaloName: string;
  avatar: string;
  phone?: string;
  globalId: string;   // Zalo toàn cục, không đổi giữa các viewer account — khóa dedup chính
  username: string;   // Zalo handle (t_xxx) — cũng toàn cục, debug-friendly
  gender?: 'male' | 'female' | null; // Zalo: 0 = nam, 1 = nữ
  cachedAt: number;
}

const USER_INFO_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const USER_INFO_FAIL_TTL_MS = 60 * 60 * 1000;
const userInfoFailures = new Map<string, number>();

// Fetch zaloName + avatar + globalId + username from API with a per-pool in-memory cache
export async function resolveZaloName(
  api: any,
  uid: string,
  cache: Map<string, UserInfoCacheEntry>,
): Promise<{ zaloName: string; avatar: string; globalId: string; username: string; gender?: 'male' | 'female' | null }> {
  // Lỗi nghiệp vụ gần đây (vd tài khoản khoá / không cho xem) → không gọi Zalo lại trong 1 giờ
  // (trước đây 1 UID lỗi 1.069 lần — gọi Zalo mỗi tin nhắn của người đó).
  const failedAt = userInfoFailures.get(uid);
  if (failedAt && Date.now() - failedAt < USER_INFO_FAIL_TTL_MS) return { zaloName: '', avatar: '', globalId: '', username: '' };
  const cached = cache.get(uid);
  if (cached && Date.now() - cached.cachedAt < USER_INFO_CACHE_TTL_MS) {
    return { zaloName: cached.zaloName, avatar: cached.avatar, globalId: cached.globalId, username: cached.username, gender: cached.gender };
  }

  const attempts = 3;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await api.getUserInfo(uid);
      const profiles = result?.changed_profiles || {};
      const profile = profiles[uid] || profiles[`${uid}_0`];
      if (profile) {
        const entry: UserInfoCacheEntry = {
          zaloName:
            profile.zaloName ||
            profile.zalo_name ||
            profile.displayName ||
            profile.display_name ||
            '',
          avatar: profile.avatar || '',
          gender: zaloGender(profile.gender),
          phone: profile.phoneNumber || '',
          globalId: String(profile.globalId || ''),
          username: String(profile.username || ''),
          cachedAt: Date.now(),
        };
        cache.set(uid, entry);
        return { zaloName: entry.zaloName, avatar: entry.avatar, globalId: entry.globalId, username: entry.username, gender: entry.gender };
      }
      break; // gọi được nhưng không có profile → không retry
    } catch (err) {
      lastErr = err;
      if (!isTransientNetErr(err)) break; // lỗi nghiệp vụ/quyền → thử lại vô ích
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  if (lastErr) {
    // Mạng chập chờn từ Zalo → chỉ debug (không vào *-error.log). Lỗi thật → warn.
    if (isTransientNetErr(lastErr)) logger.debug(`[zalo] getUserInfo tạm không lấy được (mạng chập chờn) cho ${uid}`);
    else {
      logger.warn(`[zalo] getUserInfo failed for ${uid} (tạm không hỏi lại 1 giờ):`, lastErr);
      userInfoFailures.set(uid, Date.now());
      if (userInfoFailures.size > 5000) userInfoFailures.clear();
    }
  }
  return { zaloName: '', avatar: '', globalId: '', username: '' };
}

interface ResolvedGroup {
  name: string;
  avatar: string;
  membersCount: number | null;
}

// Cache group info: tên/avatar/số thành viên nhóm gần như không đổi theo từng tin.
// resolveGroupInfo() TRƯỚC ĐÂY gọi Zalo trên MỖI tin nhắn nhóm → nhóm chat sôi động
// = hàng chục lệnh getGroupInfo/phút, mỗi lệnh là 1 kết nối TLS ra server Zalo và Zalo
// hay reset (ECONNRESET). Cache 10 phút giảm gọi ~99% → ít reset, ít log rác.
const GROUP_INFO_TTL_MS = 10 * 60 * 1000;
const groupInfoCache = new Map<string, { data: ResolvedGroup; at: number }>();

// Lỗi mạng CHẬP CHỜN (Zalo reset TLS / DNS / timeout) — thử lại được, KHÔNG phải lỗi code.
// Không đưa các lỗi này vào log ERROR (console.warn → stderr → *-error.log → Tiểu Linh báo).
export function isTransientNetErr(err: any): boolean {
  const code = String(err?.code || err?.cause?.code || '');
  if (/^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_)/.test(code)) return true;
  const msg = String(err?.message || '') + ' ' + String(err?.cause?.message || '');
  return /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network|read ECONN/i.test(msg);
}

// Fetch group display name + avatar + member count from the zca-js API.
// Có cache + retry lỗi mạng chập chờn (Zalo hay ECONNRESET khi gọi từ xa).
export async function resolveGroupInfo(api: any, groupId: string): Promise<ResolvedGroup> {
  const cached = groupInfoCache.get(groupId);
  if (cached && Date.now() - cached.at < GROUP_INFO_TTL_MS) return cached.data;

  const attempts = 3;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await api.getGroupInfo(groupId);
      const info = result?.gridInfoMap?.[groupId];
      const members = info?.memVerList || info?.memList || info?.members;
      const data: ResolvedGroup = {
        name: info?.name || '',
        avatar: info?.avt || info?.fullAvt || info?.avatar || '',
        membersCount: Array.isArray(members) ? members.length : (info?.totalMember || null),
      };
      groupInfoCache.set(groupId, { data, at: Date.now() });
      return data;
    } catch (err) {
      lastErr = err;
      // Lỗi mạng chập chờn → thử lại; lỗi nghiệp vụ/quyền → dừng ngay (thử lại vô ích).
      if (!isTransientNetErr(err)) break;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }

  // Hết lượt: còn cache cũ thì dùng tạm (tên nhóm đúng vẫn hơn rỗng).
  if (cached) return cached.data;
  if (isTransientNetErr(lastErr)) {
    // Mạng chập chờn từ phía Zalo — KHÔNG log ERROR (tránh spam + Tiểu Linh báo oan). Chỉ debug.
    logger.debug(`[zalo] getGroupInfo tạm không lấy được (mạng chập chờn) cho ${groupId}`);
  } else {
    logger.warn(`[zalo] getGroupInfo failed for ${groupId}:`, lastErr);
  }
  return { name: '', avatar: '', membersCount: null };
}

export interface ListenerContext {
  accountId: string;
  api: any;
  io: Server | null;
  userInfoCache: Map<string, UserInfoCacheEntry>;
  onDisconnected: (accountId: string) => void;
}

/**
 * Attach all zca-js listener events for the given account.
 * Calls listener.start() with retryOnClose at the end.
 */
export function attachZaloListener(ctx: ListenerContext): void {
  const { accountId, api, io, userInfoCache, onDisconnected } = ctx;
  const listener = api.listener;

  // Resolve this account's orgId ONCE so high-frequency chat events fan out only to
  // the owning org's sockets instead of every connected client process-wide. Until it
  // resolves (a few ms), emitOrg falls back to a global emit so no event is ever lost.
  let orgId: string | null = null;
  prisma.zaloAccount.findUnique({ where: { id: accountId }, select: { orgId: true } })
    .then((r) => { if (r) orgId = r.orgId; })
    .catch(() => {});
  const emitOrg = (event: string, payload: unknown): void => {
    if (orgId) io?.to(`org:${orgId}`).emit(event, payload);
    else io?.emit(event, payload);
  };

  listener.on('connected', () => {
    logger.info(`[zalo:${accountId}] Listener connected`);
  });

  // ─── WAVE 1+2 (2026-05-21) — typing / seen / delivered / disconnected ───────
  // Trước đây SDK fire 4 events này mà code không subscribe → bỏ phí payload.
  // Mục đích: bubble status icon (sent/delivered/seen) + typing dots realtime.

  // KH đang gõ tin nhắn (chỉ user threads, không group). Auto-clear FE sau 5s
  // không có event mới. SDK fire mỗi ~2s khi KH còn gõ.
  listener.on('typing', (typing: any) => {
    try {
      emitOrg('zalo:typing', {
        accountId,
        threadId: typing?.threadId || '',
        threadType: typing?.type === 1 ? 'group' : 'user',
        ts: typing?.data?.ts ? Number(typing.data.ts) : Date.now(),
      });
    } catch (err) {
      logger.warn(`[zalo:${accountId}] typing event error:`, err);
    }
  });

  // KH đã đọc tin → set seen_at + emit socket bubble update.
  // Payload: SeenMessage[] — mỗi item {msgId, idTo, ...} cho user threads.
  // KH đọc tới msg N → tất cả msg ≤ N của ta đều được đánh dấu seen (Zalo behavior).
  listener.on('seen_messages', async (messages: any[]) => {
    try {
      const seenIds: string[] = [];
      for (const m of messages || []) {
        const msgId = String(m?.data?.msgId || '');
        if (msgId) seenIds.push(msgId);
      }
      if (!seenIds.length) return;
      const now = new Date();
      // Update tất cả msg ≤ msgId này → seen. Đơn giản: update các msg có zaloMsgId in list.
      // (Sweep-to-msgId logic phức tạp, để wave sau nếu cần.)
      const updated = await prisma.message.updateMany({
        where: {
          zaloMsgId: { in: seenIds },
          senderType: 'self',
          seenAt: null,
        },
        data: { seenAt: now, deliveredAt: now }, // seen implies delivered
      });
      if (updated.count > 0) {
        // Emit để FE update bubble — gửi danh sách msgId được flip
        const rows = await prisma.message.findMany({
          where: { zaloMsgId: { in: seenIds }, senderType: 'self' },
          select: { id: true, conversationId: true, zaloMsgId: true, deliveredAt: true, seenAt: true },
        });
        for (const r of rows) {
          emitOrg('zalo:message-status', {
            accountId,
            conversationId: r.conversationId,
            messageId: r.id,
            zaloMsgId: r.zaloMsgId,
            deliveredAt: r.deliveredAt,
            seenAt: r.seenAt,
          });
        }
      }
    } catch (err) {
      logger.warn(`[zalo:${accountId}] seen_messages error:`, err);
    }
  });

  // KH device nhận packet (chưa đọc). Set delivered_at nếu chưa seen.
  listener.on('delivered_messages', async (messages: any[]) => {
    try {
      const deliveredIds: string[] = [];
      for (const m of messages || []) {
        const msgId = String(m?.data?.msgId || '');
        if (msgId) deliveredIds.push(msgId);
      }
      if (!deliveredIds.length) return;
      const now = new Date();
      const updated = await prisma.message.updateMany({
        where: {
          zaloMsgId: { in: deliveredIds },
          senderType: 'self',
          deliveredAt: null,
          seenAt: null, // chỉ set delivered nếu chưa seen (seen > delivered)
        },
        data: { deliveredAt: now },
      });
      if (updated.count > 0) {
        const rows = await prisma.message.findMany({
          where: { zaloMsgId: { in: deliveredIds }, senderType: 'self' },
          select: { id: true, conversationId: true, zaloMsgId: true, deliveredAt: true, seenAt: true },
        });
        for (const r of rows) {
          emitOrg('zalo:message-status', {
            accountId,
            conversationId: r.conversationId,
            messageId: r.id,
            zaloMsgId: r.zaloMsgId,
            deliveredAt: r.deliveredAt,
            seenAt: r.seenAt,
          });
        }
      }
    } catch (err) {
      logger.warn(`[zalo:${accountId}] delivered_messages error:`, err);
    }
  });

  // Sớm hơn `closed` ~vài giây. Hiện chỉ log; reconnect logic vẫn ở `closed`.
  // Nếu cần buffer outgoing messages giữa disconnected → reconnected, mở rộng ở đây.
  listener.on('disconnected', (code: number, reason: string) => {
    logger.warn(`[zalo:${accountId}] Listener disconnected (early): ${code} ${reason}`);
    io?.emit('zalo:disconnected', { accountId, code, reason, phase: 'early' });
  });

  listener.on('message', async (message: any) => {
    try {
      // ThreadType in zca-js: 0 = User, 1 = Group
      const isGroup = message.type === 1;
      const senderUid = String(message.data?.uidFrom || '');

      // Nhóm bị bỏ qua: dừng TRƯỚC khi gọi getUserInfo/getGroupInfo để khỏi tốn
      // request Zalo cho nhóm đăng bài nhiều tin. Echo ảnh self vẫn được đếm trong
      // bộ nhớ (retry gửi ảnh an toàn của public API dựa vào số này).
      if (isGroup && isGroupIgnored(orgId, message.threadId)) {
        if (message.isSelf) {
          recordIgnoredSelfEcho(
            accountId,
            String(message.threadId || ''),
            detectContentType(message.data?.msgType, message.data?.content),
            parseInt(message.data?.ts || String(Date.now())),
          );
        }
        return;
      }

      // Resolve display name — prefer zaloName from API over dName.
      // Self msg gửi cho người lạ: resolve theo threadId để biết tên người NHẬN
      // → recipientName được dùng trong upsertContact thay vì 'Unknown'.
      // Đồng thời resolve globalId + username (Zalo toàn cục) để dedup parent contact.
      let senderName: string = message.data?.dName || '';
      let recipientName: string = '';
      let contactGlobalId: string = '';
      let contactUsername: string = '';
      // Snapshot tên + avatar Zalo của KH nhìn từ nick này (lưu vào Friend.zaloDisplayName/AvatarUrl)
      let contactZaloDisplayName: string = '';
      let contactZaloAvatarUrl: string = '';
      if (senderUid && api.getUserInfo) {
        const resolveUid = message.isSelf ? (message.threadId || '') : senderUid;
        if (resolveUid) {
          const userInfo = await resolveZaloName(api, resolveUid, userInfoCache);
          contactGlobalId = userInfo.globalId;
          contactUsername = userInfo.username;
          contactZaloDisplayName = userInfo.zaloName;
          contactZaloAvatarUrl = userInfo.avatar;
          if (message.isSelf) {
            if (userInfo.zaloName) recipientName = userInfo.zaloName;
            if (userInfo.avatar && message.threadId) updateContactAvatar(message.threadId, userInfo.avatar);
          } else {
            if (userInfo.zaloName) senderName = userInfo.zaloName;
            if (userInfo.avatar) updateContactAvatar(senderUid, userInfo.avatar);
            if (userInfo.gender && !isGroup) updateContactGender(senderUid, userInfo.gender);
          }
        }
      }

      // Resolve group info for group threads (name + avatar + members count)
      let groupName: string | undefined;
      let groupAvatarUrl: string | undefined;
      let groupMembersCount: number | undefined;
      if (isGroup && message.threadId) {
        const groupInfo = await resolveGroupInfo(api, message.threadId);
        groupName = groupInfo.name || undefined;
        groupAvatarUrl = groupInfo.avatar || undefined;
        groupMembersCount = groupInfo.membersCount ?? undefined;
      }

      const rawContent = message.data?.content;
      const content =
        typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent || '');
      const contentType = detectContentType(message.data?.msgType, rawContent);
      const album = extractAlbumInfo(contentType, rawContent);

      const result = await handleIncomingMessage({
        accountId,
        senderUid,
        senderName,
        content,
        contentType,
        msgId: String(message.data?.msgId || ''),
        // FIX 2026-05-21: capture cliMsgId — bắt buộc cho api.undo (zalo server check cả 2).
        // Tin cũ trước fix này có cliMsgId=null → undo trả 400.
        ...(message.data?.cliMsgId ? { cliMsgId: String(message.data.cliMsgId) } : {}) as any,
        timestamp: parseInt(message.data?.ts || String(Date.now())),
        isSelf: message.isSelf || false,
        threadId: message.threadId || '',
        threadType: isGroup ? 'group' : 'user',
        recipientName: recipientName || undefined,
        contactGlobalId: contactGlobalId || undefined,
        contactUsername: contactUsername || undefined,
        contactZaloDisplayName: contactZaloDisplayName || undefined,
        contactZaloAvatarUrl: contactZaloAvatarUrl || undefined,
        groupName,
        groupAvatarUrl,
        groupMembersCount,
        attachments: [],
        quote: message.data?.quote,
        albumKey: album.albumKey,
        albumIndex: album.albumIndex,
        albumTotal: album.albumTotal,
      });

      if (result) {
        // PRIVACY 2026-05-22: kèm _privacyMeta để FE non-owner blur ngay realtime
        const accInfo = await prisma.zaloAccount.findUnique({
          where: { id: accountId },
          select: { privacyMode: true, ownerUserId: true },
        });
        emitOrg('chat:message', {
          accountId,
          message: result.message,
          conversationId: result.conversationId,
          _privacyMeta: accInfo ? {
            privacyMode: accInfo.privacyMode,
            ownerUserId: accInfo.ownerUserId,
          } : undefined,
        });
      }
    } catch (err) {
      logger.error(`[zalo:${accountId}] Message handler error:`, err);
    }
  });

  // FIX 2026-05-21: zca-js Undo object có shape { data: TUndo, threadId, isSelf, isGroup }.
  // TUndo.msgId là id của PACKET undo, KHÔNG phải tin bị thu hồi. Tin gốc nằm ở:
  //   data.data.content.globalMsgId (Snowflake server-side) → match Message.zaloMsgIdNum
  //   data.data.content.cliMsgId    (client counter)        → fallback nếu globalMsgId null
  // Trước đây code đọc data.data.msgId → 0 row update vì không match được zaloMsgId nào.
  listener.on('undo', async (data: any) => {
    try {
    const undoContent = data?.data?.content || {};
    const globalMsgId = undoContent.globalMsgId;
    const cliMsgIdNum = undoContent.cliMsgId;
    if (!globalMsgId && !cliMsgIdNum) {
      logger.warn(`[zalo:${accountId}] Undo event missing globalMsgId/cliMsgId`, undoContent);
      return;
    }
    // BigInt() throws synchronously on a non-numeric payload — guard so a malformed
    // undo can't surface as an unhandled rejection.
    const safeBigInt = (v: any): bigint | null => {
      if (v === null || v === undefined || v === '') return null;
      try { return BigInt(v); } catch { return null; }
    };
    const globalMsgIdNum = safeBigInt(globalMsgId);
    const cliMsgIdBig = safeBigInt(cliMsgIdNum);
    if (globalMsgIdNum === null && cliMsgIdBig === null) {
      logger.warn(`[zalo:${accountId}] Undo event has non-numeric ids`, undoContent);
      return;
    }
    const updatedIds = (await (handleMessageUndo as any)(accountId, {
      globalMsgIdNum,
      cliMsgIdNum: cliMsgIdBig,
    })) as string[] | undefined ?? [];
    // FIX B1 round-2: emit MULTIPLE messageId nếu match nhiều rows (event broadcast tới mọi nick).
    // FE composable matches by zaloMsgId/messageId → update isDeleted live ở cột 3.
    const zaloMsgIdStr = globalMsgId ? String(globalMsgId) : (cliMsgIdNum ? String(cliMsgIdNum) : null);
    for (const messageId of updatedIds) {
      emitOrg('chat:deleted', {
        accountId,
        messageId,
        zaloMsgId: zaloMsgIdStr,
      });
    }
    // Fallback emit bằng zaloMsgId nếu không update được row nào (FE tự match ở cache).
    if (updatedIds.length === 0 && zaloMsgIdStr) {
      emitOrg('chat:deleted', { accountId, zaloMsgId: zaloMsgIdStr });
    }
    } catch (err) {
      logger.warn(`[zalo:${accountId}] undo event error:`, err);
    }
  });

  // Reactions thả từ Zalo client → sync vào DB + emit socket
  listener.on('reaction', async (reaction: any) => {
    await handleZaloReaction(accountId, io, reaction);
  });

  // Backfill reactions trên reconnect (đã thả khi CRM offline)
  listener.on('old_reactions', async (reactions: any[]) => {
    if (!Array.isArray(reactions)) return;
    logger.info(`[zalo:${accountId}] Backfill ${reactions.length} old reactions`);
    for (const r of reactions) {
      await handleZaloReaction(accountId, io, r);
    }
  });

  listener.on('friend_event', async (event: any) => {
    try {
      await handleFriendEvent(accountId, event);
      // Coarse event (giữ backward-compat — không ai mới subscribe nhưng cũ có thể vẫn dùng)
      io?.emit('friend:event', { accountId, type: event.type, threadId: event.threadId });

      // Granular patch event cho FE composable use-friend-socket.ts → live update
      // FriendsView + ContactsView child row mà không cần refetch.
      // Lookup Friend row vừa bị handleFriendEvent mutate để lấy patch payload.
      try {
        const threadId = String(event?.threadId || event?.data?.fromUid || event?.data?.toUid || '');
        if (!threadId) return;
        const friend = await prisma.friend.findUnique({
          where: {
            zaloAccountId_zaloUidInNick: { zaloAccountId: accountId, zaloUidInNick: threadId },
          },
          select: {
            id: true, contactId: true, zaloAccountId: true, zaloUidInNick: true, orgId: true,
            friendshipStatus: true, relationshipKind: true,
            becameFriendAt: true, removedAt: true,
          },
        });
        if (friend) {
          io?.to(`org:${friend.orgId}`).emit('friend:updated', {
            friendId: friend.id,
            contactId: friend.contactId,
            zaloAccountId: friend.zaloAccountId,
            zaloUidInNick: friend.zaloUidInNick, // FE filter: phân biệt Friend rows cùng nick (per-account UID)
            patch: {
              friendshipStatus: friend.friendshipStatus,
              relationshipKind: friend.relationshipKind,
              becameFriendAt: friend.becameFriendAt,
              removedAt: friend.removedAt,
            },
          });
        }
      } catch (emitErr) {
        logger.warn(`[zalo:${accountId}] friend:updated emit failed:`, emitErr);
      }
    } catch (err) {
      logger.error(`[zalo:${accountId}] friend_event handler error:`, err);
    }
  });

  // Backfill messages delivered on reconnect (missed while disconnected)
  listener.on('old_messages', async (messages: any[], type: number) => {
    const threadType = type === 1 ? 'group' : 'user';
    logger.info(`[zalo:${accountId}] Received ${messages.length} old ${threadType} messages`);

    for (const message of messages) {
      try {
        const senderUid = String(message.data?.uidFrom || '');
        // For DM messages from requestOldMessages, the peer UID (thread id)
        // may not appear on the top-level `threadId` field. Derive it from
        // payload: for self → data.idTo (peer); for incoming → uidFrom (peer).
        const peerFallback = message.isSelf
          ? String(message.data?.idTo || '')
          : senderUid;
        const resolvedThreadId = String(message.threadId || peerFallback || '');
        let senderName = message.data?.dName || '';
        let recipientName = '';
        let contactGlobalId = '';
        let contactUsername = '';

        // Resolve display name — non-self: senderName; self user-thread: recipientName từ threadId.
        // Đồng thời capture globalId + username để dedup parent contact.
        if (api.getUserInfo) {
          if (!message.isSelf && senderUid) {
            const userInfo = await resolveZaloName(api, senderUid, userInfoCache);
            if (userInfo.zaloName) senderName = userInfo.zaloName;
            contactGlobalId = userInfo.globalId;
            contactUsername = userInfo.username;
          } else if (message.isSelf && threadType === 'user' && resolvedThreadId) {
            const userInfo = await resolveZaloName(api, resolvedThreadId, userInfoCache);
            if (userInfo.zaloName) recipientName = userInfo.zaloName;
            if (userInfo.avatar) updateContactAvatar(resolvedThreadId, userInfo.avatar);
            contactGlobalId = userInfo.globalId;
            contactUsername = userInfo.username;
          }
        }

        let groupName: string | undefined;
        let groupAvatarUrl: string | undefined;
        let groupMembersCount: number | undefined;
        if (threadType === 'group' && resolvedThreadId) {
          const groupInfo = await resolveGroupInfo(api, resolvedThreadId);
          groupName = groupInfo.name || undefined;
          groupAvatarUrl = groupInfo.avatar || undefined;
          groupMembersCount = groupInfo.membersCount ?? undefined;
        }

        const rawContent = message.data?.content;
        const content =
          typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent || '');
        const contentType = detectContentType(message.data?.msgType, rawContent);
        const album = extractAlbumInfo(contentType, rawContent);

        const result = await handleIncomingMessage({
          accountId,
          senderUid,
          senderName,
          content,
          contentType,
          msgId: String(message.data?.msgId || ''),
          timestamp: parseInt(message.data?.ts || String(Date.now())),
          isSelf: message.isSelf || false,
          threadId: resolvedThreadId,
          threadType,
          recipientName: recipientName || undefined,
          contactGlobalId: contactGlobalId || undefined,
          contactUsername: contactUsername || undefined,
          groupName,
          groupAvatarUrl,
          groupMembersCount,
          attachments: [],
          quote: message.data?.quote,
          albumKey: album.albumKey,
          albumIndex: album.albumIndex,
          albumTotal: album.albumTotal,
          isBackfill: true,
        });

        if (result) {
          emitOrg('chat:message', {
            accountId,
            message: result.message,
            conversationId: result.conversationId,
          });
        }
      } catch (err) {
        logger.warn(`[zalo:${accountId}] old_messages processing error:`, err);
      }
    }
  });

  // Group system events: member join/leave/kick, name change, etc.
  listener.on('group_event', (event: any) => {
    logger.info(`[zalo:${accountId}] Group event: type=${event?.type ?? 'unknown'}`, {
      groupId: event?.groupId,
      actorId: event?.actorId,
      members: event?.members,
    });
    // Future: store as system message in the group conversation
  });

  // Note: duplicate 'friend_event' listener đã xoá ở chỗ này (legacy stub).
  // Listener thực ở line ~307 — đã wire handleFriendEvent + emit 'friend:updated'.

  listener.on('closed', (code: number, reason: string) => {
    logger.warn(`[zalo:${accountId}] Listener closed: ${code} ${reason}`);
    onDisconnected(accountId);
    io?.emit('zalo:disconnected', { accountId, code, reason });
  });

  listener.on('error', (err: any) => {
    logger.error(`[zalo:${accountId}] Listener error:`, err);
  });

  listener.start({ retryOnClose: true });
}

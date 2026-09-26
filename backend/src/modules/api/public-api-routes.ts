/**
 * public-api-routes.ts — External REST API authenticated via API key (X-Api-Key header).
 * Provides read/write access to contacts, conversations, appointments, and message sending.
 * All routes prefixed /api/public/ — no JWT required, orgId injected from API key lookup.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../../shared/database/prisma-client.js';
import { assertSafeOutboundUrl, SsrfBlockedError } from '../../shared/utils/ssrf-guard.js';
import { logger } from '../../shared/utils/logger.js';
import { isGroupIgnored, countIgnoredSelfImageEchoes } from '../chat/ignored-groups-service.js';

// Public API image-send limits. Ảnh tải từ URL (HTTPS only — qua ssrf-guard).
const PUBLIC_IMAGE_MAX = 25 * 1024 * 1024; // 25MB/ảnh
// Trần ảnh MỖI REQUEST public (messages/send, groups/broadcast). Đổi qua env PUBLIC_MAX_IMAGES
// (mặc định 50 — bot chào hàng nhóm gửi gộp tới 50 SP/lần, xem chaoHangGroup.js bên bot).
export const PUBLIC_MAX_IMAGES = Math.max(1, Number(process.env.PUBLIC_MAX_IMAGES) || 50);
// Cỡ lô ảnh khi worker chào hàng 1-1 gửi cho TỪNG khách — giữ 10, KHÔNG đi theo trần request
// (album quá to gửi cho người lạ dễ fail/khoá nick hơn gửi vào nhóm).
export const CHAO_HANG_IMAGE_LOT = 10;
const PUBLIC_IMAGE_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * Tải 1 ảnh từ URL HTTPS công khai về Buffer, có guard SSRF + giới hạn type/size.
 * Trả về { buffer, ext } để caller ghi ra tmp file cho zca-js gửi.
 */
async function downloadImage(rawUrl: string): Promise<{ buffer: Buffer; ext: string }> {
  const safeUrl = assertSafeOutboundUrl(rawUrl); // throws SsrfBlockedError nếu không hợp lệ/HTTP/private
  // 2026-09-08: lỗi mạng thoáng qua (DNS ENOTFOUND, "fetch failed", 5xx CDN) làm cả broadcast
  // trả 500 "Failed to broadcast" dù chỉ 1 ảnh tải hụt → thử lại tối đa 3 lần, giãn 2s.
  let res: Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await fetch(safeUrl.toString(), { signal: AbortSignal.timeout(15_000) });
      if (res.ok || (res.status >= 400 && res.status < 500)) break; // 4xx là lỗi thật, không thử lại
      lastErr = new Error(`fetch ${res.status}`);
    } catch (err) {
      lastErr = err;
      res = null;
    }
    if (attempt < 3) {
      logger.warn(`[public-api] tải ảnh lỗi lần ${attempt}/3 (${(lastErr as Error)?.message}) — thử lại: ${safeUrl.host}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!res) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = PUBLIC_IMAGE_EXT[mime];
  if (!ext) throw new Error(`unsupported image type: ${mime || 'unknown'}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > PUBLIC_IMAGE_MAX) throw new Error(`image exceeds ${PUBLIC_IMAGE_MAX / 1024 / 1024}MB`);
  return { buffer, ext };
}

// Broadcast: số nhóm tối đa + giãn nhịp giữa nhóm (chống khóa nick khi đăng loạt).
const BROADCAST_MAX_GROUPS = 50;
const BROADCAST_GROUP_DELAY_MS = Number(process.env.BROADCAST_GROUP_DELAY_MS ?? 5000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Gửi album ảnh CÓ RETRY AN TOÀN (chống trùng ảnh) ───────────────────────────
// zca-js api.sendMessage({attachments}) chạy 2 pha:
//   (1) UPLOAD: upload song song N ảnh lên host file Zalo. Lỗi ở pha này CHƯA gửi tin
//       nào → retry HOÀN TOÀN an toàn (không trùng).
//   (2) SEND: bắn song song N request photo_original/send (chung groupLayoutId → 1 album).
//       Lỗi ở pha này một số ảnh CÓ THỂ ĐÃ tới → retry sẽ gây TRÙNG.
// THỜI GIAN không đủ tin cậy để phân biệt 2 pha (lúc Zalo flap, upload 10 ảnh mất >3s mới
// fail sạch → dễ nhầm thành "partial"). Tín hiệu ĐÁNG TIN là ĐẾM ẢNH THỰC SỰ đã giao:
// sau mỗi lần fail, đợi echo rồi đếm tin ảnh self gửi vào thread kể từ mốc bắt đầu —
//   = 0  → pha upload sạch, chưa gửi gì → retry an toàn;
//   > 0  → đã giao một phần → DỪNG, ném PartialSendError (caller KHÔNG tự gửi lại);
//   không xác minh được (không thấy conversation) → coi như rủi ro → DỪNG cho chắc.
// Fail RẤT NHANH (< FAST_MS) chắc chắn là pha upload → retry luôn, khỏi tra DB.
const IMG_SEND_MAX_TRIES = Number(process.env.PUBLIC_IMAGE_SEND_MAX_TRIES ?? 6);
const IMG_SEND_FAST_MS = Number(process.env.PUBLIC_IMAGE_SEND_FAST_MS ?? 2500);
const IMG_SEND_ECHO_WAIT_MS = Number(process.env.PUBLIC_IMAGE_SEND_ECHO_WAIT_MS ?? 4000);
const IMG_SEND_RETRY_DELAY_MS = Number(process.env.PUBLIC_IMAGE_SEND_RETRY_DELAY_MS ?? 1500);

/** Lỗi gửi ảnh nghi đã giao một phần — caller KHÔNG được tự gửi lại (tránh trùng). */
export class PartialSendError extends Error {
  constructor(message: string, public readonly deliveredCount: number) {
    super(message);
    this.name = 'PartialSendError';
  }
}

/**
 * Đếm số tin ẢNH do mình (self) gửi vào 1 thread kể từ mốc `since` — để biết lần
 * sendMessage vừa lỗi đã giao được ảnh nào chưa. Trả -1 nếu KHÔNG xác minh được
 * (không tìm thấy conversation) → caller coi như rủi ro và dừng.
 */
async function countSelfImagesSince(
  orgId: string,
  zaloAccountId: string,
  threadId: string,
  threadType: number,
  since: Date,
): Promise<number> {
  const conv = await prisma.conversation.findFirst({
    where: { orgId, zaloAccountId, externalThreadId: threadId, threadType: threadType === 1 ? 'group' : 'user' },
    select: { id: true },
  });
  // Nhóm bị bỏ qua không lưu echo vào DB → đếm echo ảnh trong bộ nhớ thay thế.
  if (threadType === 1 && isGroupIgnored(orgId, threadId)) {
    return countIgnoredSelfImageEchoes(zaloAccountId, threadId, since);
  }
  if (!conv) return -1;
  return prisma.message.count({
    where: { conversationId: conv.id, contentType: 'image', senderType: 'self', sentAt: { gte: since } },
  });
}

/**
 * Gửi 1 album (text + nhiều ảnh đã tải về tmpPaths) trong 1 call zca-js, retry an toàn.
 * Chỉ retry khi xác minh được CHƯA giao ảnh nào; nghi đã giao một phần → ném PartialSendError.
 */
async function sendAlbumWithSafeRetry(
  api: any,
  orgId: string,
  zaloAccountId: string,
  threadId: string,
  threadType: number,
  content: string,
  tmpPaths: string[],
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= IMG_SEND_MAX_TRIES; attempt++) {
    const since = new Date(Date.now() - 1000); // trừ hao lệch giờ giữa app và DB
    const startedAt = Date.now();
    try {
      await api.sendMessage({ msg: content || '', attachments: tmpPaths }, threadId, threadType);
      return;
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      lastErr = err;

      // Fail rất nhanh → chắc chắn pha upload, chưa gửi gì → retry luôn.
      if (elapsed < IMG_SEND_FAST_MS) {
        logger.warn(`[public-api] gửi ${tmpPaths.length} ảnh fail nhanh (pha upload) lần ${attempt}/${IMG_SEND_MAX_TRIES} sau ${elapsed}ms: ${(err as Error)?.message} — gửi lại`);
        if (attempt < IMG_SEND_MAX_TRIES) await sleep(IMG_SEND_RETRY_DELAY_MS);
        continue;
      }

      // Fail muộn → đợi echo rồi đếm ảnh thực sự đã giao để quyết định.
      await sleep(IMG_SEND_ECHO_WAIT_MS);
      const delivered = await countSelfImagesSince(orgId, zaloAccountId, threadId, threadType, since);
      if (delivered === 0) {
        logger.warn(`[public-api] gửi ${tmpPaths.length} ảnh fail sau ${elapsed}ms nhưng đã giao 0 ảnh (pha upload) lần ${attempt}/${IMG_SEND_MAX_TRIES} — gửi lại`);
        if (attempt < IMG_SEND_MAX_TRIES) await sleep(IMG_SEND_RETRY_DELAY_MS);
        continue;
      }
      // delivered > 0 (partial thật) hoặc -1 (không xác minh được) → DỪNG, không gửi lại.
      throw new PartialSendError(
        delivered > 0 ? `đã giao ${delivered} ảnh trước khi lỗi` : `lỗi sau ${elapsed}ms, không xác minh được đã giao hay chưa`,
        delivered,
      );
    }
  }
  throw lastErr;
}

/**
 * Gửi 1 tin (text và/hoặc nhiều ảnh) tới 1 thread (user hoặc group) qua zca-js.
 * imageUrls rỗng → gửi text; có ảnh → tải URL HTTPS về tmp rồi gửi TEXT TRƯỚC, ẢNH SAU.
 * Ném lỗi (SsrfBlockedError / Error) nếu tải/upload ảnh thất bại — caller tự xử lý.
 * Dùng chung cho /messages/send (1 thread) và /groups/broadcast (nhiều nhóm).
 *
 * QUAN TRỌNG — chống TRÙNG TEXT: zca-js sendMessage({msg,attachments}) gửi TEXT ra
 * trước (1 tin riêng) rồi mới upload ảnh. Khi upload lỗi và retry, text sẽ bị gửi lại
 * mỗi lần → trùng. Vì vậy KHÔNG nhét text vào call gửi ảnh: gửi TEXT đúng 1 lần TRƯỚC
 * (nằm NGOÀI vòng retry → không bao giờ nhân đôi), rồi gửi ẢNH (msg='') qua
 * sendAlbumWithSafeRetry (retry an toàn, chỉ đếm ảnh). Thứ tự hiển thị: TEXT trên, ẢNH dưới.
 */
export async function sendToThread(
  api: any,
  orgId: string,
  zaloAccountId: string,
  threadId: string,
  threadType: number,
  content: string,
  imageUrls: string[],
  captionMode = false,
): Promise<void> {
  if (imageUrls.length === 0) {
    await api.sendMessage(content, threadId, threadType);
    return;
  }
  const tmpRoot = path.join(tmpdir(), 'zalocrm-public-send', randomUUID());
  await mkdir(tmpRoot, { recursive: true });
  try {
    const tmpPaths: string[] = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const img = await downloadImage(imageUrls[i]);
      const tmpPath = path.join(tmpRoot, `${i}${img.ext}`);
      await writeFile(tmpPath, img.buffer);
      tmpPaths.push(tmpPath);
    }

    // captionMode: text đi làm DESC của ảnh CUỐI (zca-js: 1 ảnh jpg/png/webp + msg
    // -> desc, KHÔNG đẻ tin text riêng) => tới được cả khách chặn tin text từ người lạ.
    if (captionMode && content && content.trim()) {
      const last = tmpPaths[tmpPaths.length - 1];
      const rest = tmpPaths.slice(0, -1);
      if (rest.length > 0) {
        await sendAlbumWithSafeRetry(api, orgId, zaloAccountId, threadId, threadType, '', rest);
      }
      // Ảnh cuối + desc: gửi 1 lần, KHÔNG retry (retry sẽ nhân đôi cả ảnh lẫn lời nhắn).
      await api.sendMessage({ msg: content, attachments: [last] }, threadId, threadType);
      return;
    }

    // 1) Gửi TEXT trước, đúng 1 lần (ngoài vòng retry ảnh → không trùng).
    if (content && content.trim()) {
      await api.sendMessage(content, threadId, threadType);
    }
    // 2) Gửi ẢNH sau (KHÔNG kèm text) — retry an toàn, không đẻ text trùng.
    await sendAlbumWithSafeRetry(api, orgId, zaloAccountId, threadId, threadType, '', tmpPaths);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// ── API key auth middleware ────────────────────────────────────────────────────

export async function apiKeyAuth(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers['x-api-key'] as string;
  if (!apiKey) return reply.status(401).send({ error: 'API key required' });

  const setting = await prisma.appSetting.findFirst({
    where: { settingKey: 'public_api_key', valuePlain: apiKey },
  });
  if (!setting) return reply.status(401).send({ error: 'Invalid API key' });

  (request as any).orgId = setting.orgId;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', apiKeyAuth);

  // ── Contacts ─────────────────────────────────────────────────────────────

  app.get('/api/public/contacts', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { search = '', status = '', limit = '20' } = request.query as Record<string, string>;

      const where: any = { orgId };
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { fullName: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
          { email: { contains: search, mode: 'insensitive' } },
        ];
      }

      const contacts = await prisma.contact.findMany({
        where,
        select: {
          id: true, fullName: true, phone: true, email: true,
          source: true, status: true, notes: true, tags: true,
          createdAt: true, updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: Math.min(parseInt(limit) || 20, 100),
      });

      return { contacts };
    } catch (err) {
      logger.error('[public-api] GET /contacts error:', err);
      return reply.status(500).send({ error: 'Failed to fetch contacts' });
    }
  });

  app.get('/api/public/contacts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { id } = request.params as { id: string };

      const contact = await prisma.contact.findFirst({
        where: { id, orgId },
        include: {
          appointments: { orderBy: { appointmentDate: 'desc' }, take: 5 },
          _count: { select: { conversations: true } },
        },
      });

      if (!contact) return reply.status(404).send({ error: 'Contact not found' });
      return contact;
    } catch (err) {
      logger.error('[public-api] GET /contacts/:id error:', err);
      return reply.status(500).send({ error: 'Failed to fetch contact' });
    }
  });

  app.post('/api/public/contacts', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const body = request.body as Record<string, any>;

      if (!body?.fullName && !body?.phone) {
        return reply.status(400).send({ error: 'fullName or phone is required' });
      }

      const contact = await prisma.contact.create({
        data: {
          orgId,
          fullName: body.fullName,
          phone: body.phone,
          email: body.email,
          source: body.source,
          status: body.status ?? 'new',
          notes: body.notes,
          tags: body.tags ?? [],
        },
      });

      return reply.status(201).send(contact);
    } catch (err) {
      logger.error('[public-api] POST /contacts error:', err);
      return reply.status(500).send({ error: 'Failed to create contact' });
    }
  });

  app.put('/api/public/contacts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { id } = request.params as { id: string };
      const body = request.body as Record<string, any>;

      const existing = await prisma.contact.findFirst({ where: { id, orgId }, select: { id: true } });
      if (!existing) return reply.status(404).send({ error: 'Contact not found' });

      const updated = await prisma.contact.update({
        where: { id },
        data: {
          fullName: body.fullName,
          phone: body.phone,
          email: body.email,
          source: body.source,
          status: body.status,
          notes: body.notes,
          tags: body.tags,
        },
      });

      return updated;
    } catch (err) {
      logger.error('[public-api] PUT /contacts/:id error:', err);
      return reply.status(500).send({ error: 'Failed to update contact' });
    }
  });

  // ── Conversations ─────────────────────────────────────────────────────────

  app.get('/api/public/conversations', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { limit = '20' } = request.query as Record<string, string>;

      const conversations = await prisma.conversation.findMany({
        where: { orgId },
        select: {
          id: true, threadType: true, externalThreadId: true,
          lastMessageAt: true, unreadCount: true, isReplied: true,
          contact: { select: { id: true, fullName: true, phone: true, avatarUrl: true } },
        },
        orderBy: { lastMessageAt: 'desc' },
        take: Math.min(parseInt(limit) || 20, 100),
      });

      return { conversations };
    } catch (err) {
      logger.error('[public-api] GET /conversations error:', err);
      return reply.status(500).send({ error: 'Failed to fetch conversations' });
    }
  });

  app.get('/api/public/conversations/:id/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { id } = request.params as { id: string };
      const { limit = '50' } = request.query as Record<string, string>;

      const conv = await prisma.conversation.findFirst({ where: { id, orgId }, select: { id: true } });
      if (!conv) return reply.status(404).send({ error: 'Conversation not found' });

      const messages = await prisma.message.findMany({
        where: { conversationId: id, isDeleted: false },
        orderBy: { sentAt: 'desc' },
        take: Math.min(parseInt(limit) || 50, 200),
        select: {
          id: true, senderType: true, senderName: true,
          content: true, contentType: true, sentAt: true, attachments: true,
        },
      });

      return { messages };
    } catch (err) {
      logger.error('[public-api] GET /conversations/:id/messages error:', err);
      return reply.status(500).send({ error: 'Failed to fetch messages' });
    }
  });

  // ── Appointments ──────────────────────────────────────────────────────────

  app.get('/api/public/appointments', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { from, to } = request.query as Record<string, string>;

      const where: any = { orgId };
      if (from || to) {
        where.appointmentDate = {};
        if (from) where.appointmentDate.gte = new Date(from);
        if (to) where.appointmentDate.lte = new Date(to);
      }

      const appointments = await prisma.appointment.findMany({
        where,
        include: { contact: { select: { id: true, fullName: true, phone: true } } },
        orderBy: { appointmentDate: 'asc' },
        take: 100,
      });

      return { appointments };
    } catch (err) {
      logger.error('[public-api] GET /appointments error:', err);
      return reply.status(500).send({ error: 'Failed to fetch appointments' });
    }
  });

  app.post('/api/public/appointments', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const body = request.body as Record<string, any>;

      if (!body?.contactId || !body?.appointmentDate) {
        return reply.status(400).send({ error: 'contactId and appointmentDate are required' });
      }

      const contact = await prisma.contact.findFirst({ where: { id: body.contactId, orgId }, select: { id: true } });
      if (!contact) return reply.status(404).send({ error: 'Contact not found' });

      const appointment = await prisma.appointment.create({
        data: {
          orgId,
          contactId: body.contactId,
          appointmentDate: new Date(body.appointmentDate),
          appointmentTime: body.appointmentTime,
          type: body.type,
          notes: body.notes,
        },
      });

      return reply.status(201).send(appointment);
    } catch (err) {
      logger.error('[public-api] POST /appointments error:', err);
      return reply.status(500).send({ error: 'Failed to create appointment' });
    }
  });

  // ── Messages send ─────────────────────────────────────────────────────────

  app.post('/api/public/messages/send', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const body = request.body as Record<string, any>;

      // Gom danh sách URL ảnh (hỗ trợ cả imageUrl đơn lẫn imageUrls mảng).
      const imageUrls: string[] = [
        ...(typeof body?.imageUrl === 'string' ? [body.imageUrl] : []),
        ...(Array.isArray(body?.imageUrls) ? body.imageUrls.filter((u: unknown) => typeof u === 'string') : []),
      ];
      const hasContent = typeof body?.content === 'string' && body.content.length > 0;

      if (!body?.zaloAccountId || !body?.threadId) {
        return reply.status(400).send({ error: 'zaloAccountId and threadId are required' });
      }
      if (!hasContent && imageUrls.length === 0) {
        return reply.status(400).send({ error: 'content or imageUrl(s) is required' });
      }
      if (imageUrls.length > PUBLIC_MAX_IMAGES) {
        return reply.status(400).send({ error: `tối đa ${PUBLIC_MAX_IMAGES} ảnh mỗi lần gửi` });
      }

      // Verify account belongs to org
      const account = await prisma.zaloAccount.findFirst({
        where: { id: body.zaloAccountId, orgId },
        select: { id: true, status: true },
      });
      if (!account) return reply.status(404).send({ error: 'Zalo account not found' });
      if (account.status !== 'connected') {
        return reply.status(422).send({ error: 'Zalo account is not connected' });
      }

      // Dynamically import zaloPool to avoid circular deps
      const { zaloPool } = await import('../zalo/zalo-pool.js');
      const api = zaloPool.getApi(body.zaloAccountId);
      if (!api) return reply.status(422).send({ error: 'Zalo account not active in pool' });

      const threadType = body.threadType === 'group' ? 1 : 0;

      try {
        // captionMode=true: lời nhắn đi làm desc của ảnh cuối (tới được khách chặn tin text).
        await sendToThread(api, orgId, body.zaloAccountId, body.threadId, threadType, hasContent ? body.content : '', imageUrls, body.captionMode === true);
      } catch (err) {
        if (err instanceof PartialSendError) {
          // Đã qua pha upload, lỗi pha gửi → CÓ THỂ đã giao một phần ảnh. Báo riêng,
          // 409 + partial=true để bot/người vận hành KIỂM TRA trước khi gửi lại (tránh trùng).
          logger.error(`[public-api] /messages/send PARTIAL (delivered=${err.deliveredCount}): ${err.message}`);
          return reply.status(409).send({
            error: 'Có thể đã gửi được một phần ảnh — KIỂM TRA hội thoại trước khi gửi lại để tránh trùng.',
            partial: true,
          });
        }
        const msg = err instanceof SsrfBlockedError
          ? `URL ảnh không hợp lệ (chỉ chấp nhận HTTPS công khai)`
          : `Không gửi được: ${(err as Error).message}`;
        return reply.status(400).send({ error: msg });
      }
      return { success: true, images: imageUrls.length };
    } catch (err) {
      logger.error('[public-api] POST /messages/send error:', err);
      return reply.status(500).send({ error: 'Failed to send message' });
    }
  });

  // ── Liệt kê tài khoản Zalo (cho bot chọn nick đăng) ───────────────────────
  app.get('/api/public/zalo-accounts', async (request: FastifyRequest) => {
    const orgId = (request as any).orgId as string;
    const accounts = await prisma.zaloAccount.findMany({
      where: { orgId, archivedAt: null },
      select: { id: true, displayName: true, status: true, avatarUrl: true },
      orderBy: { displayName: 'asc' },
    });
    return { accounts };
  });

  // ── Liệt kê nhóm của 1 nick (cho bot chọn nhóm đăng) ──────────────────────
  app.get('/api/public/zalo-accounts/:accountId/groups', async (request: FastifyRequest, reply: FastifyReply) => {
    const orgId = (request as any).orgId as string;
    const { accountId } = request.params as { accountId: string };
    const account = await prisma.zaloAccount.findFirst({ where: { id: accountId, orgId }, select: { id: true } });
    if (!account) return reply.status(404).send({ error: 'Zalo account not found' });

    const rows = await prisma.conversation.findMany({
      where: { orgId, zaloAccountId: accountId, threadType: 'group' },
      select: { externalThreadId: true, groupName: true, groupAvatarUrl: true, groupMembersCount: true },
      orderBy: { lastMessageAt: 'desc' },
    });
    const groups = rows
      .filter((r) => r.externalThreadId)
      .map((r) => ({
        groupId: r.externalThreadId as string,
        name: r.groupName as string | null,
        avatar: r.groupAvatarUrl as string | null,
        membersCount: r.groupMembersCount as number | null,
      }));

    // ?refresh=1: cố lấy thêm nhóm chưa từng sync vào Conversation (nhóm mới/chưa nhắn).
    // "Best effort" — mọi lỗi zca-js (chưa login/timeout) đều fallback về DB-only, KHÔNG 500.
    const { refresh } = request.query as { refresh?: string };
    if (refresh) {
      try {
        const { zaloOps } = await import('../../shared/zalo-operations.js');
        const all = await zaloOps.getAllGroups(accountId);
        const allIds: string[] = Object.keys((all as any)?.gridVerMap ?? {});
        const known = new Set(groups.map((g) => g.groupId));
        const missingIds = allIds.filter((id) => id && !known.has(id));

        // getGroupInfo nhận tối đa 50 id/lần — chia lô.
        for (let i = 0; i < missingIds.length; i += 50) {
          const batch = missingIds.slice(i, i + 50);
          const info = await zaloOps.getGroupInfo(accountId, batch);
          const infoMap = (info as any)?.gridInfoMap ?? {};
          for (const id of batch) {
            const g = infoMap[id];
            if (!g) continue;
            groups.push({
              groupId: id,
              name: g.name ?? null,
              avatar: g.fullAvt || g.avt || null,
              membersCount: g.totalMember ?? null,
            });
          }
        }
      } catch (err) {
        logger.warn(`[public-api] groups refresh failed for account ${accountId}, fallback to DB-only:`, err);
      }
    }

    // Dedupe theo groupId (DB trước, nhóm mới append sau).
    const seen = new Set<string>();
    const deduped = groups.filter((g) => {
      if (seen.has(g.groupId)) return false;
      seen.add(g.groupId);
      return true;
    });
    return { groups: deduped };
  });

  // ── Broadcast: đăng 1 bài (text + ảnh) vào NHIỀU nhóm của 1 nick ──────────
  app.post('/api/public/groups/broadcast', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const body = request.body as Record<string, any>;

      const groupIds: string[] = Array.isArray(body?.groupIds)
        ? body.groupIds.filter((g: unknown) => typeof g === 'string' && g.length > 0)
        : [];
      const imageUrls: string[] = Array.isArray(body?.imageUrls)
        ? body.imageUrls.filter((u: unknown) => typeof u === 'string')
        : [];
      const content: string = typeof body?.content === 'string' ? body.content : '';
      const externalRef: string | null = typeof body?.externalRef === 'string' ? body.externalRef : null;

      if (!body?.zaloAccountId || groupIds.length === 0) {
        return reply.status(400).send({ error: 'zaloAccountId and groupIds[] are required' });
      }
      if (!content && imageUrls.length === 0) {
        return reply.status(400).send({ error: 'content or imageUrls is required' });
      }
      if (groupIds.length > BROADCAST_MAX_GROUPS) {
        return reply.status(400).send({ error: `tối đa ${BROADCAST_MAX_GROUPS} nhóm mỗi lần` });
      }
      if (imageUrls.length > PUBLIC_MAX_IMAGES) {
        return reply.status(400).send({ error: `tối đa ${PUBLIC_MAX_IMAGES} ảnh` });
      }

      const account = await prisma.zaloAccount.findFirst({
        where: { id: body.zaloAccountId, orgId },
        select: { id: true, status: true, displayName: true },
      });
      if (!account) return reply.status(404).send({ error: 'Zalo account not found' });
      if (account.status !== 'connected') return reply.status(422).send({ error: 'Zalo account is not connected' });

      const { zaloPool } = await import('../zalo/zalo-pool.js');
      const api = zaloPool.getApi(body.zaloAccountId);
      if (!api) return reply.status(422).send({ error: 'Zalo account not active in pool' });

      // Map groupId → tên nhóm (để log dễ đọc), từ Conversation đã sync.
      const convs = await prisma.conversation.findMany({
        where: { orgId, zaloAccountId: body.zaloAccountId, threadType: 'group', externalThreadId: { in: groupIds } },
        select: { externalThreadId: true, groupName: true },
      });
      const nameOf = new Map(convs.map((c) => [c.externalThreadId, c.groupName]));

      // ── Quy trình 2 PHA (chống TRÙNG TEXT) ──────────────────────────────────
      // Pha 1: gửi TEXT cho TỪNG nhóm, đúng 1 lần/nhóm (text nhanh → lên hết các nhóm trước).
      // Pha 2: gửi ẢNH cho từng nhóm (cả bộ), NGHỈ giữa các nhóm chống khóa nick.
      // Text gửi đúng 1 lần, KHÔNG bao giờ gửi lại → không trùng dù ảnh lỗi.
      // Ảnh vẫn có retry AN TOÀN (sendAlbumWithSafeRetry: chỉ gửi lại khi xác minh CHƯA
      // giao ảnh nào) → cứu lỗi "fetch failed" cú đầu mà không nhân đôi.
      const hasText = !!(content && content.trim());
      const st = new Map<string, { ok: boolean; partial?: boolean; error?: string }>();
      for (const gid of groupIds) st.set(gid, { ok: false });

      // Tải ảnh về tmp 1 LẦN, dùng chung cho mọi nhóm (trước đây tải lại mỗi nhóm — phí).
      const tmpRoot = path.join(tmpdir(), 'zalocrm-public-send', randomUUID());
      const tmpPaths: string[] = [];
      if (imageUrls.length > 0) {
        await mkdir(tmpRoot, { recursive: true });
        for (let i = 0; i < imageUrls.length; i++) {
          const img = await downloadImage(imageUrls[i]);
          const tmpPath = path.join(tmpRoot, `${i}${img.ext}`);
          await writeFile(tmpPath, img.buffer);
          tmpPaths.push(tmpPath);
        }
      }

      try {
        // PHA 1 — TEXT cho từng nhóm (1 lần/nhóm)
        if (hasText) {
          for (const gid of groupIds) {
            try {
              await api.sendMessage(content, gid, 1 /* group */);
              st.get(gid)!.ok = true; // tạm coi ok; pha 2 ghi đè nếu có ảnh lỗi
            } catch (err) {
              const s = st.get(gid)!; s.ok = false; s.error = (err as Error)?.message;
              logger.error(`[broadcast] TEXT nhóm ${gid} (${nameOf.get(gid) ?? '?'}) LỖI:`, (err as Error)?.message);
            }
          }
        }
        // PHA 2 — ẢNH cho từng nhóm, nghỉ giữa các nhóm
        if (tmpPaths.length > 0) {
          for (let i = 0; i < groupIds.length; i++) {
            const gid = groupIds[i];
            const s = st.get(gid)!;
            // Gửi ảnh nhóm này. ok cuối = (text ok nếu có text) VÀ (ảnh ok).
            try {
              await sendAlbumWithSafeRetry(api, orgId, body.zaloAccountId, gid, 1 /* group */, '', tmpPaths);
              if (!hasText) s.ok = true; // không có text → ok do ảnh; có text → giữ kết quả text
            } catch (err) {
              s.ok = false;
              s.partial = err instanceof PartialSendError ? true : s.partial;
              s.error = err instanceof SsrfBlockedError
                ? 'URL ảnh không hợp lệ (HTTPS only)'
                : err instanceof PartialSendError
                  ? `Có thể đã đăng một phần ảnh (đã giao ${err.deliveredCount}) — kiểm tra nhóm trước khi đăng lại`
                  : (err as Error).message;
              logger.error(`[broadcast] ẢNH nhóm ${gid} (${nameOf.get(gid) ?? '?'}) LỖI:`, s.error);
            }
            if (i < groupIds.length - 1 && BROADCAST_GROUP_DELAY_MS > 0) await sleep(BROADCAST_GROUP_DELAY_MS);
          }
        }
      } finally {
        if (tmpPaths.length > 0) await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }

      const results: Array<{ groupId: string; groupName: string | null; ok: boolean; partial?: boolean; error?: string }> =
        groupIds.map((gid) => {
          const s = st.get(gid)!;
          return { groupId: gid, groupName: nameOf.get(gid) ?? null, ok: s.ok, partial: s.partial, error: s.ok ? undefined : s.error };
        });

      const sent = results.filter((r) => r.ok).length;
      const failed = results.length - sent;
      const status = failed === 0 ? 'ok' : sent === 0 ? 'failed' : 'partial';

      // Ghi nhật ký để CRM soi lỗi (fire-and-forget — không chặn response).
      prisma.groupPostLog.create({
        data: {
          orgId,
          zaloAccountId: body.zaloAccountId,
          accountName: account.displayName ?? null,
          content: content || null,
          imageUrls,
          groupResults: results,
          sentCount: sent,
          failedCount: failed,
          status,
          source: typeof body?.source === 'string' ? body.source : 'bot',
          externalRef,
        },
      }).catch((err) => logger.error('[public-api] groupPostLog create error:', err));

      return { success: true, sent, failed, status, results };
    } catch (err) {
      logger.error('[public-api] POST /groups/broadcast error:', err);
      return reply.status(500).send({ error: 'Failed to broadcast' });
    }
  });

  // ── Tra kết quả đăng nhóm theo externalRef ────────────────────────────────
  // Bot gọi khi request /groups/broadcast bị TIMEOUT phía bot (Zalo upload chậm, album
  // nhiều ảnh × nhiều nhóm có thể mất 5–15 phút) để đối chiếu kết quả THẬT thay vì
  // ghi nhận "failed" trong khi CRM vẫn đăng xong. Trả found=false nếu CRM chưa xong.
  app.get('/api/public/group-post-logs', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { externalRef } = request.query as Record<string, string>;
      if (!externalRef || typeof externalRef !== 'string') {
        return reply.status(400).send({ error: 'externalRef is required' });
      }
      const log = await prisma.groupPostLog.findFirst({
        where: { orgId, externalRef },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, status: true, sentCount: true, failedCount: true,
          groupResults: true, createdAt: true, zaloAccountId: true,
        },
      });
      if (!log) return { found: false };
      return {
        found: true,
        id: log.id,
        status: log.status,
        sent: log.sentCount,
        failed: log.failedCount,
        results: log.groupResults,
        createdAt: log.createdAt,
        zaloAccountId: log.zaloAccountId,
      };
    } catch (err) {
      logger.error('[public-api] GET /group-post-logs error:', err);
      return reply.status(500).send({ error: 'Failed to fetch group post log' });
    }
  });
}

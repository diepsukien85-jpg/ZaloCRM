/**
 * routes.ts — API cho AI tự trả lời theo thẻ phân loại.
 *
 *   GET    /api/v1/ai/auto-reply/profiles          — cấu hình từng nick + thống kê hôm nay + danh sách nick
 *   GET    /api/v1/ai/auto-reply/profiles/:accountId — cấu hình 1 nick (mặc định nếu chưa có)
 *   PUT    /api/v1/ai/auto-reply/profiles/:accountId — lưu cấu hình 1 nick (admin)
 *   DELETE /api/v1/ai/auto-reply/profiles/:accountId — xoá cấu hình 1 nick (admin)
 *   POST   /api/v1/ai/auto-reply/profiles/:accountId/clone-from — học theo nick khác: chép hướng dẫn + bài học (admin)
 *   GET    /api/v1/ai/auto-reply/tags?accountIds=  — thẻ Zalo của nick đã chọn + Tag CRM (kèm số khách)
 *   GET    /api/v1/ai/auto-reply/playbook          — kho kịch bản (dùng chung + riêng từng nick)
 *   POST   /api/v1/ai/auto-reply/playbook          — thêm mục (admin)
 *   PUT    /api/v1/ai/auto-reply/playbook/:id      — sửa mục (admin)
 *   DELETE /api/v1/ai/auto-reply/playbook/:id      — xoá mục (admin)
 *   GET    /api/v1/ai/auto-reply/logs              — nhật ký gần đây
 *   POST   /api/v1/ai/auto-reply/test/:conversationId — chạy thử 1 hội thoại, KHÔNG gửi (admin)
 *   ── Vòng tự học ──
 *   POST   /api/v1/ai/auto-reply/logs/:id/feedback          — chấm 👍/👎 (+ câu đúng) → rút bài học ngay (admin)
 *   GET    /api/v1/ai/auto-reply/profiles/:accountId/lessons — bài học của nick
 *   POST   /api/v1/ai/auto-reply/profiles/:accountId/lessons — thêm bài học tay (admin)
 *   PUT    /api/v1/ai/auto-reply/lessons/:id                 — sửa / bật / tắt (admin)
 *   DELETE /api/v1/ai/auto-reply/lessons/:id                 — xoá (admin)
 *   POST   /api/v1/ai/auto-reply/profiles/:accountId/learn-now — học ngay (admin)
 *   GET    /api/v1/ai/auto-reply/profiles/:accountId/quality — điểm chất lượng 14 ngày
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import { authMiddleware } from '../../auth/auth-middleware.js';
import { requireRole } from '../../auth/role-middleware.js';
import { orgDayRange } from '../daily-brief-service.js';
import {
  defaultProfile, deleteProfile, getProfile, listProfiles, saveProfile, validatePlaybookInput,
  validateProfileInput, type PlaybookInput, type ProfileInput,
} from './config-service.js';
import { evaluateConversation } from './auto-reply-service.js';
import { CloneError, cloneProfileFrom } from './clone-service.js';
import { isCatalogEnabled } from './catalog-service.js';
import { defaultHandoffChatId, isTelegramConfigured, sendTelegram } from './handoff-notify.js';
import { evaluateOutcomes, learnFromFeedback, qualityByDay, runDailyLearning, sanitizeLesson } from './learning-service.js';
import { finishTeaching, teachTurn, trySimulate, type LessonOp, type TeachTurn } from './teach-service.js';

const ADMIN = { preHandler: requireRole('owner', 'admin') };

export async function aiAutoReplyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  /** Nick thuộc org → trả tên, null nếu không thuộc org. */
  async function orgAccount(orgId: string, accountId: string) {
    return prisma.zaloAccount.findFirst({
      where: { id: accountId, orgId },
      select: { id: true, displayName: true, phone: true, avatarUrl: true, status: true },
    });
  }

  app.get('/api/v1/ai/auto-reply/profiles', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = request.user!.orgId;
      const [profiles, accounts, org] = await Promise.all([
        listProfiles(orgId),
        prisma.zaloAccount.findMany({
          where: { orgId, purged: false },
          orderBy: { createdAt: 'asc' },
          select: { id: true, displayName: true, phone: true, avatarUrl: true, status: true },
        }),
        prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } }),
      ]);
      const { start } = orgDayRange(new Date(), org?.timezone);
      const grouped = await prisma.aiAutoReplyLog.groupBy({
        by: ['zaloAccountId', 'decision'],
        where: { orgId, createdAt: { gte: start } },
        _count: { _all: true },
      });
      const todayOf = (id: string) => Object.fromEntries(
        grouped.filter((g) => g.zaloAccountId === id).map((g) => [g.decision, g._count._all]),
      );
      const [lessonCounts, quality] = await Promise.all([
        prisma.aiLesson.groupBy({ by: ['zaloAccountId'], where: { orgId, active: true }, _count: { _all: true } }),
        Promise.all(profiles.map(async (p) => [p.zaloAccountId, await qualityByDay(orgId, p.zaloAccountId, 7)] as const)),
      ]);
      const lessonsOf = (id: string) => lessonCounts.find((l) => l.zaloAccountId === id)?._count._all ?? 0;
      const quality7 = (id: string) => {
        const days = quality.find(([k]) => k === id)?.[1] ?? [];
        const good = days.reduce((s, d) => s + d.good, 0);
        const bad = days.reduce((s, d) => s + d.bad, 0);
        return good + bad > 0 ? Math.round((good / (good + bad)) * 100) : null;
      };
      const accById = new Map(accounts.map((a) => [a.id, a]));
      const configured = new Set(profiles.map((p) => p.zaloAccountId));
      return {
        // Thẻ xếp theo thứ tự nick (giống trang Tài khoản Zalo), không theo giờ tạo.
        profiles: accounts
          .map((a) => profiles.find((p) => p.zaloAccountId === a.id))
          .filter((p): p is NonNullable<typeof p> => !!p)
          .map((p) => {
            const a = accById.get(p.zaloAccountId)!;
            return {
              ...p,
              accountName: a.displayName || a.phone || a.id.slice(0, 8),
              accountAvatar: a.avatarUrl,
              accountStatus: a.status,
              clonedFromName: p.clonedFromAccountId
                ? (() => { const s = accById.get(p.clonedFromAccountId); return s ? s.displayName || s.phone || s.id.slice(0, 8) : 'nick đã xoá'; })()
                : null,
              today: todayOf(p.zaloAccountId),
              lessonCount: lessonsOf(p.zaloAccountId),
              quality7d: quality7(p.zaloAccountId),
            };
          }),
        // Kết nối phía server (không lộ token): kho sản phẩm bot-noi-bo, Telegram báo chuyển người.
        server: {
          catalog: isCatalogEnabled(),
          telegram: isTelegramConfigured(),
          defaultChatId: defaultHandoffChatId() ? `…${defaultHandoffChatId()!.slice(-4)}` : null,
        },
        accounts: accounts.map((a) => ({
          id: a.id,
          name: a.displayName || a.phone || a.id.slice(0, 8),
          status: a.status,
          configured: configured.has(a.id),
        })),
      };
    } catch (err) {
      logger.error('[ai-auto-reply] list profiles error:', err);
      return reply.status(500).send({ error: 'Không tải được cấu hình AI' });
    }
  });

  app.get('/api/v1/ai/auto-reply/profiles/:accountId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const orgId = request.user!.orgId;
    const acc = await orgAccount(orgId, accountId);
    if (!acc) return reply.status(404).send({ error: 'Không tìm thấy nick Zalo' });
    const profile = await getProfile(orgId, accountId, { fresh: true });
    return { profile: profile ?? defaultProfile(accountId), configured: !!profile, accountName: acc.displayName || acc.phone };
  });

  app.put('/api/v1/ai/auto-reply/profiles/:accountId', ADMIN, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const orgId = request.user!.orgId;
    const input = (request.body ?? {}) as ProfileInput & { zaloAccountId?: unknown };
    delete input.zaloAccountId;
    const invalid = validateProfileInput(input);
    if (invalid) return reply.status(400).send({ error: invalid });
    if (!(await orgAccount(orgId, accountId))) return reply.status(404).send({ error: 'Không tìm thấy nick Zalo' });
    try {
      return { profile: await saveProfile(orgId, accountId, input) };
    } catch (err) {
      logger.error('[ai-auto-reply] save profile error:', err);
      return reply.status(500).send({ error: 'Không lưu được cấu hình' });
    }
  });

  // Học theo nick khác: chép hướng dẫn / skill + bài học + kịch bản riêng của nick mẫu sang nick này.
  app.post('/api/v1/ai/auto-reply/profiles/:accountId/clone-from', ADMIN, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const { sourceAccountId } = (request.body ?? {}) as { sourceAccountId?: unknown };
    if (typeof sourceAccountId !== 'string' || !sourceAccountId) return reply.status(400).send({ error: 'Chưa chọn nick mẫu' });
    try {
      const res = await cloneProfileFrom(request.user!.orgId, accountId, sourceAccountId);
      logger.info(`[ai-auto-reply] nick ${accountId} học theo ${sourceAccountId}: ${res.lessons} bài học, ${res.playbook} kịch bản`);
      return res;
    } catch (err) {
      if (err instanceof CloneError) return reply.status(err.status).send({ error: err.message });
      logger.error('[ai-auto-reply] clone profile error:', err);
      return reply.status(500).send({ error: 'Không chép được cấu hình' });
    }
  });

  app.delete('/api/v1/ai/auto-reply/profiles/:accountId', ADMIN, async (request: FastifyRequest) => {
    const { accountId } = request.params as { accountId: string };
    return { removed: await deleteProfile(request.user!.orgId, accountId) };
  });

  /**
   * Thẻ có thể chọn làm thẻ kích hoạt, THEO NICK đã chọn (?accountIds=a,b):
   *   zalo: thẻ phân loại Zalo của từng nick (bảng zalo_labels — đủ cả thẻ chưa
   *         gắn cho ai) + số khách của nick đó đang mang thẻ.
   *   crm:  Tag CRM (dùng chung mọi nick) + số khách của các nick đã chọn mang tag.
   * Giá trị lưu vào triggerTags: thẻ Zalo dạng "🔵 <tên>" (giống Tag CRM mirror).
   */
  app.get('/api/v1/ai/auto-reply/tags', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = request.user!.orgId;
      const { accountIds = '' } = request.query as { accountIds?: string };
      const ids = accountIds.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
      if (ids.length === 0) return { zalo: [], crm: [] };

      const [accounts, labels, zaloCounts, crmTags, crmCounts] = await Promise.all([
        prisma.zaloAccount.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, displayName: true, phone: true } }),
        prisma.zaloLabel.findMany({
          where: { orgId, zaloAccountId: { in: ids } },
          orderBy: [{ offset: 'asc' }, { text: 'asc' }],
          select: { zaloAccountId: true, text: true, color: true, emoji: true },
        }),
        prisma.$queryRaw<Array<{ account_id: string; name: string; n: bigint }>>`
          SELECT f.zalo_account_id AS account_id, l->>'name' AS name, COUNT(*) AS n
          FROM friends f, jsonb_array_elements(f.zalo_labels) l
          WHERE f.org_id = ${orgId} AND f.zalo_account_id = ANY(${ids}) AND jsonb_typeof(f.zalo_labels) = 'array'
          GROUP BY 1, 2`,
        prisma.crmTag.findMany({
          where: { orgId, archivedAt: null, isActive: true, managedBy: null },
          orderBy: [{ order: 'asc' }, { name: 'asc' }],
          select: { name: true, color: true },
        }),
        prisma.$queryRaw<Array<{ name: string; n: bigint }>>`
          SELECT x.tag AS name, COUNT(DISTINCT f.id) AS n
          FROM friends f
          JOIN contacts c ON c.id = f.contact_id
          CROSS JOIN LATERAL (
            SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(f.crm_tags_per_nick) = 'array' THEN f.crm_tags_per_nick ELSE '[]'::jsonb END)
            UNION
            SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.tags) = 'array' THEN c.tags ELSE '[]'::jsonb END)
          ) AS x(tag)
          WHERE f.org_id = ${orgId} AND f.zalo_account_id = ANY(${ids}) AND x.tag NOT LIKE '🔵 %'
          GROUP BY 1`,
      ]);

      const zc = new Map(zaloCounts.map((r) => [`${r.account_id}|${r.name}`, Number(r.n)]));
      const cc = new Map(crmCounts.map((r) => [r.name, Number(r.n)]));
      const zalo = ids
        .map((id) => accounts.find((a) => a.id === id))
        .filter((a): a is NonNullable<typeof a> => !!a)
        .map((a) => ({
          accountId: a.id,
          accountName: a.displayName || a.phone || a.id.slice(0, 8),
          labels: labels
            .filter((l) => l.zaloAccountId === a.id)
            .map((l) => ({
              value: `🔵 ${l.text}`,
              text: l.text,
              color: l.color,
              emoji: l.emoji,
              count: zc.get(`${a.id}|${l.text}`) ?? 0,
            })),
        }));
      const crm = crmTags.map((t) => ({ value: t.name, text: t.name, color: t.color, count: cc.get(t.name) ?? 0 }));
      return { zalo, crm };
    } catch (err) {
      logger.error('[ai-auto-reply] tags error:', err);
      return reply.status(500).send({ error: 'Không tải được danh sách thẻ' });
    }
  });

  app.get('/api/v1/ai/auto-reply/playbook', async (request: FastifyRequest) => {
    const entries = await prisma.aiPlaybookEntry.findMany({
      where: { orgId: request.user!.orgId },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    return { entries };
  });

  app.post('/api/v1/ai/auto-reply/playbook', ADMIN, async (request: FastifyRequest, reply: FastifyReply) => {
    const input = (request.body ?? {}) as PlaybookInput;
    const invalid = validatePlaybookInput(input, true);
    if (invalid) return reply.status(400).send({ error: invalid });
    if (input.zaloAccountId && !(await orgAccount(request.user!.orgId, input.zaloAccountId))) {
      return reply.status(400).send({ error: 'Nick Zalo không hợp lệ' });
    }
    const entry = await prisma.aiPlaybookEntry.create({
      data: {
        orgId: request.user!.orgId,
        zaloAccountId: input.zaloAccountId || null,
        title: input.title!.trim(),
        category: input.category?.trim() || null,
        keywords: (input.keywords ?? []).map((k) => k.trim()).filter(Boolean),
        content: input.content!.trim(),
        priority: input.priority ?? 0,
        enabled: input.enabled ?? true,
      },
    });
    return { entry };
  });

  app.put('/api/v1/ai/auto-reply/playbook/:id', ADMIN, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const input = (request.body ?? {}) as PlaybookInput;
    const invalid = validatePlaybookInput(input, false);
    if (invalid) return reply.status(400).send({ error: invalid });
    const existing = await prisma.aiPlaybookEntry.findFirst({ where: { id, orgId: request.user!.orgId }, select: { id: true } });
    if (!existing) return reply.status(404).send({ error: 'Không tìm thấy mục kịch bản' });
    if (input.zaloAccountId && !(await orgAccount(request.user!.orgId, input.zaloAccountId))) {
      return reply.status(400).send({ error: 'Nick Zalo không hợp lệ' });
    }
    const entry = await prisma.aiPlaybookEntry.update({
      where: { id },
      data: {
        zaloAccountId: input.zaloAccountId === undefined ? undefined : (input.zaloAccountId || null),
        title: input.title?.trim(),
        category: input.category === undefined ? undefined : (input.category?.trim() || null),
        keywords: input.keywords?.map((k) => k.trim()).filter(Boolean),
        content: input.content?.trim(),
        priority: input.priority,
        enabled: input.enabled,
      },
    });
    return { entry };
  });

  app.delete('/api/v1/ai/auto-reply/playbook/:id', ADMIN, async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    const res = await prisma.aiPlaybookEntry.deleteMany({ where: { id, orgId: request.user!.orgId } });
    return { removed: res.count };
  });

  app.get('/api/v1/ai/auto-reply/logs', async (request: FastifyRequest) => {
    const { limit = '50', decision, accountId } = request.query as { limit?: string; decision?: string; accountId?: string };
    const orgId = request.user!.orgId;
    const logs = await prisma.aiAutoReplyLog.findMany({
      where: { orgId, ...(decision ? { decision } : {}), ...(accountId ? { zaloAccountId: accountId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200),
    });
    const convs = await prisma.conversation.findMany({
      where: { id: { in: [...new Set(logs.map((l) => l.conversationId))] }, orgId },
      select: { id: true, contact: { select: { fullName: true, crmName: true } }, zaloAccount: { select: { displayName: true } } },
    });
    const byId = new Map(convs.map((c) => [c.id, c]));
    return {
      logs: logs.map((l) => {
        const c = byId.get(l.conversationId);
        return {
          ...l,
          customerName: c?.contact?.crmName || c?.contact?.fullName || null,
          nickName: c?.zaloAccount?.displayName || null,
        };
      }),
    };
  });

  app.post('/api/v1/ai/auto-reply/profiles/:accountId/test-telegram', ADMIN, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const orgId = request.user!.orgId;
    const acc = await orgAccount(orgId, accountId);
    if (!acc) return reply.status(404).send({ error: 'Không tìm thấy nick Zalo' });
    const body = (request.body ?? {}) as { chatId?: unknown };
    const chatId = (typeof body.chatId === 'string' && body.chatId.trim()) || defaultHandoffChatId();
    if (!isTelegramConfigured() || !chatId) return reply.status(400).send({ error: 'Server chưa cấu hình bot Telegram / chat id' });
    try {
      await sendTelegram(chatId, `✅ Thử thông báo chuyển người của AI · nick <b>${(acc.displayName || '').replace(/</g, '&lt;')}</b>. Khi AI chuyển khách cho anh, tin sẽ về đây.`);
      return { ok: true };
    } catch (err: any) {
      return reply.status(400).send({ error: `Gửi Telegram lỗi: ${err?.message ?? err}` });
    }
  });

  // ── Dạy cho AI (trò chuyện) ─────────────────────────────────────────────

  const readTeachBody = (body: unknown) => {
    const b = (body ?? {}) as { transcript?: unknown; pending?: unknown; text?: unknown; gender?: unknown };
    const transcript: TeachTurn[] = Array.isArray(b.transcript)
      ? b.transcript
          .filter((m: any) => m && ['owner', 'teacher', 'customer', 'bot'].includes(m.role) && typeof m.content === 'string')
          .slice(-40)
          .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 3000) }))
      : [];
    const pending = (Array.isArray(b.pending) ? b.pending : []) as LessonOp[];
    const gender: 'male' | 'female' | null = b.gender === 'male' || b.gender === 'female' ? b.gender : null;
    return { transcript, pending, text: typeof b.text === 'string' ? b.text.trim().slice(0, 1500) : '', gender };
  };
  const teachGuard = async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await orgAccount(request.user!.orgId, accountId))) {
      reply.status(404).send({ error: 'Không tìm thấy nick Zalo' });
      return null;
    }
    return accountId;
  };

  app.post('/api/v1/ai/auto-reply/profiles/:accountId/teach', ADMIN, async (request: FastifyRequest, reply: FastifyReply) => {
    const accountId = await teachGuard(request, reply);
    if (!accountId) return;
    const { transcript, pending } = readTeachBody(request.body);
    if (!transcript.some((m) => m.role === 'owner')) return reply.status(400).send({ error: 'Chưa có lời dạy' });
    try {
      return await teachTurn(request.user!.orgId, accountId, transcript, pending);
    } catch (err: any) {
      logger.warn('[ai-teach] lượt dạy lỗi:', err);
      return reply.status(400).send({ error: err?.message ?? 'Dạy không thành công' });
    }
  });

  app.post('/api/v1/ai/auto-reply/profiles/:accountId/teach/try', ADMIN, async (request: FastifyRequest, reply: FastifyReply) => {
    const accountId = await teachGuard(request, reply);
    if (!accountId) return;
    const { transcript, pending, text, gender } = readTeachBody(request.body);
    if (!text) return reply.status(400).send({ error: 'Chưa nhập câu khách hỏi' });
    try {
      return await trySimulate(request.user!.orgId, accountId, text, pending, gender, transcript);
    } catch (err: any) {
      logger.warn('[ai-teach] thử hỏi lỗi:', err);
      return reply.status(400).send({ error: err?.message ?? 'Thử không thành công' });
    }
  });

  app.post('/api/v1/ai/auto-reply/profiles/:accountId/teach/finish', ADMIN, async (request: FastifyRequest, reply: FastifyReply) => {
    const accountId = await teachGuard(request, reply);
    if (!accountId) return;
    const { transcript, pending } = readTeachBody(request.body);
    try {
      return await finishTeaching(request.user!.orgId, accountId, transcript, pending);
    } catch (err: any) {
      logger.error('[ai-teach] lưu buổi dạy lỗi:', err);
      return reply.status(500).send({ error: 'Lưu bài học không thành công' });
    }
  });

  // ── Vòng tự học ─────────────────────────────────────────────────────────

  app.post('/api/v1/ai/auto-reply/logs/:id/feedback', ADMIN, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { rating?: unknown; correctedReply?: unknown; note?: unknown };
    if (body.rating !== 'good' && body.rating !== 'bad' && body.rating !== null) {
      return reply.status(400).send({ error: 'rating phải là good, bad hoặc null' });
    }
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const log = await prisma.aiAutoReplyLog.findFirst({ where: { id, orgId: request.user!.orgId }, select: { id: true } });
    if (!log) return reply.status(404).send({ error: 'Không tìm thấy lượt' });
    await prisma.aiAutoReplyLog.update({
      where: { id },
      data: {
        feedback: body.rating,
        correctedReply: body.rating === 'bad' ? str(body.correctedReply, 2000) : null,
        feedbackNote: str(body.note, 1000),
        feedbackBy: request.user!.id,
        feedbackAt: new Date(),
      },
    });
    // 👎 kèm câu đúng / ghi chú → rút bài học ngay (nếu nick bật tự học).
    const learned = body.rating === 'bad' ? await learnFromFeedback(id).catch((err) => {
      logger.warn('[ai-learning] rút bài học lỗi:', err);
      return { lesson: null, reason: 'lỗi' };
    }) : { lesson: null };
    return { ok: true, ...learned };
  });

  app.get('/api/v1/ai/auto-reply/profiles/:accountId/lessons', async (request: FastifyRequest) => {
    const { accountId } = request.params as { accountId: string };
    const lessons = await prisma.aiLesson.findMany({
      where: { orgId: request.user!.orgId, zaloAccountId: accountId },
      orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
      take: 200,
    });
    return { lessons };
  });

  app.post('/api/v1/ai/auto-reply/profiles/:accountId/lessons', ADMIN, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const orgId = request.user!.orgId;
    if (!(await orgAccount(orgId, accountId))) return reply.status(404).send({ error: 'Không tìm thấy nick Zalo' });
    const content = sanitizeLesson((request.body as { content?: unknown } | undefined)?.content);
    if (!content) return reply.status(400).send({ error: 'Bài học quá ngắn hoặc không hợp lệ' });
    return { lesson: await prisma.aiLesson.create({ data: { orgId, zaloAccountId: accountId, content, source: 'manual' } }) };
  });

  app.put('/api/v1/ai/auto-reply/lessons/:id', ADMIN, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { content?: unknown; active?: unknown };
    const existing = await prisma.aiLesson.findFirst({ where: { id, orgId: request.user!.orgId }, select: { id: true } });
    if (!existing) return reply.status(404).send({ error: 'Không tìm thấy bài học' });
    const content = body.content === undefined ? undefined : sanitizeLesson(body.content);
    if (content === null) return reply.status(400).send({ error: 'Bài học quá ngắn hoặc không hợp lệ' });
    if (body.active !== undefined && typeof body.active !== 'boolean') return reply.status(400).send({ error: 'active phải là true/false' });
    return {
      lesson: await prisma.aiLesson.update({
        where: { id },
        // Chủ shop sửa tay thì coi như bài viết tay (không bị tự học gỡ đi).
        data: { content, active: body.active as boolean | undefined, ...(content ? { source: 'manual', inheritedFromAccountId: null } : {}) },
      }),
    };
  });

  app.delete('/api/v1/ai/auto-reply/lessons/:id', ADMIN, async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    return { removed: (await prisma.aiLesson.deleteMany({ where: { id, orgId: request.user!.orgId } })).count };
  });

  app.post('/api/v1/ai/auto-reply/profiles/:accountId/learn-now', ADMIN, async (request: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = request.params as { accountId: string };
    const orgId = request.user!.orgId;
    if (!(await orgAccount(orgId, accountId))) return reply.status(404).send({ error: 'Không tìm thấy nick Zalo' });
    try {
      await evaluateOutcomes(); // chấm nốt các lượt đủ 30 phút trước khi học
      return await runDailyLearning(orgId, accountId);
    } catch (err) {
      logger.error('[ai-learning] learn-now lỗi:', err);
      return reply.status(500).send({ error: 'Học không thành công' });
    }
  });

  app.get('/api/v1/ai/auto-reply/profiles/:accountId/quality', async (request: FastifyRequest) => {
    const { accountId } = request.params as { accountId: string };
    const { days = '14' } = request.query as { days?: string };
    const n = Math.min(Math.max(parseInt(days, 10) || 14, 1), 60);
    return { days: await qualityByDay(request.user!.orgId, accountId, n) };
  });

  app.post('/api/v1/ai/auto-reply/test/:conversationId', ADMIN, async (request: FastifyRequest, reply: FastifyReply) => {
    const { conversationId } = request.params as { conversationId: string };
    try {
      return await evaluateConversation(request.user!.orgId, conversationId, { test: true });
    } catch (err) {
      logger.error('[ai-auto-reply] test error:', err);
      return reply.status(500).send({ error: 'Chạy thử lỗi' });
    }
  });
}

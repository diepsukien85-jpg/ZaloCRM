/**
 * dashboard-routes.ts — KPI, message volume, pipeline, sources, and appointment stats.
 * All routes require JWT auth, scoped to user's orgId.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logger } from '../../shared/utils/logger.js';

type QueryParams = Record<string, string>;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Compute today's boundaries in UTC based on VN timezone (UTC+7)
function todayRange() {
  const now = new Date();
  const vnOffset = 7 * 60 * 60 * 1000;
  const vnNow = new Date(now.getTime() + vnOffset);
  // Lấy ngày VN bằng getter UTC (không phụ thuộc múi giờ máy chủ — trước đây dùng getter local
  // trên máy chạy +07 nên cộng 7 giờ 2 lần: "hôm nay" lệch từ 17h hôm qua, sau 17h nhảy sang ngày mai).
  const today = new Date(Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate()) - vnOffset);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  return { today, tomorrow };
}

function weekAgoDate(from: Date) {
  const d = new Date(from);
  d.setDate(d.getDate() - 7);
  return d;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /api/v1/dashboard/kpi
  app.get('/api/v1/dashboard/kpi', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { orgId } = request.user!;
      const { today, tomorrow } = todayRange();
      const weekAgo = weekAgoDate(today);

      const [messagesToday, unreplied, unread, aptsToday, newContacts, totalContacts] =
        await Promise.all([
          prisma.message.count({
            where: { conversation: { orgId }, sentAt: { gte: today, lt: tomorrow } },
          }),
          // Chỉ chat 1-1 (nhóm Zalo chiếm phần lớn → số trước đây 6.000+, lệch hẳn trang Tin nhắn).
          // Chưa trả lời = tin cuối là của khách (isReplied=false), khác "chưa đọc" (còn tin chưa mở).
          prisma.conversation.count({ where: { orgId, threadType: 'user', isReplied: false } }),
          prisma.conversation.count({ where: { orgId, threadType: 'user', unreadCount: { gt: 0 } } }),
          prisma.appointment.count({
            where: { orgId, appointmentDate: { gte: today, lt: tomorrow }, status: 'scheduled' },
          }),
          // Bỏ khách đã gộp (mergedInto) — khớp số trang Khách hàng.
          prisma.contact.count({ where: { orgId, mergedInto: null, createdAt: { gte: weekAgo } } }),
          prisma.contact.count({ where: { orgId, mergedInto: null } }),
        ]);

      return {
        messagesToday,
        messagesUnreplied: unreplied,
        messagesUnread: unread,
        appointmentsToday: aptsToday,
        newContactsThisWeek: newContacts,
        totalContacts,
      };
    } catch (err) {
      logger.error('[dashboard] KPI error:', err);
      return reply.status(500).send({ error: 'Failed to fetch KPI data' });
    }
  });

  // GET /api/v1/dashboard/message-volume?from=&to=
  app.get('/api/v1/dashboard/message-volume', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { orgId } = request.user!;
      const query = request.query as QueryParams;
      const from =
        query.from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
      const to = query.to || new Date().toISOString().split('T')[0];

      const rows = await prisma.$queryRaw<
        Array<{ date: Date; sent: bigint; received: bigint }>
      >`
        SELECT
          DATE(m.sent_at + interval '7 hours') AS date, -- sent_at lưu giờ UTC → gom theo ngày VN
          COUNT(*) FILTER (WHERE m.sender_type = 'self') AS sent,
          COUNT(*) FILTER (WHERE m.sender_type = 'contact') AS received
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.org_id = ${orgId}
          AND m.sent_at >= (${from}::date - interval '7 hours')
          AND m.sent_at < (${to}::date + interval '1 day' - interval '7 hours')
        GROUP BY DATE(m.sent_at + interval '7 hours')
        ORDER BY date ASC
      `;

      const data = rows.map((r) => ({
        date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date),
        sent: Number(r.sent),
        received: Number(r.received),
      }));

      return { data };
    } catch (err) {
      logger.error('[dashboard] Message volume error:', err);
      return reply.status(500).send({ error: 'Failed to fetch message volume' });
    }
  });

  // GET /api/v1/dashboard/pipeline — grouped by generic contact status
  app.get('/api/v1/dashboard/pipeline', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { orgId } = request.user!;
      const pipeline = await prisma.contact.groupBy({
        by: ['status'],
        where: { orgId, status: { not: null } },
        _count: true,
      });
      return { data: pipeline.map((p) => ({ status: p.status, count: p._count })) };
    } catch (err) {
      logger.error('[dashboard] Pipeline error:', err);
      return reply.status(500).send({ error: 'Failed to fetch pipeline data' });
    }
  });

  // GET /api/v1/dashboard/sources
  app.get('/api/v1/dashboard/sources', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { orgId } = request.user!;
      const sources = await prisma.contact.groupBy({
        by: ['source'],
        where: { orgId, source: { not: null } },
        _count: true,
      });
      return { data: sources.map((s) => ({ source: s.source, count: s._count })) };
    } catch (err) {
      logger.error('[dashboard] Sources error:', err);
      return reply.status(500).send({ error: 'Failed to fetch source data' });
    }
  });

  // GET /api/v1/dashboard/appointments?from=&to=
  app.get('/api/v1/dashboard/appointments', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { orgId } = request.user!;
      const query = request.query as QueryParams;
      const where: Record<string, any> = { orgId };
      if (query.from || query.to) {
        where.appointmentDate = {};
        if (query.from) where.appointmentDate.gte = new Date(query.from);
        if (query.to) where.appointmentDate.lte = new Date(query.to);
      }

      const stats = await prisma.appointment.groupBy({
        by: ['status'],
        where,
        _count: true,
      });

      return { data: stats.map((s) => ({ status: s.status, count: s._count })) };
    } catch (err) {
      logger.error('[dashboard] Appointments error:', err);
      return reply.status(500).send({ error: 'Failed to fetch appointment stats' });
    }
  });
}

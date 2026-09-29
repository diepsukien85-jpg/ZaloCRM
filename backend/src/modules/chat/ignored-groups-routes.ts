/**
 * ignored-groups-routes.ts — cấu hình nhóm Zalo bị bỏ qua (nhóm đăng bài).
 *
 * Endpoints:
 *   GET    /api/v1/ignored-groups                 — danh sách nhóm đang bỏ qua
 *   GET    /api/v1/ignored-groups/candidates?q=   — nhóm đang có trong CRM + số tin 7 ngày
 *   POST   /api/v1/ignored-groups                 — { groupThreadIds: string[] } thêm (admin)
 *   DELETE /api/v1/ignored-groups/:groupThreadId  — bỏ khỏi danh sách (admin)
 *
 * Bỏ qua = không lưu tin mới của nhóm (xem ignored-groups-service.ts). Tin cũ đã
 * lưu giữ nguyên; hội thoại nhóm được đặt về "đã đọc / đã trả lời" để không còn
 * nằm trong bộ đếm Chưa đọc / Chưa rep.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { refreshIgnoredGroups } from './ignored-groups-service.js';

const MAX_PER_REQUEST = 500;

export async function ignoredGroupsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  app.get('/api/v1/ignored-groups', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const rows = await prisma.ignoredGroup.findMany({
        where: { orgId: request.user!.orgId },
        orderBy: { createdAt: 'desc' },
      });
      return { groups: rows };
    } catch (err) {
      logger.error('[ignored-groups] list error:', err);
      return reply.status(500).send({ error: 'Không tải được danh sách nhóm bỏ qua' });
    }
  });

  app.get('/api/v1/ignored-groups/candidates', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { q = '' } = request.query as { q?: string };
      const orgId = request.user!.orgId;
      const like = `%${q.trim()}%`;
      // Gom theo group id Zalo (1 nhóm có thể nằm trong nhiều nick). Số tin 7 ngày
      // giúp chọn đúng nhóm đăng bài "ồn" nhất.
      const rows = await prisma.$queryRaw<Array<{
        group_thread_id: string; group_name: string | null; group_avatar_url: string | null;
        nick_count: bigint; msgs_7d: bigint; last_message_at: Date | null;
      }>>`
        SELECT c.external_thread_id AS group_thread_id,
               MAX(c.group_name) AS group_name,
               MAX(c.group_avatar_url) AS group_avatar_url,
               COUNT(DISTINCT c.id) AS nick_count,
               COUNT(m.id) AS msgs_7d,
               MAX(c.last_message_at) AS last_message_at
        FROM conversations c
        LEFT JOIN messages m ON m.conversation_id = c.id AND m.sent_at > NOW() - INTERVAL '7 days'
        WHERE c.org_id = ${orgId} AND c."threadType" = 'group' AND c.external_thread_id IS NOT NULL
          AND (${q.trim()} = '' OR c.group_name ILIKE ${like})
        GROUP BY c.external_thread_id
        ORDER BY msgs_7d DESC, last_message_at DESC NULLS LAST
        LIMIT 300`;
      return {
        groups: rows.map((r) => ({
          groupThreadId: r.group_thread_id,
          groupName: r.group_name,
          groupAvatarUrl: r.group_avatar_url,
          nickCount: Number(r.nick_count),
          messages7d: Number(r.msgs_7d),
          lastMessageAt: r.last_message_at,
        })),
      };
    } catch (err) {
      logger.error('[ignored-groups] candidates error:', err);
      return reply.status(500).send({ error: 'Không tải được danh sách nhóm' });
    }
  });

  app.post('/api/v1/ignored-groups', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.user!;
      const body = (request.body ?? {}) as { groupThreadIds?: unknown };
      const ids = Array.isArray(body.groupThreadIds)
        ? [...new Set(body.groupThreadIds.filter((v): v is string => typeof v === 'string' && /^\d{3,30}$/.test(v)))]
        : [];
      if (ids.length === 0) return reply.status(400).send({ error: 'Chưa chọn nhóm nào' });
      if (ids.length > MAX_PER_REQUEST) return reply.status(400).send({ error: `Tối đa ${MAX_PER_REQUEST} nhóm mỗi lần` });

      const names = await prisma.conversation.findMany({
        where: { orgId: user.orgId, threadType: 'group', externalThreadId: { in: ids } },
        select: { externalThreadId: true, groupName: true },
      });
      const nameOf = new Map(names.map((n) => [n.externalThreadId!, n.groupName]));

      const created = await prisma.ignoredGroup.createMany({
        data: ids.map((id) => ({
          id: randomUUID(),
          orgId: user.orgId,
          groupThreadId: id,
          groupName: nameOf.get(id) ?? null,
          createdById: user.id,
        })),
        skipDuplicates: true,
      });
      // Không còn tin mới về → dọn bộ đếm Chưa đọc / Chưa rep của các nhóm này.
      await prisma.conversation.updateMany({
        where: { orgId: user.orgId, threadType: 'group', externalThreadId: { in: ids } },
        data: { unreadCount: 0, isReplied: true },
      });
      await refreshIgnoredGroups();
      logger.info(`[ignored-groups] ${user.id} thêm ${created.count} nhóm bỏ qua`);
      return { added: created.count };
    } catch (err) {
      logger.error('[ignored-groups] add error:', err);
      return reply.status(500).send({ error: 'Không thêm được nhóm bỏ qua' });
    }
  });

  app.delete('/api/v1/ignored-groups/:groupThreadId', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { groupThreadId } = request.params as { groupThreadId: string };
      const res = await prisma.ignoredGroup.deleteMany({ where: { orgId: request.user!.orgId, groupThreadId } });
      await refreshIgnoredGroups();
      return { removed: res.count };
    } catch (err) {
      logger.error('[ignored-groups] remove error:', err);
      return reply.status(500).send({ error: 'Không bỏ được nhóm khỏi danh sách' });
    }
  });
}

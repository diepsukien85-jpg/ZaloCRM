/**
 * routes.ts — API cho AI tự trả lời theo thẻ phân loại.
 *
 *   GET    /api/v1/ai/auto-reply/config            — cấu hình + thống kê hôm nay
 *   PUT    /api/v1/ai/auto-reply/config            — lưu cấu hình (admin)
 *   GET    /api/v1/ai/auto-reply/tags              — thẻ có thể chọn làm thẻ kích hoạt
 *   GET    /api/v1/ai/auto-reply/playbook          — kho kịch bản
 *   POST   /api/v1/ai/auto-reply/playbook          — thêm mục (admin)
 *   PUT    /api/v1/ai/auto-reply/playbook/:id      — sửa mục (admin)
 *   DELETE /api/v1/ai/auto-reply/playbook/:id      — xoá mục (admin)
 *   GET    /api/v1/ai/auto-reply/logs              — nhật ký gần đây
 *   POST   /api/v1/ai/auto-reply/test/:conversationId — chạy thử 1 hội thoại, KHÔNG gửi (admin)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import { authMiddleware } from '../../auth/auth-middleware.js';
import { requireRole } from '../../auth/role-middleware.js';
import { orgDayRange } from '../daily-brief-service.js';
import {
  getAutoReplyConfig, updateAutoReplyConfig, validateConfigInput, validatePlaybookInput,
  type AutoReplyConfig, type PlaybookInput,
} from './config-service.js';
import { evaluateConversation } from './auto-reply-service.js';

const ADMIN = { preHandler: requireRole('owner', 'admin') };

export async function aiAutoReplyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  app.get('/api/v1/ai/auto-reply/config', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = request.user!.orgId;
      const [config, org] = await Promise.all([
        getAutoReplyConfig(orgId, { fresh: true }),
        prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } }),
      ]);
      const { start } = orgDayRange(new Date(), org?.timezone);
      const grouped = await prisma.aiAutoReplyLog.groupBy({
        by: ['decision'],
        where: { orgId, createdAt: { gte: start } },
        _count: { _all: true },
      });
      const today = Object.fromEntries(grouped.map((g) => [g.decision, g._count._all]));
      return { config, today };
    } catch (err) {
      logger.error('[ai-auto-reply] get config error:', err);
      return reply.status(500).send({ error: 'Không tải được cấu hình' });
    }
  });

  app.put('/api/v1/ai/auto-reply/config', ADMIN, async (request: FastifyRequest, reply: FastifyReply) => {
    const input = (request.body ?? {}) as Partial<AutoReplyConfig>;
    const invalid = validateConfigInput(input);
    if (invalid) return reply.status(400).send({ error: invalid });
    try {
      return { config: await updateAutoReplyConfig(request.user!.orgId, input) };
    } catch (err) {
      logger.error('[ai-auto-reply] update config error:', err);
      return reply.status(500).send({ error: 'Không lưu được cấu hình' });
    }
  });

  app.get('/api/v1/ai/auto-reply/tags', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const tags = await prisma.crmTag.findMany({
        where: { orgId: request.user!.orgId, archivedAt: null, isActive: true },
        orderBy: [{ managedBy: 'asc' }, { order: 'asc' }, { name: 'asc' }],
        select: { name: true, color: true, emoji: true, managedBy: true, category: true },
      });
      return { tags };
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
    const entry = await prisma.aiPlaybookEntry.create({
      data: {
        orgId: request.user!.orgId,
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
    const entry = await prisma.aiPlaybookEntry.update({
      where: { id },
      data: {
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
    const { limit = '50', decision } = request.query as { limit?: string; decision?: string };
    const orgId = request.user!.orgId;
    const logs = await prisma.aiAutoReplyLog.findMany({
      where: { orgId, ...(decision ? { decision } : {}) },
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

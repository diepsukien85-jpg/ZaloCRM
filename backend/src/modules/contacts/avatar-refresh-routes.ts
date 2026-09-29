/**
 * avatar-refresh-routes.ts — POST /api/v1/avatars/refresh
 * Body: { conversationIds: string[] } (≤ 100) → { avatars: { [conversationId]: url } }
 * FE gọi cho các hội thoại đang hiển thị có avatar trống/hết hạn (xem avatar-refresh-service.ts).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { refreshConversationAvatars } from './avatar-refresh-service.js';

const MAX_IDS = 100;

export async function avatarRefreshRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  app.post('/api/v1/avatars/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = (request.body ?? {}) as { conversationIds?: unknown };
      const ids = Array.isArray(body.conversationIds)
        ? [...new Set(body.conversationIds.filter((v): v is string => typeof v === 'string'))].slice(0, MAX_IDS)
        : [];
      const avatars = await refreshConversationAvatars(request.user!.orgId, ids);
      return { avatars };
    } catch (err) {
      logger.error('[avatar-refresh] error:', err);
      return reply.status(500).send({ error: 'Không làm mới được avatar' });
    }
  });
}

/**
 * group-routes.ts — Group info, CRUD, and membership management.
 * Routes: /api/v1/zalo-accounts/:accountId/groups
 */
import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { zaloOps } from '../../shared/zalo-operations.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { resolveAccount, checkAccess, handleError } from './zalo-route-helpers.js';

export async function groupRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  const BASE = '/api/v1/zalo-accounts/:accountId/groups';

  // ── Group Info ──────────────────────────────────────────────────────────────

  app.get<{ Params: { accountId: string } }>(BASE, async (request, reply) => {
    const { accountId } = request.params;
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'read'))) return;
      // SDK getAllGroups trả { version, gridVerMap: { <groupId>: ver } } — không có tên. Trả MẢNG cho trang
      // Nhóm Zalo: id từ Zalo + tên / số thành viên / ảnh từ hội thoại nhóm đã lưu (trước đây trang luôn trống).
      const raw = await zaloOps.getAllGroups(accountId) as { gridVerMap?: Record<string, unknown> } | null;
      const ids = Object.keys(raw?.gridVerMap ?? {});
      const convs = ids.length
        ? await prisma.conversation.findMany({
            where: { zaloAccountId: accountId, threadType: 'group', externalThreadId: { in: ids } },
            select: { id: true, externalThreadId: true, groupName: true, groupMembersCount: true, groupAvatarUrl: true, lastMessageAt: true },
          })
        : [];
      const byId = new Map(convs.map((c) => [c.externalThreadId, c]));
      const groups = ids.map((id) => {
        const c = byId.get(id);
        return {
          id, groupId: id, name: c?.groupName ?? null, totalMember: c?.groupMembersCount ?? null,
          avt: c?.groupAvatarUrl ?? null, conversationId: c?.id ?? null, lastMessageAt: c?.lastMessageAt ?? null,
        };
      }).sort((x, y) => (y.lastMessageAt?.getTime() ?? 0) - (x.lastMessageAt?.getTime() ?? 0));
      return { groups };
    } catch (err) { return handleError(reply, err, 'getAllGroups'); }
  });

  app.get<{ Params: { accountId: string; groupId: string } }>(`${BASE}/:groupId`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'read'))) return;
      return { group: await zaloOps.getGroupInfo(accountId, groupId) };
    } catch (err) { return handleError(reply, err, 'getGroupInfo'); }
  });

  app.get<{ Params: { accountId: string; groupId: string } }>(`${BASE}/:groupId/members`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'read'))) return;
      return { members: await zaloOps.getGroupMembersInfo(accountId, groupId) };
    } catch (err) { return handleError(reply, err, 'getGroupMembersInfo'); }
  });

  // ── Group CRUD ──────────────────────────────────────────────────────────────

  app.post<{ Params: { accountId: string }; Body: { name: string; memberIds: string[] } }>(BASE, async (request, reply) => {
    const { accountId } = request.params;
    const { name, memberIds } = request.body ?? {};
    if (!name || !Array.isArray(memberIds) || memberIds.length === 0) {
      return reply.status(400).send({ error: 'name and memberIds are required' });
    }
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return reply.status(201).send({ group: await zaloOps.createGroup(accountId, { name, memberIds }) });
    } catch (err) { return handleError(reply, err, 'createGroup'); }
  });

  app.patch<{ Params: { accountId: string; groupId: string }; Body: { name: string } }>(`${BASE}/:groupId/name`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    const { name } = request.body ?? {};
    if (!name) return reply.status(400).send({ error: 'name is required' });
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return { result: await zaloOps.renameGroup(accountId, name, groupId) };
    } catch (err) { return handleError(reply, err, 'renameGroup'); }
  });

  app.patch<{ Params: { accountId: string; groupId: string }; Body: Record<string, unknown> }>(`${BASE}/:groupId/settings`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return { result: await zaloOps.updateGroupSettings(accountId, request.body ?? {}, groupId) };
    } catch (err) { return handleError(reply, err, 'updateGroupSettings'); }
  });

  // ── Membership ──────────────────────────────────────────────────────────────

  app.post<{ Params: { accountId: string; groupId: string }; Body: { userIds: string[] } }>(`${BASE}/:groupId/members`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    const { userIds } = request.body ?? {};
    if (!Array.isArray(userIds) || userIds.length === 0) return reply.status(400).send({ error: 'userIds array is required' });
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return { result: await zaloOps.addUserToGroup(accountId, userIds, groupId) };
    } catch (err) { return handleError(reply, err, 'addUserToGroup'); }
  });

  app.delete<{ Params: { accountId: string; groupId: string }; Body: { userIds: string[] } }>(`${BASE}/:groupId/members`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    const { userIds } = request.body ?? {};
    if (!Array.isArray(userIds) || userIds.length === 0) return reply.status(400).send({ error: 'userIds array is required' });
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return { result: await zaloOps.removeUserFromGroup(accountId, userIds, groupId) };
    } catch (err) { return handleError(reply, err, 'removeUserFromGroup'); }
  });

  app.post<{ Params: { accountId: string; groupId: string }; Body: { userId: string } }>(`${BASE}/:groupId/deputies`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    const { userId } = request.body ?? {};
    if (!userId) return reply.status(400).send({ error: 'userId is required' });
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return { result: await zaloOps.addGroupDeputy(accountId, userId, groupId) };
    } catch (err) { return handleError(reply, err, 'addGroupDeputy'); }
  });

  app.delete<{ Params: { accountId: string; groupId: string; userId: string } }>(`${BASE}/:groupId/deputies/:userId`, async (request, reply) => {
    const { accountId, groupId, userId } = request.params;
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return { result: await zaloOps.removeGroupDeputy(accountId, userId, groupId) };
    } catch (err) { return handleError(reply, err, 'removeGroupDeputy'); }
  });

  app.post<{ Params: { accountId: string; groupId: string }; Body: { newOwnerId: string } }>(`${BASE}/:groupId/transfer`, async (request, reply) => {
    const { accountId, groupId } = request.params;
    const { newOwnerId } = request.body ?? {};
    if (!newOwnerId) return reply.status(400).send({ error: 'newOwnerId is required' });
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'admin'))) return;
      return { result: await zaloOps.changeGroupOwner(accountId, newOwnerId, groupId) };
    } catch (err) { return handleError(reply, err, 'changeGroupOwner'); }
  });
}

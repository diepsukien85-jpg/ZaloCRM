/**
 * ignored-groups-avatar.test.ts — nhóm bỏ qua (không lưu tin, đếm echo ảnh trong
 * bộ nhớ) + làm mới avatar Zalo hết hạn.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = {
  ignoredGroup: { findMany: vi.fn().mockResolvedValue([]) },
  zaloAccount: { findUnique: vi.fn() },
  conversation: { findMany: vi.fn() },
  friend: { findMany: vi.fn(), updateMany: vi.fn() },
  contact: { update: vi.fn() },
};
const exec = vi.fn();
let connected = true;

vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/shared/zalo-operations.js', () => ({ zaloOps: { exec } }));
vi.mock('../src/modules/zalo/zalo-pool.js', () => ({
  zaloPool: { getInstance: () => (connected ? { status: 'connected' } : undefined) },
}));

const svc = await import('../src/modules/chat/ignored-groups-service.js');
const avatar = await import('../src/modules/contacts/avatar-refresh-service.js');

beforeEach(() => {
  vi.clearAllMocks();
  svc._resetIgnoredGroupsForTest([{ orgId: 'org-1', groupThreadId: 'g-post' }]);
  avatar._resetAvatarRefreshCooldown();
  connected = true;
});

describe('ignored groups', () => {
  it('nhận diện nhóm bỏ qua theo org; orgId null khớp mọi org', () => {
    expect(svc.isGroupIgnored('org-1', 'g-post')).toBe(true);
    expect(svc.isGroupIgnored('org-2', 'g-post')).toBe(false);
    expect(svc.isGroupIgnored(null, 'g-post')).toBe(true);
    expect(svc.isGroupIgnored('org-1', 'g-khac')).toBe(false);
  });

  it('đếm echo ảnh self trong bộ nhớ kể từ mốc — cho retry gửi ảnh an toàn', () => {
    const t0 = Date.now();
    svc.recordIgnoredSelfEcho('za-1', 'g-post', 'image', t0 - 5000);
    svc.recordIgnoredSelfEcho('za-1', 'g-post', 'image', t0 + 100);
    svc.recordIgnoredSelfEcho('za-1', 'g-post', 'image', t0 + 200);
    svc.recordIgnoredSelfEcho('za-1', 'g-post', 'text', t0 + 300); // text không đếm
    svc.recordIgnoredSelfEcho('za-2', 'g-post', 'image', t0 + 300); // nick khác
    expect(svc.countIgnoredSelfImageEchoes('za-1', 'g-post', new Date(t0))).toBe(2);
    expect(svc.countIgnoredSelfImageEchoes('za-1', 'g-khac', new Date(t0))).toBe(0);
  });
});

describe('handleIncomingMessage với nhóm bỏ qua', () => {
  it('không lưu tin, echo ảnh self được đếm', async () => {
    prismaMock.zaloAccount.findUnique.mockResolvedValue({ orgId: 'org-1', ownerUserId: 'u' });
    const { handleIncomingMessage } = await import('../src/modules/chat/message-handler.js');
    const base = {
      accountId: 'za-1', senderUid: 's', senderName: 'x', content: '', msgId: '1',
      threadId: 'g-post', threadType: 'group' as const,
    };
    const ts = Date.now();
    expect(await handleIncomingMessage({ ...base, contentType: 'text', isSelf: false, timestamp: ts })).toBeNull();
    expect(await handleIncomingMessage({ ...base, contentType: 'image', isSelf: true, timestamp: ts })).toBeNull();
    expect(svc.countIgnoredSelfImageEchoes('za-1', 'g-post', new Date(ts - 1))).toBe(1);
  });
});

describe('avatar refresh', () => {
  const future = Math.floor(Date.now() / 1000) + 30 * 86400;
  const past = Math.floor(Date.now() / 1000) - 86400;
  const url = (t: number) => `https://s120-ava-talk.zadn.vn/a.jpg?key=k&time=${t}`;

  it('isAvatarStale theo tham số time=', () => {
    expect(avatar.isAvatarStale(url(past))).toBe(true);
    expect(avatar.isAvatarStale(url(future))).toBe(false);
    expect(avatar.isAvatarStale(null)).toBe(true);
    expect(avatar.isAvatarStale('https://s160-ava-talk.zadn.vn/default')).toBe(false);
  });

  it('dùng avatar per-nick còn hạn nếu có, còn lại gọi getUserInfo theo lô', async () => {
    prismaMock.conversation.findMany.mockResolvedValue([
      { id: 'cv1', zaloAccountId: 'za', externalThreadId: 'u1', contactId: 'c1', contact: { avatarUrl: url(past) } },
      { id: 'cv2', zaloAccountId: 'za', externalThreadId: 'u2', contactId: 'c2', contact: { avatarUrl: url(past) } },
      { id: 'cv3', zaloAccountId: 'za', externalThreadId: 'u3', contactId: 'c3', contact: { avatarUrl: url(future) } },
    ]);
    prismaMock.friend.findMany.mockResolvedValue([{ zaloAccountId: 'za', zaloUidInNick: 'u1', zaloAvatarUrl: url(future) }]);
    prismaMock.contact.update.mockResolvedValue({});
    prismaMock.friend.updateMany.mockResolvedValue({});
    exec.mockImplementation(async (_o: unknown, fn: (api: any) => unknown) =>
      fn({ getUserInfo: async (uids: string[]) => ({ changed_profiles: Object.fromEntries(uids.map((u) => [`${u}_0`, { avatar: `https://new/${u}.jpg` }])) }) }));

    const res = await avatar.refreshConversationAvatars('org-1', ['cv1', 'cv2', 'cv3']);
    expect(res).toEqual({ cv1: url(future), cv2: 'https://new/u2.jpg' });
    expect(exec).toHaveBeenCalledTimes(1); // chỉ u2 cần hỏi Zalo

    // Lần 2 trong cooldown → không hỏi lại Zalo
    exec.mockClear();
    await avatar.refreshConversationAvatars('org-1', ['cv2']);
    expect(exec).not.toHaveBeenCalled();
  });
});

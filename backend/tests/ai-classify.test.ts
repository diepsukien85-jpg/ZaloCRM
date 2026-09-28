/**
 * ai-classify.test.ts — AI tự phân loại người nhắn: Khách Hàng / Nhân Viên / Người Thân.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock: any = {
  aiContactClass: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  message: { findMany: vi.fn(), findFirst: vi.fn() },
  conversation: { findFirst: vi.fn() },
  organization: { findUnique: vi.fn() },
  zaloLabel: { findMany: vi.fn() },
};
const aiMock = { getAiConfig: vi.fn(), getProviderApiKey: vi.fn(), generateText: vi.fn() };
const zaloApi: any = { getLabels: vi.fn(), updateLabels: vi.fn() };
const profileMock = vi.fn();
vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/modules/ai/ai-service.js', () => aiMock);
vi.mock('../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: { getInstance: () => ({ status: 'connected' }), getIO: () => null, getApi: () => zaloApi } }));
vi.mock('../src/shared/zalo-operations.js', () => ({ zaloOps: { exec: (_o: unknown, fn: (api: unknown) => unknown) => fn(zaloApi) } }));
vi.mock('../src/modules/zalo/zalo-labels-routes.js', () => ({ syncLabelsForAccount: vi.fn().mockResolvedValue({}) }));
vi.mock('../src/modules/ai/auto-reply/config-service.js', async (orig) => ({ ...(await orig<any>()), getProfile: profileMock }));

const C = await import('../src/modules/ai/auto-reply/contact-classifier.js');
const F = await import('../src/modules/ai/auto-reply/classify-flow.js');
const { defaultProfile } = await import('../src/modules/ai/auto-reply/config-service.js');
const { formatHandoff } = await import('../src/modules/ai/auto-reply/handoff-notify.js');

const cfg = { ...defaultProfile('za'), enabled: true, mode: 'auto' as const, classifyContacts: true, ownerTitle: 'anh Mẫn',
  labelGroups: { 'Đơn ngày mai': 'customer' as const, 'Nguồn Hàng': 'ignore' as const }, triggerTags: ['🔵 Bot AI'], hourStart: 0, hourEnd: 24 };
const conv = { id: 'c1', zaloAccountId: 'za', externalThreadId: 'uid1', contactId: 'ct1' };
const NICK = ['Khách Hàng', 'Nhân Viên', 'Người Thân', 'Nguồn Hàng', 'Đơn ngày mai'];
const base = { orgId: 'o', conv, cfg, nickLabelNames: NICK, crmTags: [] as string[], pendingText: 'alo', lastPendingAt: new Date('2026-09-28T03:00:00Z'), displayName: 'Lan' };

function labelData(assign: Record<string, string[]> = {}) {
  return { version: 7, labelData: NICK.map((t, i) => ({ id: i + 1, text: t, conversations: assign[t] ?? [] })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  C._clearLabelCache();
  aiMock.getAiConfig.mockResolvedValue({ enabled: true, provider: 'gemini', model: 'm' });
  aiMock.getProviderApiKey.mockResolvedValue('k');
  prismaMock.aiContactClass.findUnique.mockResolvedValue(null);
  for (const k of ['create', 'update', 'upsert', 'delete']) prismaMock.aiContactClass[k].mockResolvedValue({});
  prismaMock.message.findMany.mockResolvedValue([]);
  prismaMock.message.findFirst.mockResolvedValue(null);
  zaloApi.getLabels.mockResolvedValue(labelData());
  zaloApi.updateLabels.mockImplementation(async (x: any) => ({ labelData: x.labelData, version: 8 }));
});

describe('hàm thuần', () => {
  it('nhận 3 thẻ chính (bỏ dấu, emoji), báo thẻ thiếu', () => {
    expect(C.coreGroupOfLabel('🔵 khách hàng')).toBe('customer');
    expect(C.coreGroupOfLabel('NHÂN VIÊN')).toBe('staff');
    expect(C.coreGroupOfLabel('Người Thân')).toBe('family');
    expect(C.coreGroupOfLabel('Nguồn Hàng')).toBeNull();
    expect(C.missingCoreLabels(['đã gửi đơn', 'Khách Hàng'])).toEqual(['Người Thân']); // Nhân Viên anh tự gắn, không bắt buộc
    expect(C.missingCoreLabels(['Khách Hàng', 'Người Thân'])).toEqual([]);
  });

  it('groupOfTags: thẻ chính / thẻ đã xếp nhóm / thẻ kích hoạt / thẻ Zalo chưa xếp = bỏ qua / Tag CRM lạ không tính', () => {
    expect(C.groupOfTags(['Khách Hàng'], [], cfg)).toEqual({ group: 'customer', tag: 'Khách Hàng' });
    expect(C.groupOfTags(['Đơn ngày mai'], [], cfg)?.group).toBe('customer');
    expect(C.groupOfTags(['Bot AI'], [], cfg)?.group).toBe('customer');
    expect(C.groupOfTags(['Minh Trí'], [], cfg)?.group).toBe('ignore');
    expect(C.groupOfTags([], ['VIP'], cfg)).toBeNull();
    expect(C.groupOfTags(['Khách Hàng'], ['Nhân Viên'], cfg)?.group).toBe('staff'); // nhân viên ưu tiên
  });

  it('câu hỏi danh tính gọi đúng giới tính Zalo', () => {
    const q = C.buildAskQuestion(null, { gender: 'female', ownerTitle: 'anh Mẫn', selfPronoun: 'em' });
    expect(q).toContain('Dạ em chào chị ạ');
    expect(q).toContain('Chị là khách hàng hay người thân của anh Mẫn');
    expect(C.buildAskQuestion(null, { gender: 'male', ownerTitle: 'anh Mẫn', selfPronoun: 'em' })).toContain('Anh là khách hàng');
    expect(C.buildAskQuestion('{Ban} ơi, {toi} hỏi xíu', { gender: null, ownerTitle: null, selfPronoun: 'em' })).toBe('Anh/chị ơi, em hỏi xíu');
  });

  it('đọc câu trả lời ngắn bằng từ khoá', () => {
    expect(C.groupFromAnswer('Khách hàng ạ')).toBe('customer');
    expect(C.groupFromAnswer('em là nhân viên kho')).toBe('staff');
    expect(C.groupFromAnswer('người nhà nè')).toBe('family');
    expect(C.groupFromAnswer('không phải khách')).toBeNull();
    expect(C.groupFromAnswer('ừ')).toBeNull();
  });

  it('Telegram báo nhân viên cần anh', () => {
    const t = formatHandoff({ conversationId: 'c1', nickName: 'Minh Mẫn', customerName: 'Tí', urgent: true, reason: 'xin nghỉ mai', customerText: 'anh ơi mai em nghỉ', botReply: '🤖 anh bận', kind: 'staff' }, 'https://crm');
    expect(t).toContain('NHÂN VIÊN CẦN ANH MẪN');
    expect(t).toContain('Việc cần anh: xin nghỉ mai');
  });
});

describe('resolveAudience', () => {
  it('đã có thẻ Khách Hàng → AI tư vấn; Người Thân / thẻ chưa xếp → im, không gọi AI', async () => {
    expect(await F.resolveAudience({ ...base, zaloLabels: ['Khách Hàng'] })).toMatchObject({ kind: 'reply', audience: 'customer' });
    expect(await F.resolveAudience({ ...base, zaloLabels: ['Người Thân'] })).toMatchObject({ kind: 'stop' });
    expect(await F.resolveAudience({ ...base, zaloLabels: ['Nguồn Hàng'] })).toMatchObject({ kind: 'stop' });
    expect(aiMock.generateText).not.toHaveBeenCalled();
  });

  it('nick thiếu 3 thẻ → không phân loại', async () => {
    const r = await F.resolveAudience({ ...base, zaloLabels: [], nickLabelNames: ['đã gửi đơn'] });
    expect(r).toMatchObject({ kind: 'stop' });
    expect((r as any).reason).toContain('Khách Hàng');
  });

  it('chưa có thẻ, AI chắc là khách → gắn thẻ Khách Hàng trên Zalo + tư vấn', async () => {
    aiMock.generateText.mockResolvedValue('{"group":"customer","confidence":0.98,"reason":"hỏi giá"}');
    const r = await F.resolveAudience({ ...base, zaloLabels: [], pendingText: 'nồi chiên giá sỉ bao nhiêu' });
    expect(r).toMatchObject({ kind: 'reply', audience: 'customer' });
    const written = zaloApi.updateLabels.mock.calls[0][0];
    expect(written.version).toBe(7);
    expect(written.labelData.find((l: any) => l.text === 'Khách Hàng').conversations).toEqual(['uid1']);
    expect(prismaMock.aiContactClass.upsert.mock.calls[0][0].create).toMatchObject({ group: 'customer', state: 'classified', source: 'ai', labelApplied: true });
  });

  it('AI thấy giống nhân viên → KHÔNG gắn thẻ, không trả lời, báo anh tự gắn thẻ Nhân Viên', async () => {
    aiMock.generateText.mockResolvedValue('{"group":"staff","confidence":0.98,"reason":"báo ca làm"}');
    const r = await F.resolveAudience({ ...base, zaloLabels: [], pendingText: 'anh ơi ca chiều em vào trễ 15p' });
    expect(r).toMatchObject({ kind: 'stop', notify: expect.stringContaining('thẻ Nhân Viên') });
    expect(zaloApi.updateLabels).not.toHaveBeenCalled();
  });

  it('đã hỏi, người nhắn nói là nhân viên → không gắn thẻ, báo anh', async () => {
    prismaMock.aiContactClass.findUnique.mockResolvedValue({ id: 'r1', state: 'asked', group: 'unknown', labelApplied: false, updatedAt: new Date() });
    const r = await F.resolveAudience({ ...base, zaloLabels: [], pendingText: 'em là nhân viên mới' });
    expect(r).toMatchObject({ kind: 'stop', notify: expect.stringContaining('thẻ Nhân Viên') });
    expect(zaloApi.updateLabels).not.toHaveBeenCalled();
  });

  it('người đã có thẻ Nhân Viên (anh gắn) → AI trả lời kiểu nhân viên', async () => {
    expect(await F.resolveAudience({ ...base, zaloLabels: ['Nhân Viên'] })).toMatchObject({ kind: 'reply', audience: 'staff' });
  });

  it('không gắn đè: người nhắn vừa có thẻ khác trên Zalo → không đổi thẻ', async () => {
    aiMock.generateText.mockResolvedValue('{"group":"customer","confidence":0.95,"reason":"hỏi giá"}');
    zaloApi.getLabels.mockResolvedValue(labelData({ 'Nguồn Hàng': ['uid1'] }));
    const r = await F.resolveAudience({ ...base, zaloLabels: [], pendingText: 'giá nồi chiên bao nhiêu' });
    expect(r).toMatchObject({ kind: 'stop' });
    expect(zaloApi.updateLabels).not.toHaveBeenCalled();
  });

  it('chưa rõ → hẹn hỏi sau 5 phút, không gắn thẻ', async () => {
    aiMock.generateText.mockResolvedValue('{"group":"unknown","confidence":0.3,"reason":"chỉ chào"}');
    const r = await F.resolveAudience({ ...base, zaloLabels: [] });
    expect(r).toMatchObject({ kind: 'stop' });
    const data = prismaMock.aiContactClass.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ state: 'asking', group: 'unknown' });
    expect(data.askDueAt.toISOString()).toBe('2026-09-28T03:05:00.000Z');
    expect(zaloApi.updateLabels).not.toHaveBeenCalled();
  });

  it('đã hỏi, người nhắn trả lời "khách hàng ạ" → gắn thẻ Khách Hàng, trả lời luôn (không cần AI đọc câu trả lời)', async () => {
    prismaMock.aiContactClass.findUnique.mockResolvedValue({ id: 'r1', state: 'asked', group: 'unknown', labelApplied: false, updatedAt: new Date() });
    prismaMock.message.findFirst.mockResolvedValue({ content: 'Chị là khách hàng, nhân viên hay người thân…' });
    const r = await F.resolveAudience({ ...base, zaloLabels: [], pendingText: 'khách hàng ạ' });
    expect(r).toMatchObject({ kind: 'reply', audience: 'customer', justAnswered: true });
    expect(aiMock.generateText).not.toHaveBeenCalled();
    expect(zaloApi.updateLabels.mock.calls[0][0].labelData.find((l: any) => l.text === 'Khách Hàng').conversations).toEqual(['uid1']);
  });

  it('đã hỏi, trả lời là người nhà → gắn Người Thân, nói 1 câu cảm ơn, báo anh, không tư vấn', async () => {
    prismaMock.aiContactClass.findUnique.mockResolvedValue({ id: 'r1', state: 'asked', group: 'unknown', labelApplied: false, updatedAt: new Date() });
    const r = await F.resolveAudience({ ...base, zaloLabels: [], pendingText: 'người nhà nè con' });
    expect(r).toMatchObject({ kind: 'stop', say: expect.stringContaining('báo anh Mẫn'), notify: expect.any(String) });
    expect(zaloApi.updateLabels.mock.calls[0][0].labelData.find((l: any) => l.text === 'Người Thân').conversations).toEqual(['uid1']);
  });

  it('AI từng gắn thẻ mà anh gỡ ra → tôn trọng, AI im', async () => {
    prismaMock.aiContactClass.findUnique.mockResolvedValue({ id: 'r1', state: 'classified', group: 'customer', labelApplied: true, updatedAt: new Date(Date.now() - 10 * 60_000) });
    expect(await F.resolveAudience({ ...base, zaloLabels: [] })).toMatchObject({ kind: 'stop', reason: expect.stringContaining('gỡ thẻ') });
    expect(prismaMock.aiContactClass.update.mock.calls[0][0].data).toEqual({ state: 'owner_cleared' });
  });
});

describe('vòng quét hỏi danh tính', () => {
  const deps = () => ({ send: vi.fn().mockResolvedValue(undefined), gender: vi.fn().mockResolvedValue('female'), threadLabels: vi.fn().mockResolvedValue([]), log: vi.fn().mockResolvedValue(undefined) });
  const row = { id: 'r1', orgId: 'o', zaloAccountId: 'za', conversationId: 'c1', state: 'asking', createdAt: new Date('2026-09-28T03:00:00Z') };
  beforeEach(() => {
    prismaMock.aiContactClass.findMany.mockResolvedValue([row]);
    prismaMock.conversation.findFirst.mockResolvedValue({ ...conv, orgId: 'o' });
    prismaMock.organization.findUnique.mockResolvedValue({ timezone: '+07:00' });
    prismaMock.aiContactClass.updateMany.mockResolvedValue({ count: 1 });
    profileMock.mockResolvedValue(cfg);
  });

  it('chờ đủ, anh chưa trả lời, chưa có thẻ → gửi câu hỏi gọi "chị"', async () => {
    const d = deps();
    expect(await F.processDueAsks(d, new Date('2026-09-28T03:06:00Z'))).toBe(1);
    expect(d.send.mock.calls[0][2]).toContain('Chị là khách hàng hay người thân của anh Mẫn');
    expect(prismaMock.aiContactClass.updateMany.mock.calls[0][0].data.state).toBe('asked');
  });

  it('anh đã tự trả lời trong lúc chờ → không hỏi', async () => {
    prismaMock.message.findFirst.mockResolvedValue({ id: 'm-owner' });
    const d = deps();
    expect(await F.processDueAsks(d, new Date('2026-09-28T03:06:00Z'))).toBe(0);
    expect(d.send).not.toHaveBeenCalled();
    expect(prismaMock.aiContactClass.delete).toHaveBeenCalled();
  });

  it('anh vừa gắn thẻ trong lúc chờ → không hỏi', async () => {
    const d = { ...deps(), threadLabels: vi.fn().mockResolvedValue(['Minh Trí']) };
    expect(await F.processDueAsks(d, new Date('2026-09-28T03:06:00Z'))).toBe(0);
    expect(d.send).not.toHaveBeenCalled();
  });
});

describe('ảnh AI gửi kèm không bị tính là nhân viên trả lời', () => {
  it('pickLastHumanReply bỏ ảnh đi ra ngay sau tin AI, vẫn tính tin chữ / ảnh người gửi', async () => {
    const { pickLastHumanReply } = await import('../src/modules/ai/auto-reply/auto-reply-service.js');
    const t = (s: number) => new Date(Date.UTC(2026, 8, 28, 3, 0, s));
    // mới → cũ
    expect(pickLastHumanReply([
      { sentAt: t(1), sentVia: 'user', contentType: 'image', senderType: 'self' },
      { sentAt: t(0), sentVia: 'automation', contentType: 'text', senderType: 'self' },
    ])).toBeNull();
    const human = { sentAt: t(50), sentVia: 'user', contentType: 'text', senderType: 'self' };
    expect(pickLastHumanReply([human, { sentAt: t(1), sentVia: 'user', contentType: 'image', senderType: 'self' }, { sentAt: t(0), sentVia: 'automation', contentType: 'text', senderType: 'self' }])).toBe(human);
    const lateImg = { sentAt: t(59), sentVia: 'user', contentType: 'image', senderType: 'self' };
    expect(pickLastHumanReply([lateImg, { sentAt: t(0), sentVia: 'automation', contentType: 'text', senderType: 'self' }])).toBe(lateImg);
  });
});

describe('lỗi gửi Zalo vĩnh viễn — không gửi lại', () => {
  it('nhận đúng câu lỗi tiếng Việt thật', async () => {
    const { isPermanentSendError } = await import('../src/modules/api/public-api-routes.js');
    for (const m of ['Zalo: Bạn đang bị cấm nhắn tin cho người lạ.', 'Bạn chưa thể gửi tin nhắn đến người này vì người này chặn không nhận tin nhắn từ người lạ.',
      'Vượt quá số request cho phép', 'Xin lỗi! Hiện tại tôi không muốn nhận tin nhắn.', 'Không thể nhận tin nhắn từ bạn.']) {
      expect(isPermanentSendError(new Error(m))).toBe(true);
    }
    expect(isPermanentSendError(new Error('fetch failed'))).toBe(false);
    expect(isPermanentSendError(new Error('Tham số không hợp lệ'))).toBe(false);
  });
});

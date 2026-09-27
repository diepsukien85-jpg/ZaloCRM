/**
 * ai-clone.test.ts — "Học theo nick khác": chép hướng dẫn + bài học + bộ khung từ nick mẫu,
 * chép xong là của riêng nick mới; chép lại chỉ làm mới phần đã chép.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock: any = {
  zaloAccount: { findFirst: vi.fn() },
  aiAutoReplyProfile: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  aiLesson: { findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  aiPlaybookEntry: { findMany: vi.fn(), create: vi.fn() },
};
prismaMock.$transaction = vi.fn((fn: (tx: unknown) => unknown) => fn(prismaMock));
vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/modules/ai/ai-service.js', () => ({ getAiConfig: vi.fn(), getProviderApiKey: vi.fn(), generateText: vi.fn() }));
vi.mock('../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: { getInstance: () => undefined, getIO: () => null } }));
vi.mock('../src/shared/zalo-operations.js', () => ({ zaloOps: {} }));

const C = await import('../src/modules/ai/auto-reply/clone-service.js');
const { splitLessons } = await import('../src/modules/ai/auto-reply/learning-service.js');
const { _clearAutoReplyConfigCache, defaultProfile } = await import('../src/modules/ai/auto-reply/config-service.js');

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id: `p-${id}`, orgId: 'o', zaloAccountId: id, enabled: true, mode: 'auto', triggerTags: ['🔵 Bot AI'], hourStart: 7, hourEnd: 22,
  debounceSeconds: 20, maxRepliesPerDay: 300, maxRepliesPerConvPerDay: 15, skipIfStaffRepliedWithinMin: 10, blockedKeywords: ['hoàn tiền'],
  persona: null, extraInstruction: 'SKILL Minh Mẫn', guideFileName: 'ai-chatbot.skill',
  guideFiles: [{ path: 'references/09.md', content: 'chốt đơn', mode: 'always' }], verifyGrounding: true, learningEnabled: true,
  lastLearnedAt: null, addressByGender: true, selfPronoun: 'em', useProductCatalog: true, sendProductImages: true,
  notifyHandoff: true, handoffChatId: '111', handoffPauseMinutes: 60, clonedFromAccountId: null, clonedAt: null,
  createdAt: new Date(), updatedAt: new Date(), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  _clearAutoReplyConfigCache();
  prismaMock.zaloAccount.findFirst.mockImplementation(({ where }: any) => Promise.resolve({ id: where.id, displayName: where.id === 'mm' ? 'Minh Mẫn' : 'ABC', phone: null }));
  prismaMock.aiAutoReplyProfile.findUnique.mockImplementation(({ where }: any) => Promise.resolve(
    where.zaloAccountId === 'mm' ? row('mm') : row('abc', { enabled: false, triggerTags: ['🔵 Khách mới'], extraInstruction: 'cũ', guideFileName: null, guideFiles: [], handoffChatId: '222', selfPronoun: 'mình' }),
  ));
  prismaMock.aiAutoReplyProfile.upsert.mockImplementation(({ update }: any) => Promise.resolve(row('abc', update)));
  prismaMock.aiLesson.findMany.mockImplementation(({ where }: any) => Promise.resolve(where.zaloAccountId === 'mm'
    ? [{ content: 'Hỏi số lượng trước khi báo giá sỉ', source: 'teach', evidence: [] }, { content: 'Ship HN 2-3 ngày', source: 'daily', evidence: [] }]
    : [{ content: 'Ship HN 2-3 ngày' }])); // nick mới đã tự có bài này → không chép trùng
  prismaMock.aiPlaybookEntry.findMany.mockImplementation(({ where }: any) => Promise.resolve(where.zaloAccountId === 'mm'
    ? [{ title: 'Bảng giá sỉ', category: null, keywords: ['sỉ'], content: '...', priority: 1, enabled: true }, { title: 'Phí ship', category: null, keywords: [], content: '...', priority: 0, enabled: true }]
    : [{ title: 'Phí ship' }]));
});

describe('học theo nick khác', () => {
  it('clonedSettings: chép kiến thức + cách tư vấn, giữ thẻ / bật-tắt / Telegram của nick mới', () => {
    const src = { ...defaultProfile('mm'), extraInstruction: 'SKILL', selfPronoun: 'em', triggerTags: ['A'], enabled: true, handoffChatId: '1' };
    const tgt = { ...defaultProfile('abc'), triggerTags: ['B'], enabled: false, handoffChatId: '2' };
    const s = C.clonedSettings(src, tgt);
    expect(s).toMatchObject({ extraInstruction: 'SKILL', selfPronoun: 'em', triggerTags: ['B'], enabled: false, handoffChatId: '2' });
    expect(C.clonedSettings(src, null)).toMatchObject({ triggerTags: [], enabled: false, handoffChatId: null });
  });

  it('cloneProfileFrom: chép hướng dẫn, bài học (bỏ trùng), bộ khung (bỏ trùng tiêu đề) và đánh dấu nguồn', async () => {
    const res = await C.cloneProfileFrom('o', 'abc', 'mm');
    const upd = prismaMock.aiAutoReplyProfile.upsert.mock.calls[0][0].update;
    expect(upd).toMatchObject({ extraInstruction: 'SKILL Minh Mẫn', guideFileName: 'ai-chatbot.skill', selfPronoun: 'em', triggerTags: ['🔵 Khách mới'], enabled: false, handoffChatId: '222' });
    expect(upd.guideFiles).toHaveLength(1);
    // Làm mới phần đã chép lần trước
    expect(prismaMock.aiLesson.deleteMany).toHaveBeenCalledWith({ where: { zaloAccountId: 'abc', inheritedFromAccountId: 'mm' } });
    expect(prismaMock.aiLesson.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.aiLesson.create.mock.calls[0][0].data).toMatchObject({ zaloAccountId: 'abc', content: 'Hỏi số lượng trước khi báo giá sỉ', source: 'teach', inheritedFromAccountId: 'mm' });
    expect(prismaMock.aiPlaybookEntry.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.aiPlaybookEntry.create.mock.calls[0][0].data).toMatchObject({ zaloAccountId: 'abc', title: 'Bảng giá sỉ' });
    expect(prismaMock.aiAutoReplyProfile.update.mock.calls[0][0].data.clonedFromAccountId).toBe('mm');
    expect(res).toMatchObject({ sourceName: 'Minh Mẫn', lessons: 1, playbook: 1 });
  });

  it('không học theo chính mình / nick mẫu chưa cấu hình', async () => {
    await expect(C.cloneProfileFrom('o', 'mm', 'mm')).rejects.toThrow('chính nick');
    prismaMock.aiAutoReplyProfile.findUnique.mockResolvedValue(null);
    await expect(C.cloneProfileFrom('o', 'abc', 'mm')).rejects.toThrow('chưa được cấu hình');
  });

  it('bài dạy riêng cho nick này đứng SAU bài chép từ nick mẫu (điều ghi sau thắng)', () => {
    const { owner, auto } = splitLessons([
      { content: 'Riêng: tự xưng là Lan', source: 'teach', inheritedFromAccountId: null },
      { content: 'Mẫu: xưng em, gọi khách chị', source: 'teach', inheritedFromAccountId: 'mm' },
      { content: 'tự rút', source: 'daily', inheritedFromAccountId: 'mm' },
    ]);
    expect(owner).toEqual(['Mẫu: xưng em, gọi khách chị', 'Riêng: tự xưng là Lan']);
    expect(auto).toEqual(['tự rút']);
  });
});

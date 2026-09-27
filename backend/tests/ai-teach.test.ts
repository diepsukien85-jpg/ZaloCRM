/**
 * ai-teach.test.ts — "Dạy cho AI": thao tác bài học, xem trước, lưu (gộp), ưu tiên bài chủ shop dạy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = {
  aiLesson: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  aiAutoReplyProfile: { findUnique: vi.fn() },
};
const aiServiceMock = { getAiConfig: vi.fn(), getProviderApiKey: vi.fn(), generateText: vi.fn() };
vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/modules/ai/ai-service.js', () => aiServiceMock);
vi.mock('../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: { getInstance: () => undefined, getIO: () => null } }));
vi.mock('../src/shared/zalo-operations.js', () => ({ zaloOps: {} }));

const T = await import('../src/modules/ai/auto-reply/teach-service.js');
const { buildSystemPrompt } = await import('../src/modules/ai/auto-reply/context-builder.js');
const { splitLessons } = await import('../src/modules/ai/auto-reply/learning-service.js');
const { _clearAutoReplyConfigCache } = await import('../src/modules/ai/auto-reply/config-service.js');

const EXISTING = [
  { id: 'l1', content: 'khi có người hỏi nhóm zalo phải nói rõ link của nhóm nào', source: 'manual' },
  { id: 'l2', content: 'Ship Hà Nội 2-3 ngày', source: 'daily' },
];

beforeEach(() => {
  for (const m of Object.values(prismaMock)) for (const fn of Object.values(m)) (fn as any).mockReset();
  vi.clearAllMocks();
  _clearAutoReplyConfigCache();
  prismaMock.aiLesson.findMany.mockResolvedValue(EXISTING);
  aiServiceMock.getAiConfig.mockResolvedValue({ enabled: true, provider: 'gemini', model: 'm' });
  aiServiceMock.getProviderApiKey.mockResolvedValue('k');
  prismaMock.aiAutoReplyProfile.findUnique.mockResolvedValue({
    id: 'p', orgId: 'o', zaloAccountId: 'za', enabled: true, mode: 'auto', triggerTags: [], hourStart: 0, hourEnd: 24,
    debounceSeconds: 20, maxRepliesPerDay: 1, maxRepliesPerConvPerDay: 1, skipIfStaffRepliedWithinMin: 0, blockedKeywords: [],
    persona: null, extraInstruction: 'skill', guideFileName: null, guideFiles: [], verifyGrounding: true, learningEnabled: true,
    lastLearnedAt: null, addressByGender: true, selfPronoun: 'em', useProductCatalog: false, sendProductImages: false,
    notifyHandoff: false, handoffChatId: null, handoffPauseMinutes: 60, createdAt: new Date(), updatedAt: new Date(),
  });
});

describe('thao tác bài học', () => {
  it('normalizeOps: update/remove cần id có thật; update id lạ → add; lọc SĐT', () => {
    const ids = new Set(['l1']);
    expect(T.normalizeOps([
      { op: 'update', id: 'l1', content: 'Gửi đúng 1 link nhóm mỹ phẩm' },
      { op: 'update', id: 'zzz', content: 'Hỏi số lượng trước khi báo giá sỉ' },
      { op: 'remove', id: 'nope' },
      { op: 'add', content: 'Gọi 0912 345 678 khi cần' },
      { op: 'add', content: 'x' },
    ], ids)).toEqual([
      { op: 'update', id: 'l1', content: 'Gửi đúng 1 link nhóm mỹ phẩm' },
      { op: 'add', content: 'Hỏi số lượng trước khi báo giá sỉ' },
      { op: 'add', content: 'Gọi [SĐT] khi cần' },
    ]);
  });
  it('applyOpsPreview: thêm + sửa + bỏ', () => {
    expect(T.applyOpsPreview(EXISTING, [
      { op: 'update', id: 'l1', content: 'mới' }, { op: 'remove', id: 'l2' }, { op: 'add', content: 'thêm' },
    ])).toEqual(['thêm', 'mới']);
  });
});

describe('buổi dạy', () => {
  it('teachTurn: trả lời chủ shop + đề xuất có kèm nội dung cũ', async () => {
    aiServiceMock.generateText.mockResolvedValue('{"reply":"Dạ em hiểu rồi ạ","ops":[{"op":"update","id":"l1","content":"Chỉ gửi 1 link nhóm mỹ phẩm, tối đa 2 câu"}]}');
    const r = await T.teachTurn('o', 'za', [{ role: 'owner', content: 'chỉ gửi 1 link' }], []);
    expect(r.reply).toBe('Dạ em hiểu rồi ạ');
    expect(r.preview[0]).toMatchObject({ op: 'update', id: 'l1', before: EXISTING[0].content });
  });
  it('finishTeaching: lượt gộp quyết định cuối, lưu nguồn "teach", không thêm trùng', async () => {
    aiServiceMock.generateText.mockResolvedValue('{"ops":[{"op":"update","id":"l1","content":"Chỉ gửi 1 link nhóm mỹ phẩm, tối đa 2 câu"},{"op":"add","content":"Ship Hà Nội 2-3 ngày"},{"op":"add","content":"Hỏi số lượng trước khi báo giá sỉ"}]}');
    const r = await T.finishTeaching('o', 'za', [{ role: 'owner', content: 'dạy' }], [{ op: 'add', content: 'abc abc abc' }]);
    expect(r).toMatchObject({ added: 1, updated: 1, removed: 0 });
    expect(prismaMock.aiLesson.updateMany.mock.calls[0][0].data).toEqual({ content: 'Chỉ gửi 1 link nhóm mỹ phẩm, tối đa 2 câu', source: 'teach', inheritedFromAccountId: null });
    expect(prismaMock.aiLesson.create.mock.calls[0][0].data).toMatchObject({ content: 'Hỏi số lượng trước khi báo giá sỉ', source: 'teach' });
  });
  it('finishTeaching: lượt gộp lỗi → vẫn lưu đề xuất', async () => {
    aiServiceMock.generateText.mockRejectedValue(new Error('timeout'));
    const r = await T.finishTeaching('o', 'za', [], [{ op: 'add', content: 'Luôn hỏi số lượng trước' }]);
    expect(r.added).toBe(1);
  });
});

describe('ưu tiên bài chủ shop dạy', () => {
  it('splitLessons + prompt: bài dạy nằm trong <chu_shop_day>, sau skill, có dòng tự kiểm tra', () => {
    const { owner, auto } = splitLessons(EXISTING);
    expect(owner).toEqual([EXISTING[0].content]);
    expect(auto).toEqual(['Ship Hà Nội 2-3 ngày']);
    const p = buildSystemPrompt(null, 'SKILL', auto, [], null, '', { ownerLessons: owner });
    expect(p.indexOf('<huong_dan_cua_shop>')).toBeLessThan(p.indexOf('<chu_shop_day>'));
    expect(p).toContain('ƯU TIÊN CAO HƠN HƯỚNG DẪN / SKILL');
    expect(p).toContain('<chu_shop_day> liên quan');
  });
});

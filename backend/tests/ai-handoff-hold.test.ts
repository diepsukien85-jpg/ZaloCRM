/**
 * ai-handoff-hold.test.ts — AI chuyển người thật → thẻ "Chờ người thật", trả thẻ cũ khi người thật trả lời.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock: any = {
  aiHandoffHold: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  message: { findMany: vi.fn() },
};
const zaloApi: any = { getLabels: vi.fn(), updateLabels: vi.fn() };
vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: { getInstance: () => ({ status: 'connected' }) } }));
vi.mock('../src/shared/zalo-operations.js', () => ({ zaloOps: { exec: (_o: unknown, fn: (api: unknown) => unknown) => fn(zaloApi) } }));
vi.mock('../src/modules/zalo/zalo-labels-routes.js', () => ({ syncLabelsForAccount: vi.fn().mockResolvedValue({}) }));
vi.mock('../src/modules/ai/ai-service.js', () => ({ generateText: vi.fn() }));

const H = await import('../src/modules/ai/auto-reply/handoff-hold.js');
const C = await import('../src/modules/ai/auto-reply/contact-classifier.js');
const cfg: any = { labelGroups: {}, triggerTags: [] };
const LABELS = ['Khách Hàng', 'Nhân Viên', 'Người Thân', 'Chờ người thật', 'Đơn ngày mai'];
const data = (assign: Record<string, string[]>) => ({ version: 3, labelData: LABELS.map((t, i) => ({ id: i + 1, text: t, conversations: assign[t] ?? [] })) });
const labelOf = (call: any, t: string) => call.labelData.find((l: any) => l.text === t).conversations;

beforeEach(() => {
  vi.clearAllMocks();
  zaloApi.updateLabels.mockImplementation(async (x: any) => ({ labelData: x.labelData, version: 4 }));
  prismaMock.aiHandoffHold.findFirst.mockResolvedValue(null);
  for (const k of ['create', 'update']) prismaMock.aiHandoffHold[k].mockResolvedValue({});
});

describe('thẻ Chờ người thật', () => {
  it('là thẻ chính thứ 4, đứng trên mọi nhóm; nick thiếu thẻ nào thì báo', () => {
    expect(C.coreGroupOfLabel('🔵 chờ người thật')).toBe('waiting');
    expect(C.groupOfTags(['Chờ người thật'], ['Nhân Viên'], cfg)?.group).toBe('waiting');
    expect(C.missingAllCoreLabels(['Khách Hàng', 'Người Thân'])).toEqual(['Nhân Viên', 'Chờ người thật']);
  });

  it('chuyển người → dời khỏi thẻ cũ sang "Chờ người thật", nhớ thẻ cũ', async () => {
    zaloApi.getLabels.mockResolvedValue(data({ 'Đơn ngày mai': ['u1'] }));
    expect(await H.holdForHuman({ orgId: 'o', zaloAccountId: 'za', conversationId: 'c1', threadId: 'u1', reason: 'KHẨN · khiếu nại' })).toBe(true);
    const w = zaloApi.updateLabels.mock.calls[0][0];
    expect(labelOf(w, 'Chờ người thật')).toEqual(['u1']);
    expect(labelOf(w, 'Đơn ngày mai')).toEqual([]);
    expect(prismaMock.aiHandoffHold.create.mock.calls[0][0].data).toMatchObject({ conversationId: 'c1', prevLabel: 'Đơn ngày mai' });
  });

  it('nick chưa có thẻ "Chờ người thật" → không đổi gì', async () => {
    zaloApi.getLabels.mockResolvedValue({ version: 1, labelData: [{ id: 1, text: 'Khách Hàng', conversations: ['u1'] }] });
    expect(await H.holdForHuman({ orgId: 'o', zaloAccountId: 'za', conversationId: 'c1', threadId: 'u1', reason: 'x' })).toBe(false);
    expect(zaloApi.updateLabels).not.toHaveBeenCalled();
  });

  it('người thật trả lời → trả lại thẻ cũ; AI trả lời / ảnh AI gửi kèm không tính', async () => {
    const heldAt = new Date('2026-09-28T08:00:00Z');
    const at = (s: number) => new Date(heldAt.getTime() + s * 1000);
    expect(H.humanRepliedAfter(heldAt, [{ sentAt: at(5), sentVia: 'automation', contentType: 'text' }, { sentAt: at(8), sentVia: 'user', contentType: 'image' }])).toBe(false);
    expect(H.humanRepliedAfter(heldAt, [{ sentAt: at(600), sentVia: 'user', contentType: 'text' }])).toBe(true);

    prismaMock.aiHandoffHold.findMany.mockResolvedValue([{ id: 'h1', orgId: 'o', zaloAccountId: 'za', conversationId: 'c1', threadId: 'u1', prevLabel: 'Khách Hàng', heldAt }]);
    prismaMock.message.findMany.mockResolvedValue([{ sentAt: at(600), sentVia: 'user', contentType: 'text' }]);
    zaloApi.getLabels.mockResolvedValue(data({ 'Chờ người thật': ['u1'] }));
    expect(await H.releaseHolds()).toBe(1);
    const w = zaloApi.updateLabels.mock.calls[0][0];
    expect(labelOf(w, 'Khách Hàng')).toEqual(['u1']);
    expect(labelOf(w, 'Chờ người thật')).toEqual([]);
    expect(prismaMock.aiHandoffHold.update.mock.calls[0][0].data.releaseNote).toContain('trả thẻ "Khách Hàng"');
  });

  it('anh đã tự đổi thẻ → không ghi đè, chỉ đóng phiếu', async () => {
    const heldAt = new Date('2026-09-28T08:00:00Z');
    prismaMock.aiHandoffHold.findMany.mockResolvedValue([{ id: 'h1', orgId: 'o', zaloAccountId: 'za', conversationId: 'c1', threadId: 'u1', prevLabel: 'Khách Hàng', heldAt }]);
    prismaMock.message.findMany.mockResolvedValue([{ sentAt: new Date(heldAt.getTime() + 60_000), sentVia: 'user', contentType: 'text' }]);
    zaloApi.getLabels.mockResolvedValue(data({ 'Nhân Viên': ['u1'] }));
    expect(await H.releaseHolds()).toBe(1);
    expect(zaloApi.updateLabels).not.toHaveBeenCalled();
    expect(prismaMock.aiHandoffHold.update.mock.calls[0][0].data.releaseNote).toContain('tự đổi thẻ');
  });

  it('người thật chưa trả lời → giữ nguyên thẻ Chờ người thật', async () => {
    prismaMock.aiHandoffHold.findMany.mockResolvedValue([{ id: 'h1', orgId: 'o', zaloAccountId: 'za', conversationId: 'c1', threadId: 'u1', prevLabel: 'Khách Hàng', heldAt: new Date() }]);
    prismaMock.message.findMany.mockResolvedValue([]);
    expect(await H.releaseHolds()).toBe(0);
    expect(zaloApi.getLabels).not.toHaveBeenCalled();
  });
});

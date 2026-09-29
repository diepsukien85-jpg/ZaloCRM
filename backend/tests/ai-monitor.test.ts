/**
 * ai-monitor.test.ts — Tiểu Mỹ canh gác AI trả lời Zalo: phải báo khi AI không làm việc.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock: any = {
  aiAutoReplyProfile: { findMany: vi.fn() },
  organization: { findUnique: vi.fn() },
  zaloAccount: { findMany: vi.fn() },
  aiAutoReplyLog: { findMany: vi.fn(), findFirst: vi.fn() },
  message: { findFirst: vi.fn() },
  conversation: { findMany: vi.fn(), count: vi.fn() },
};
const status = { v: 'connected' as string | undefined };
const sendTelegram = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: { getInstance: () => (status.v ? { status: status.v } : undefined) } }));
vi.mock('../src/shared/zalo-operations.js', () => ({ zaloOps: { exec: vi.fn() } }));
vi.mock('../src/modules/ai/ai-service.js', () => ({ getAiConfig: vi.fn().mockResolvedValue({ enabled: true, provider: 'gemini', model: 'm' }), getProviderApiKey: vi.fn().mockResolvedValue('k'), generateText: vi.fn() }));
vi.mock('../src/modules/ai/auto-reply/handoff-notify.js', () => ({ sendTelegram, isTelegramConfigured: () => true, defaultHandoffChatId: () => '5419371973' }));
vi.mock('../src/modules/ai/auto-reply/config-service.js', async (orig) => ({ ...(await orig<any>()), listProfiles: vi.fn() }));
vi.mock('../src/modules/ai/auto-reply/contact-classifier.js', async (orig) => ({ ...(await orig<any>()), threadZaloLabels: vi.fn().mockResolvedValue(['Khách Hàng']) }));

const M = await import('../src/modules/ai/auto-reply/ai-monitor.js');
const cfgMod: any = await import('../src/modules/ai/auto-reply/config-service.js');
const NOW = new Date('2026-09-28T07:00:00Z'); // 14:00 VN
const cfg = { ...cfgMod.defaultProfile('mm'), enabled: true, mode: 'auto', hourStart: 7, hourEnd: 22, classifyContacts: true };

beforeEach(() => {
  vi.clearAllMocks();
  M._resetMonitor();
  status.v = 'connected';
  prismaMock.aiAutoReplyProfile.findMany.mockResolvedValue([{ orgId: 'o' }]);
  prismaMock.organization.findUnique.mockResolvedValue({ timezone: '+07:00' });
  cfgMod.listProfiles.mockResolvedValue([cfg]);
  prismaMock.zaloAccount.findMany.mockResolvedValue([{ id: 'mm', orgId: 'o', displayName: 'Minh Mẫn' }]);
  prismaMock.aiAutoReplyLog.findMany.mockResolvedValue([]);
  prismaMock.aiAutoReplyLog.findFirst.mockResolvedValue(null);
  prismaMock.message.findFirst.mockResolvedValue(null);
  prismaMock.conversation.findMany.mockResolvedValue([]);
});

describe('Tiểu Mỹ canh gác', () => {
  it('nick mất kết nối → báo 1 lần, không báo trùng trong 1 giờ', async () => {
    status.v = 'disconnected';
    expect(await M.monitorTick(NOW)).toBe(1);
    expect(sendTelegram.mock.calls[0][1]).toContain('nick Minh Mẫn mất kết nối Zalo');
    expect(await M.monitorTick(new Date(NOW.getTime() + 5 * 60_000))).toBe(0);
  });

  it('có lỗi AI → báo kèm lỗi gần nhất', async () => {
    prismaMock.aiAutoReplyLog.findMany.mockResolvedValue([{ reason: 'gọi AI lỗi: 429' }]);
    await M.monitorTick(NOW);
    expect(sendTelegram.mock.calls[0][1]).toContain('gọi AI lỗi: 429');
  });

  it('Zalo có tin mới mà AI không nhận sự kiện → báo AI không nhận được tin', async () => {
    M.noteAiEvent('mm'); // sự kiện "bây giờ" (thời gian thật) — đặt tin mới hơn sự kiện
    prismaMock.message.findFirst.mockResolvedValueOnce({ sentAt: new Date(Date.now() + 10 * 60_000) });
    await M.monitorTick(new Date(Date.now() + 15 * 60_000));
    expect(sendTelegram.mock.calls.map((c) => c[1]).join('\n')).toContain('không nhận được tin mới');
  });

  it('khách chờ quá 20 phút, AI bỏ qua vì nhân viên vừa trả lời → báo kèm lý do + link', async () => {
    prismaMock.conversation.findMany.mockResolvedValue([{ id: 'c1', externalThreadId: 'u1', contact: { crmName: 'Chị Lan', fullName: null } }]);
    prismaMock.message.findFirst.mockImplementation(async (a: any) => a.where?.conversationId === 'c1'
      ? { id: 'm1', senderType: 'contact', sentAt: new Date(NOW.getTime() - 30 * 60_000), content: 'còn nồi chiên không em', contentType: 'text' }
      : null);
    prismaMock.aiAutoReplyLog.findFirst.mockResolvedValue({ audience: 'customer', decision: 'skipped', reason: 'nhân viên vừa trả lời' });
    await M.monitorTick(NOW);
    const t = sendTelegram.mock.calls[0][1];
    expect(t).toContain('Chị Lan');
    expect(t).toContain('nhân viên vừa trả lời');
    expect(t).toContain('/chat/c1');
    // Cùng tin → không báo lại
    sendTelegram.mockClear();
    await M.monitorTick(new Date(NOW.getTime() + 5 * 60_000));
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it('người thân chờ lâu (không có nhật ký, thẻ Người Thân) → KHÔNG báo', async () => {
    const cls: any = await import('../src/modules/ai/auto-reply/contact-classifier.js');
    cls.threadZaloLabels.mockResolvedValueOnce(['Người Thân']);
    prismaMock.conversation.findMany.mockResolvedValue([{ id: 'c2', externalThreadId: 'u2', contact: { crmName: 'Mẹ', fullName: null } }]);
    prismaMock.message.findFirst.mockImplementation(async (a: any) => a.where?.conversationId === 'c2'
      ? { id: 'm2', senderType: 'contact', sentAt: new Date(NOW.getTime() - 30 * 60_000), content: 'về ăn cơm', contentType: 'text' }
      : null);
    await M.monitorTick(NOW);
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it('phần AI của báo cáo 21:00 (gộp vào báo cáo ngày)', async () => {
    prismaMock.aiAutoReplyLog.findMany.mockResolvedValue([
      { audience: 'customer', decision: 'sent', reason: 'x' }, { audience: 'customer', decision: 'skipped', reason: 'nhân viên vừa trả lời' },
    ]);
    prismaMock.conversation.count.mockResolvedValue(7);
    const txt = await M.buildAiDailySection('o', new Date('2026-09-28T14:02:00Z'));
    expect(txt).toContain('AI trả lời Zalo — 24 giờ qua');
    expect(txt).toContain('Người nhắn riêng: 7');
    expect(txt).toContain('AI trả lời khách: 1');
  });
});

/**
 * ai-auto-reply.test.ts — AI tự trả lời 1-1 theo thẻ phân loại.
 * Mock prisma + AI provider + Zalo; kiểm cổng thẻ, hàng rào, lớp chặn, luồng gửi.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = {
  aiAutoReplyConfig: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  aiAutoReplyLog: { create: vi.fn(), count: vi.fn() },
  aiPlaybookEntry: { findMany: vi.fn() },
  messageTemplate: { findMany: vi.fn() },
  conversation: { findFirst: vi.fn(), update: vi.fn() },
  contact: { findUnique: vi.fn() },
  friend: { findUnique: vi.fn() },
  organization: { findUnique: vi.fn() },
  message: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  note: { findMany: vi.fn() },
};
const aiServiceMock = { getAiConfig: vi.fn(), getProviderApiKey: vi.fn(), generateText: vi.fn() };
const sendMessage = vi.fn();
const emit = vi.fn();

vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/modules/ai/ai-service.js', () => aiServiceMock);
vi.mock('../src/shared/zalo-operations.js', () => ({ zaloOps: { sendMessage } }));
vi.mock('../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: { getIO: () => ({ to: () => ({ emit }) }) } }));
vi.mock('../src/modules/contacts/contact-aggregate.js', () => ({
  applyContactAggregateFromMessage: vi.fn(), applyFriendAggregate: vi.fn(),
}));

const guards = await import('../src/modules/ai/auto-reply/guardrails.js');
const { evaluateConversation, matchTriggerTag, getConversationTags } = await import('../src/modules/ai/auto-reply/auto-reply-service.js');
const { _clearAutoReplyConfigCache, validateConfigInput } = await import('../src/modules/ai/auto-reply/config-service.js');

// 10:00 sáng giờ VN
const NOW = new Date('2026-09-26T03:00:00.000Z');

const CONFIG_ROW = {
  id: 'cfg', orgId: 'org-1', enabled: true, mode: 'auto',
  triggerTags: ['AI trả lời'], accountIds: [], hourStart: 7, hourEnd: 22,
  debounceSeconds: 20, maxRepliesPerDay: 300, maxRepliesPerConvPerDay: 15,
  skipIfStaffRepliedWithinMin: 10, blockedKeywords: ['hoàn tiền'],
  persona: null, extraInstruction: null, verifyGrounding: false,
  createdAt: NOW, updatedAt: NOW,
};

function prime(opts: { config?: Partial<typeof CONFIG_ROW>; labels?: unknown[]; pendingText?: string; lastSelf?: any } = {}) {
  _clearAutoReplyConfigCache();
  prismaMock.aiAutoReplyConfig.findUnique.mockResolvedValue({ ...CONFIG_ROW, ...opts.config });
  prismaMock.conversation.findFirst.mockResolvedValue({
    id: 'conv-1', threadType: 'user', zaloAccountId: 'za-1', externalThreadId: 'uid-9', contactId: 'c-1',
  });
  prismaMock.contact.findUnique.mockImplementation(async (args: any) =>
    args.select?.tags ? { tags: [] } : { fullName: 'Chị Lan', crmName: null, statusRef: null });
  prismaMock.friend.findUnique.mockResolvedValue({
    crmTagsPerNick: [], zaloLabels: opts.labels ?? [{ id: 1, name: 'AI trả lời' }],
  });
  prismaMock.organization.findUnique.mockResolvedValue({ timezone: '+07:00' });
  const pendingMsg = { id: 'm-2', content: opts.pendingText ?? 'Shop ơi áo này còn size M không ạ?', contentType: 'text', sentAt: new Date(NOW.getTime() - 60_000) };
  prismaMock.message.findFirst
    .mockResolvedValueOnce(opts.lastSelf ?? null) // lastSelf
    .mockResolvedValue({ id: 'm-2', senderType: 'contact' }); // newest (soát lần cuối)
  prismaMock.message.findMany.mockImplementation(async (args: any) =>
    args.where?.senderType === 'contact' ? [pendingMsg] : [{ senderType: 'contact', content: pendingMsg.content, contentType: 'text', sentAt: pendingMsg.sentAt, sentVia: 'user' }]);
  prismaMock.message.create.mockImplementation(async ({ data }: any) => ({ ...data }));
  prismaMock.note.findMany.mockResolvedValue([]);
  prismaMock.aiPlaybookEntry.findMany.mockResolvedValue([
    { title: 'Bảng size', category: 'size', keywords: ['size'], content: 'Áo có size S, M, L.' },
  ]);
  prismaMock.messageTemplate.findMany.mockResolvedValue([]);
  prismaMock.aiAutoReplyLog.count.mockResolvedValue(0);
  prismaMock.aiAutoReplyLog.create.mockResolvedValue({});
  prismaMock.conversation.update.mockResolvedValue({});
  aiServiceMock.getAiConfig.mockResolvedValue({ enabled: true, provider: 'gemini', model: 'gemini-2.5-flash' });
  aiServiceMock.getProviderApiKey.mockResolvedValue('key');
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(prismaMock)) for (const fn of Object.values(model)) (fn as any).mockReset();
});

describe('guardrails', () => {
  it('chuẩn hoá tên thẻ: bỏ "🔵 ", dấu, hoa thường', () => {
    expect(guards.normalizeTagName('🔵 AI Trả Lời')).toBe('ai tra loi');
    expect(matchTriggerTag(['🔵 ai trả lời'], ['AI trả lời'])).toBe('AI trả lời');
    expect(matchTriggerTag(['Khách mới'], ['AI trả lời'])).toBeNull();
  });

  it('cleanStyle bỏ gạch ngang dài', () => {
    expect(guards.cleanStyle('Dạ còn ạ — anh chọn màu nào')).toBe('Dạ còn ạ, anh chọn màu nào');
  });

  it('không cho chối là AI, và nhận là AI khi khách hỏi thẳng', () => {
    const fixed = guards.enforceHonesty('Dạ em không phải bot đâu ạ', 'bạn là bot à');
    expect(fixed.fixed).toBe(true);
    expect(fixed.text).toContain('trợ lý AI');
    expect(guards.enforceHonesty('Dạ còn size M ạ', 'còn size M không').fixed).toBe(false);
  });

  it('chặn bảo khách gửi OTP, giữ câu phủ định', () => {
    expect(guards.enforceNoCredentials('Anh gửi em mã OTP để xác nhận nhé').fixed).toBe(true);
    expect(guards.enforceNoCredentials('Anh không gửi mã OTP cho ai nhé').fixed).toBe(false);
  });

  it('parseDecision đọc JSON trong code fence; reply rỗng → handoff', () => {
    expect(guards.parseDecision('```json\n{"action":"reply","reply":"Dạ còn ạ","reason":"x"}\n```'))
      .toEqual({ action: 'reply', reply: 'Dạ còn ạ', reason: 'x' });
    expect(guards.parseDecision('{"action":"reply","reply":""}')?.action).toBe('handoff');
    expect(guards.parseDecision('không phải json')).toBeNull();
  });

  it('khung giờ theo offset org', () => {
    expect(guards.localHour(NOW, 420)).toBe(10);
    expect(guards.withinHours(22, 7, 22)).toBe(false);
    expect(guards.withinHours(23, 0, 24)).toBe(true);
  });
});

describe('getConversationTags', () => {
  it('gộp Contact.tags + crmTagsPerNick + tên thẻ Zalo', async () => {
    prismaMock.contact.findUnique.mockResolvedValue({ tags: ['VIP'] });
    prismaMock.friend.findUnique.mockResolvedValue({ crmTagsPerNick: ['🔵 Khách mới'], zaloLabels: [{ name: 'AI trả lời' }] });
    const tags = await getConversationTags({ zaloAccountId: 'za', externalThreadId: 'u', contactId: 'c' });
    expect(tags.sort()).toEqual(['AI trả lời', 'VIP', '🔵 Khách mới'].sort());
  });
});

describe('evaluateConversation', () => {
  it('hội thoại KHÔNG có thẻ kích hoạt → không gọi AI', async () => {
    prime({ labels: [{ name: 'Khách mới' }] });
    const r = await evaluateConversation('org-1', 'conv-1', { now: NOW });
    expect(r.reason).toBe('không có thẻ kích hoạt');
    expect(aiServiceMock.generateText).not.toHaveBeenCalled();
  });

  it('có thẻ → AI trả lời → gửi Zalo + lưu tin sentVia=automation + ghi nhật ký sent', async () => {
    prime();
    aiServiceMock.generateText.mockResolvedValue('{"action":"reply","reply":"Dạ còn size M ạ — chị lấy màu nào ạ?","reason":"hỏi size"}');
    sendMessage.mockResolvedValue({ message: { msgId: 123456 } });
    const r = await evaluateConversation('org-1', 'conv-1', { now: NOW });
    expect(r.decision).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith('za-1', 'uid-9', 0, { msg: 'Dạ còn size M ạ, chị lấy màu nào ạ?' });
    expect(prismaMock.message.create.mock.calls[0][0].data).toMatchObject({ sentVia: 'automation', senderType: 'self', zaloMsgId: '123456' });
    expect(prismaMock.aiAutoReplyLog.create.mock.calls.at(-1)[0].data.decision).toBe('sent');
    expect(emit).toHaveBeenCalledWith('chat:message', expect.objectContaining({ conversationId: 'conv-1' }));
    // prompt có kho kịch bản
    expect(aiServiceMock.generateText.mock.calls[0][4]).toContain('Bảng size');
  });

  it('chế độ dry_run → không gửi', async () => {
    prime({ config: { mode: 'dry_run' } });
    aiServiceMock.generateText.mockResolvedValue('{"action":"reply","reply":"Dạ còn ạ","reason":"x"}');
    const r = await evaluateConversation('org-1', 'conv-1', { now: NOW });
    expect(r.decision).toBe('dry_run');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('từ khoá nhạy cảm → handoff, không gọi AI', async () => {
    prime({ pendingText: 'Tôi muốn hoàn tiền' });
    const r = await evaluateConversation('org-1', 'conv-1', { now: NOW });
    expect(r.decision).toBe('handoff');
    expect(aiServiceMock.generateText).not.toHaveBeenCalled();
  });

  it('nhân viên vừa trả lời trong 10 phút → nhường', async () => {
    prime({ lastSelf: { sentAt: new Date(NOW.getTime() - 5 * 60_000), sentVia: 'user' } });
    const r = await evaluateConversation('org-1', 'conv-1', { now: NOW });
    expect(r.reason).toBe('nhân viên vừa trả lời');
    expect(aiServiceMock.generateText).not.toHaveBeenCalled();
  });

  it('ngoài khung giờ → bỏ qua', async () => {
    prime();
    const r = await evaluateConversation('org-1', 'conv-1', { now: new Date('2026-09-26T16:30:00.000Z') }); // 23:30 VN
    expect(r.reason).toBe('ngoài khung giờ');
  });

  it('AI chọn handoff → không gửi', async () => {
    prime();
    aiServiceMock.generateText.mockResolvedValue('{"action":"handoff","reply":"","reason":"khách hỏi đơn hàng"}');
    const r = await evaluateConversation('org-1', 'conv-1', { now: NOW });
    expect(r.decision).toBe('handoff');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('kiểm duyệt căn cứ viết lại khẳng định bịa; kiểm duyệt lỗi thì không gửi', async () => {
    prime({ config: { verifyGrounding: true } });
    aiServiceMock.generateText
      .mockResolvedValueOnce('{"action":"reply","reply":"Dạ áo giá 150k ạ","reason":"x"}')
      .mockResolvedValueOnce('{"ok":false,"rewrite":"Dạ em kiểm tra giá rồi báo chị ngay ạ"}');
    sendMessage.mockResolvedValue({});
    const r = await evaluateConversation('org-1', 'conv-1', { now: NOW });
    expect(r.content).toBe('Dạ em kiểm tra giá rồi báo chị ngay ạ');

    prime({ config: { verifyGrounding: true } });
    aiServiceMock.generateText
      .mockResolvedValueOnce('{"action":"reply","reply":"Dạ còn ạ","reason":"x"}')
      .mockRejectedValueOnce(new Error('timeout'));
    sendMessage.mockClear();
    const r2 = await evaluateConversation('org-1', 'conv-1', { now: NOW });
    expect(r2.decision).toBe('error');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('khách nhắn thêm trong lúc AI soạn → không gửi, đợi lượt sau', async () => {
    prime();
    prismaMock.message.findFirst.mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'm-3', senderType: 'contact' });
    aiServiceMock.generateText.mockResolvedValue('{"action":"reply","reply":"Dạ còn ạ","reason":"x"}');
    const r = await evaluateConversation('org-1', 'conv-1', { now: NOW });
    expect(r.decision).toBe('skipped');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('hết trần ngày → bỏ qua', async () => {
    prime();
    prismaMock.aiAutoReplyLog.count.mockResolvedValue(300);
    const r = await evaluateConversation('org-1', 'conv-1', { now: NOW });
    expect(r.reason).toBe('hết trần ngày');
  });
});

describe('validateConfigInput', () => {
  it('chặn khung giờ sai và mảng không phải chuỗi', () => {
    expect(validateConfigInput({ hourStart: 22, hourEnd: 7 })).toBeTruthy();
    expect(validateConfigInput({ triggerTags: [1 as any] })).toBeTruthy();
    expect(validateConfigInput({ hourStart: 0, hourEnd: 24, triggerTags: ['a'] })).toBeNull();
  });
});

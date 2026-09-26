/**
 * ai-bot-upgrade.test.ts — xưng hô theo giới tính Zalo, tra kho sản phẩm, chuyển người + Telegram.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = {
  aiAutoReplyProfile: { findUnique: vi.fn() },
  aiAutoReplyLog: { create: vi.fn(), count: vi.fn() },
  aiPlaybookEntry: { findMany: vi.fn() },
  aiLesson: { findMany: vi.fn() },
  messageTemplate: { findMany: vi.fn() },
  conversation: { findFirst: vi.fn(), update: vi.fn() },
  contact: { findUnique: vi.fn(), updateMany: vi.fn() },
  friend: { findUnique: vi.fn() },
  zaloAccount: { findUnique: vi.fn() },
  organization: { findUnique: vi.fn() },
  message: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  note: { findMany: vi.fn() },
};
const aiServiceMock = { getAiConfig: vi.fn(), getProviderApiKey: vi.fn(), generateText: vi.fn() };
const sendMessage = vi.fn();
const exec = vi.fn();
const sendToThread = vi.fn();
let connected = true;

vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/modules/ai/ai-service.js', () => aiServiceMock);
vi.mock('../src/shared/zalo-operations.js', () => ({ zaloOps: { sendMessage, exec } }));
vi.mock('../src/modules/zalo/zalo-pool.js', () => ({
  zaloPool: {
    getIO: () => ({ to: () => ({ emit: vi.fn() }) }),
    getInstance: () => (connected ? { status: 'connected', api: {} } : undefined),
  },
}));
vi.mock('../src/modules/api/public-api-routes.js', () => ({ sendToThread }));
vi.mock('../src/modules/contacts/contact-aggregate.js', () => ({
  applyContactAggregateFromMessage: vi.fn(), applyFriendAggregate: vi.fn(),
}));

const { buildSystemPrompt, addressingRule } = await import('../src/modules/ai/auto-reply/context-builder.js');
const { renderProducts, searchProducts, _setCatalogPoolForTest } = await import('../src/modules/ai/auto-reply/catalog-service.js');
const { formatHandoff, notifyHandoff, _resetHandoffNotify } = await import('../src/modules/ai/auto-reply/handoff-notify.js');
const { evaluateConversation, resolveCustomerGender } = await import('../src/modules/ai/auto-reply/auto-reply-service.js');
const { _clearAutoReplyConfigCache } = await import('../src/modules/ai/auto-reply/config-service.js');
const { zaloGender } = await import('../src/modules/zalo/zalo-message-helpers.js');

const NOW = new Date('2026-09-26T03:00:00.000Z');
const PROFILE = {
  id: 'p', orgId: 'org-1', zaloAccountId: 'za-1', enabled: true, mode: 'auto', triggerTags: ['Bot AI'],
  hourStart: 0, hourEnd: 24, debounceSeconds: 20, maxRepliesPerDay: 300, maxRepliesPerConvPerDay: 15,
  skipIfStaffRepliedWithinMin: 10, blockedKeywords: ['khiếu nại'], persona: null, extraInstruction: 'Xưng Mẫn', guideFileName: null,
  guideFiles: [], verifyGrounding: false, learningEnabled: false, lastLearnedAt: null,
  addressByGender: true, selfPronoun: 'em', useProductCatalog: true, sendProductImages: true,
  notifyHandoff: true, handoffChatId: '123', handoffPauseMinutes: 60, createdAt: NOW, updatedAt: NOW,
};

function prime(opts: { profile?: Partial<typeof PROFILE>; gender?: string | null; text?: string } = {}) {
  _clearAutoReplyConfigCache();
  prismaMock.aiAutoReplyProfile.findUnique.mockResolvedValue({ ...PROFILE, ...opts.profile });
  prismaMock.conversation.findFirst.mockResolvedValue({ id: 'conv-1', threadType: 'user', zaloAccountId: 'za-1', externalThreadId: 'u9', contactId: 'c-1' });
  prismaMock.contact.findUnique.mockImplementation(async (a: any) =>
    a.select?.tags ? { tags: [] } : a.select?.gender ? { gender: opts.gender ?? null } : { fullName: 'Lan', crmName: null, phone: '0901', gender: opts.gender ?? null });
  prismaMock.contact.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.friend.findUnique.mockResolvedValue({ crmTagsPerNick: [], zaloLabels: [{ name: 'Bot AI' }] });
  prismaMock.zaloAccount.findUnique.mockResolvedValue({ displayName: 'Minh Mẫn' });
  prismaMock.organization.findUnique.mockResolvedValue({ timezone: '+07:00' });
  const pending = { id: 'm-2', content: opts.text ?? 'Có nước hoa nữ mùi ngọt không', contentType: 'text', sentAt: new Date(NOW.getTime() - 60_000) };
  prismaMock.message.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: 'm-2', senderType: 'contact' });
  prismaMock.message.findMany.mockImplementation(async (a: any) => a.where?.senderType === 'contact' ? [pending] : []);
  prismaMock.message.create.mockImplementation(async ({ data }: any) => data);
  prismaMock.note.findMany.mockResolvedValue([]);
  prismaMock.aiPlaybookEntry.findMany.mockResolvedValue([]);
  prismaMock.messageTemplate.findMany.mockResolvedValue([]);
  prismaMock.aiLesson.findMany.mockResolvedValue([]);
  prismaMock.aiAutoReplyLog.count.mockResolvedValue(0);
  prismaMock.aiAutoReplyLog.create.mockResolvedValue({});
  prismaMock.conversation.update.mockResolvedValue({});
  aiServiceMock.getAiConfig.mockResolvedValue({ enabled: true, provider: 'gemini', model: 'm' });
  aiServiceMock.getProviderApiKey.mockResolvedValue('k');
}

beforeEach(() => {
  for (const model of Object.values(prismaMock)) for (const fn of Object.values(model)) (fn as any).mockReset();
  vi.clearAllMocks();
  _resetHandoffNotify();
  _setCatalogPoolForTest(null);
  connected = true;
  delete process.env.BOT_NOIBO_RO_DB_URL;
  process.env.HANDOFF_TELEGRAM_BOT_TOKEN = 'tok';
});

describe('xưng hô theo giới tính Zalo', () => {
  it('zaloGender: 0 nam, 1 nữ, lạ → null', () => {
    expect(zaloGender(0)).toBe('male');
    expect(zaloGender('1')).toBe('female');
    expect(zaloGender(undefined)).toBeNull();
    expect(zaloGender(5)).toBeNull();
  });
  it('quy tắc: nữ → chị, nam → anh, chưa rõ → anh/chị; đứng trên hướng dẫn', () => {
    expect(addressingRule({ selfPronoun: 'em', gender: 'female' })).toContain('gọi khách là "chị", tự xưng "em"');
    expect(addressingRule({ selfPronoun: 'em', gender: 'male' })).toContain('gọi khách là "anh"');
    expect(addressingRule({ selfPronoun: 'em', gender: null })).toContain('"anh/chị"');
    expect(buildSystemPrompt(null, 'Xưng Mẫn', [], [], { selfPronoun: 'em', gender: 'female' })).toContain('XƯNG HÔ BẮT BUỘC');
  });
  it('chưa có giới tính → hỏi Zalo qua nick rồi lưu', async () => {
    prismaMock.contact.findUnique.mockResolvedValue({ gender: null });
    prismaMock.contact.updateMany.mockResolvedValue({ count: 1 });
    exec.mockImplementation(async (_o: unknown, fn: any) => fn({ getUserInfo: async () => ({ changed_profiles: { u9_0: { gender: 1 } } }) }));
    expect(await resolveCustomerGender({ zaloAccountId: 'za', externalThreadId: 'u9', contactId: 'c' })).toBe('female');
    expect(prismaMock.contact.updateMany.mock.calls[0][0].data).toEqual({ gender: 'female' });
  });
  it('prompt thật dùng giới tính của khách', async () => {
    prime({ gender: 'male', text: 'giờ mở cửa' });
    aiServiceMock.generateText.mockResolvedValue('{"action":"reply","reply":"Dạ em chào anh ạ","reason":"x"}');
    sendMessage.mockResolvedValue({});
    await evaluateConversation('org-1', 'conv-1', { now: NOW });
    expect(aiServiceMock.generateText.mock.calls.at(-1)[3]).toContain('gọi khách là "anh"');
  });
});

describe('kho sản phẩm', () => {
  const P = { id: 7, code: 'SP1', name: 'Nước hoa Kat 20ml', unit: 'Cái', stock: 2, priceRetail: 79000, priceCtv: 73000, priceNpp: 72000,
    ctvMinQty: 10, nppMinQty: 20, onSale: false, saleNote: null, description: 'Mùi ngọt ngào nữ tính', thumbnail: 'https://cdn/x.jpg', approx: false };
  it('render: giá lẻ/CTV/NPP, tồn ít, gần đúng, không có giá vốn', () => {
    const out = renderProducts([P, { ...P, id: 8, priceRetail: null, approx: true }]);
    expect(out).toContain('giá lẻ 79.000đ · giá CTV 73.000đ (từ 10 Cái cùng món) · giá NPP 72.000đ (từ 20 Cái)');
    expect(out).toContain('(ít, 2 Cái)');
    expect(out).toContain('CHƯA CÓ GIÁ');
    expect(out).toContain('GẦN ĐÚNG');
    expect(out).not.toMatch(/vốn/);
  });
  it('searchProducts: bớt từ khi không ra, gắn "gần đúng", lấy giá theo bảng giá', async () => {
    const query = vi.fn(async (sql: string, params: any[]) => {
      if (sql.includes('price_books')) return { rows: [{ id: 5, name: 'Bảng giá chung', is_default: true, min_quantity: 0 }, { id: 9, name: 'Giá CTV', is_default: false, min_quantity: 10 }, { id: 8, name: 'Giá NPP', is_default: false, min_quantity: 20 }] };
      if (sql.includes('product_prices')) return { rows: [{ product_id: 1, price_book_id: 5, price: '120000' }, { product_id: 1, price_book_id: 9, price: '100000' }] };
      if (params[0].length === 3) return { rows: [] }; // "noi chien 5l" không có
      return { rows: [{ id: 1, code: 'A', name: 'Nồi chiên 3L', unit: 'Cái', stock: 4, sell_price: 0, is_sale: false, description: '', thumbnail: 'https://c/a.jpg' }] };
    });
    _setCatalogPoolForTest({ query } as any);
    const r = await searchProducts([{ name: 'nồi chiên 5L' }]);
    expect(r[0]).toMatchObject({ id: 1, priceRetail: 120000, priceCtv: 100000, priceNpp: null, approx: true });
  });
  it('luồng: tra kho → prompt có sản phẩm → gửi ảnh sản phẩm AI chọn', async () => {
    prime({ gender: 'female' });
    process.env.BOT_NOIBO_RO_DB_URL = 'postgres://x';
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('price_books')) return { rows: [{ id: 5, name: 'Bảng giá chung', is_default: true, min_quantity: 0 }] };
      if (sql.includes('product_prices')) return { rows: [{ product_id: 7, price_book_id: 5, price: '79000' }] };
      return { rows: [{ id: 7, code: 'SP1', name: 'Nước hoa Kat 20ml', unit: 'Cái', stock: 9, sell_price: 79000, is_sale: false, description: 'ngọt ngào', thumbnail: 'https://cdn/x.jpg' }] };
    });
    _setCatalogPoolForTest({ query } as any);
    aiServiceMock.generateText
      .mockResolvedValueOnce('{"queries":[{"name":"nước hoa","hints":["nữ","ngọt"]}]}')
      .mockResolvedValueOnce('{"action":"reply","reply":"Dạ chị tham khảo Nước hoa Kat 20ml giá 79.000đ ạ, em gửi ảnh chị xem","reason":"tư vấn","productIds":[7,999]}');
    sendMessage.mockResolvedValue({});
    sendToThread.mockResolvedValue(undefined);
    const r = await evaluateConversation('org-1', 'conv-1', { now: NOW });
    expect(r.decision).toBe('sent');
    expect(aiServiceMock.generateText.mock.calls[1][3]).toContain('Nước hoa Kat 20ml (mã SP1) — giá lẻ 79.000đ');
    expect(sendToThread).toHaveBeenCalledWith({}, 'org-1', 'za-1', 'u9', 0, '', ['https://cdn/x.jpg']);
  });
});

describe('chuyển người + Telegram', () => {
  it('formatHandoff theo mẫu skill', () => {
    const t = formatHandoff({ conversationId: 'cv', nickName: 'Minh Mẫn', customerName: 'Lan <b>', urgent: true, reason: 'KHẨN · khách bực', customerText: 'hàng lỗi', botReply: 'Dạ em ghi nhận ạ' }, 'https://crm.x');
    expect(t).toContain('🚨 KHẨN');
    expect(t).toContain('Lan &lt;b&gt;');
    expect(t).toContain('https://crm.x/chat/cv');
  });
  it('không báo lại cùng khách trong thời gian chờ (trừ KHẨN)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const h = { conversationId: 'cv', nickName: 'n', customerName: 'k', urgent: false, reason: 'r', customerText: 't', botReply: null };
    expect(await notifyHandoff(h, { chatId: '1', pauseMinutes: 60 })).toBe(true);
    expect(await notifyHandoff(h, { chatId: '1', pauseMinutes: 60 })).toBe(false);
    expect(await notifyHandoff({ ...h, urgent: true }, { chatId: '1', pauseMinutes: 60 })).toBe(true);
    vi.unstubAllGlobals();
  });
  it('AI chọn handoff: nói 1 câu với khách (giữ Chưa rep) + gửi Telegram', async () => {
    prime({ gender: 'female', text: 'Cho gặp anh Mẫn' });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    aiServiceMock.generateText.mockResolvedValue('{"action":"handoff","reply":"Dạ em ghi nhận rồi ạ, anh Mẫn sẽ nhắn lại chị nha","reason":"THƯỜNG · khách muốn gặp Mẫn","urgent":false}');
    sendMessage.mockResolvedValue({});
    const r = await evaluateConversation('org-1', 'conv-1', { now: NOW });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.decision).toBe('handoff');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(prismaMock.conversation.update.mock.calls[0][0].data).toEqual({ lastMessageAt: expect.any(Date) }); // không đánh dấu đã rep
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).text).toContain('khách muốn gặp Mẫn');
    vi.unstubAllGlobals();
  });
  it('từ khoá nhạy cảm → chuyển KHẨN + Telegram, không gọi AI', async () => {
    prime({ text: 'tôi muốn khiếu nại' });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await evaluateConversation('org-1', 'conv-1', { now: NOW });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.decision).toBe('handoff');
    expect(aiServiceMock.generateText).not.toHaveBeenCalled();
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).text).toContain('KHẨN');
    vi.unstubAllGlobals();
  });
});

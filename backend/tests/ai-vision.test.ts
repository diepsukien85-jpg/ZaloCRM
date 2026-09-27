/**
 * ai-vision.test.ts — AI nhìn ảnh khách gửi: lấy link ảnh, tải ảnh an toàn, nhận diện → tra kho → tư vấn.
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
const aiServiceMock = {
  getAiConfig: vi.fn(), getProviderApiKey: vi.fn(), generateText: vi.fn(),
  generateWithImages: vi.fn(), providerSupportsImages: (p: string) => p === 'gemini',
};
const sendMessage = vi.fn();
const sendToThread = vi.fn();

vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/modules/ai/ai-service.js', () => aiServiceMock);
vi.mock('../src/shared/zalo-operations.js', () => ({ zaloOps: { sendMessage, exec: vi.fn() } }));
vi.mock('../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: { getIO: () => null, getInstance: () => ({ status: 'connected', api: {} }) } }));
vi.mock('../src/modules/api/public-api-routes.js', () => ({ sendToThread }));
vi.mock('../src/modules/contacts/contact-aggregate.js', () => ({ applyContactAggregateFromMessage: vi.fn(), applyFriendAggregate: vi.fn() }));

const V = await import('../src/modules/ai/auto-reply/image-understanding.js');
const { evaluateConversation, _clearLiveLabelCache } = await import('../src/modules/ai/auto-reply/auto-reply-service.js');
const { _clearAutoReplyConfigCache } = await import('../src/modules/ai/auto-reply/config-service.js');
const { _setCatalogPoolForTest } = await import('../src/modules/ai/auto-reply/catalog-service.js');

const NOW = new Date('2026-09-27T03:00:00.000Z');
const IMG = JSON.stringify({ href: 'https://photo-stal-36.zdn.vn/x.jpg', thumb: '/api/v1/media/2026-09-27/a.jpg' });

describe('imageUrlOf', () => {
  it('ưu tiên bản trong kho CRM, rồi CDN Zalo; bỏ link lạ', () => {
    expect(V.imageUrlOf(IMG)).toBe('/api/v1/media/2026-09-27/a.jpg');
    expect(V.imageUrlOf(JSON.stringify({ href: 'https://photo.zdn.vn/y.jpg' }))).toBe('https://photo.zdn.vn/y.jpg');
    expect(V.imageUrlOf(JSON.stringify({ href: 'http://evil.com/a.jpg' }))).toBeNull();
    expect(V.imageUrlOf(null)).toBeNull();
  });
});

describe('loadImage', () => {
  const ok = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });
  it('media CRM đọc qua server nội bộ; CDN Zalo https; link lạ bị chặn', async () => {
    const f = vi.fn(async () => ok());
    expect(await V.loadImage('/api/v1/media/2026-09-27/a.jpg', f as any)).toEqual({ mimeType: 'image/png', data: 'AQID' });
    expect((f.mock.calls[0] as any)[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/media\//);
    expect(await V.loadImage('https://photo-stal-36.zdn.vn/x.jpg', f as any)).not.toBeNull();
    expect(await V.loadImage('https://attacker.example/x.jpg', f as any)).toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('understandCustomerImages', () => {
  beforeEach(() => vi.clearAllMocks());
  it('gửi ảnh cho Gemini, trả mô tả + truy vấn tra kho', async () => {
    aiServiceMock.generateWithImages.mockResolvedValue('{"summary":"Nồi chiên không dầu Nineshield 8L màu đen","queries":[{"name":"nồi chiên","hints":["Nineshield","8L"]}]}');
    const f = vi.fn(async () => new Response(new Uint8Array([9]), { status: 200 }));
    const r = await V.understandCustomerImages({ provider: 'gemini', apiKey: 'k', model: 'm' }, ['/api/v1/media/a.jpg'], 'có bán không', f as any);
    expect(r).toEqual({ summary: 'Nồi chiên không dầu Nineshield 8L màu đen', queries: [{ name: 'nồi chiên', hints: ['Nineshield', '8L'] }] });
    expect(aiServiceMock.generateWithImages.mock.calls[0][5]).toHaveLength(1);
  });
  it('nhà cung cấp không đọc được ảnh → null, không gọi AI', async () => {
    expect(await V.understandCustomerImages({ provider: 'anthropic', apiKey: 'k', model: 'm' }, ['/api/v1/media/a.jpg'], '')).toBeNull();
    expect(aiServiceMock.generateWithImages).not.toHaveBeenCalled();
  });
});

describe('luồng trả lời khi khách gửi ảnh', () => {
  beforeEach(() => {
    for (const m of Object.values(prismaMock)) for (const fn of Object.values(m)) (fn as any).mockReset();
    vi.clearAllMocks();
    _clearAutoReplyConfigCache();
    _clearLiveLabelCache();
    process.env.BOT_NOIBO_RO_DB_URL = 'postgres://x';
    prismaMock.aiAutoReplyProfile.findUnique.mockResolvedValue({
      id: 'p', orgId: 'o', zaloAccountId: 'za', enabled: true, mode: 'auto', triggerTags: ['Bot AI'], hourStart: 0, hourEnd: 24,
      debounceSeconds: 20, maxRepliesPerDay: 300, maxRepliesPerConvPerDay: 15, skipIfStaffRepliedWithinMin: 10, blockedKeywords: [],
      persona: null, extraInstruction: null, guideFileName: null, guideFiles: [], verifyGrounding: false, learningEnabled: false,
      lastLearnedAt: null, addressByGender: true, selfPronoun: 'em', useProductCatalog: true, sendProductImages: true,
      notifyHandoff: false, handoffChatId: null, handoffPauseMinutes: 60, createdAt: NOW, updatedAt: NOW,
    });
    prismaMock.conversation.findFirst.mockResolvedValue({ id: 'c1', threadType: 'user', zaloAccountId: 'za', externalThreadId: 'u1', contactId: 'k1' });
    prismaMock.contact.findUnique.mockImplementation(async (a: any) => a.select?.tags ? { tags: [] } : { gender: 'female', fullName: 'Lan' });
    prismaMock.friend.findUnique.mockResolvedValue({ crmTagsPerNick: [], zaloLabels: [{ name: 'Bot AI' }] });
    prismaMock.organization.findUnique.mockResolvedValue({ timezone: '+07:00' });
    prismaMock.message.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: 'm1', senderType: 'contact' });
    prismaMock.message.create.mockImplementation(async ({ data }: any) => data);
    for (const m of ['note', 'aiPlaybookEntry', 'messageTemplate', 'aiLesson'] as const) (prismaMock as any)[m].findMany.mockResolvedValue([]);
    prismaMock.aiAutoReplyLog.count.mockResolvedValue(0);
    prismaMock.aiAutoReplyLog.create.mockResolvedValue({});
    prismaMock.conversation.update.mockResolvedValue({});
    aiServiceMock.getAiConfig.mockResolvedValue({ enabled: true, provider: 'gemini', model: 'm' });
    aiServiceMock.getProviderApiKey.mockResolvedValue('k');
    _setCatalogPoolForTest({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('price_books')) return { rows: [{ id: 5, name: 'Bảng giá chung', is_default: true, min_quantity: 0 }] };
        if (sql.includes('product_prices')) return { rows: [{ product_id: 3, price_book_id: 5, price: '485000' }] };
        return { rows: [{ id: 3, code: 'NC8', name: 'Nồi Chiên 8L Nineshield', unit: 'Cái', stock: 5, sell_price: 485000, is_sale: false, description: 'Nồi chiên 8L', thumbnail: 'https://cdn/n.jpg' }] };
      }),
    } as any);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'image/jpeg' } })));
    sendToThread.mockResolvedValue(undefined);
  });

  it('chỉ gửi ảnh (không chữ): KHÔNG còn bỏ qua — nhìn ảnh → tra kho → tư vấn đúng món', async () => {
    prismaMock.message.findMany.mockImplementation(async (a: any) => a.where?.senderType === 'contact'
      ? [{ id: 'm1', content: IMG, contentType: 'image', sentAt: new Date(NOW.getTime() - 60_000) }] : []);
    aiServiceMock.generateWithImages.mockResolvedValue('{"summary":"Nồi chiên không dầu Nineshield 8L","queries":[{"name":"nồi chiên","hints":["8L"]}]}');
    aiServiceMock.generateText.mockResolvedValue('{"action":"reply","reply":"Dạ đây là Nồi Chiên 8L Nineshield giá 485.000đ, bên em còn hàng chị nha","reason":"ảnh","productIds":[3]}');
    sendMessage.mockResolvedValue({});
    const r = await evaluateConversation('o', 'c1', { now: NOW });
    expect(r.decision).toBe('sent');
    const [, , , sys, user] = aiServiceMock.generateText.mock.calls[0];
    expect(user).toContain('[Khách gửi ảnh: Nồi chiên không dầu Nineshield 8L]');
    expect(sys).toContain('Nồi Chiên 8L Nineshield (mã NC8) — giá lẻ 485.000đ');
    expect(sendToThread).toHaveBeenCalledWith({}, 'o', 'za', 'u1', 0, '', ['https://cdn/n.jpg']); // gửi ảnh món tương ứng
    vi.unstubAllGlobals();
  });

  it('ảnh + "có bán không": truy vấn từ ảnh đứng trước truy vấn từ chữ', async () => {
    prismaMock.message.findMany.mockImplementation(async (a: any) => a.where?.senderType === 'contact' ? [
      { id: 'm0', content: IMG, contentType: 'image', sentAt: new Date(NOW.getTime() - 70_000) },
      { id: 'm1', content: 'bên em có bán cái này không', contentType: 'text', sentAt: new Date(NOW.getTime() - 60_000) },
    ] : []);
    aiServiceMock.generateWithImages.mockResolvedValue('{"summary":"Nồi chiên 8L","queries":[{"name":"nồi chiên","hints":[]}]}');
    aiServiceMock.generateText
      .mockResolvedValueOnce('{"queries":[]}') // tách từ khoá từ chữ: không có tên món
      .mockResolvedValueOnce('{"action":"reply","reply":"Dạ có ạ","reason":"x"}');
    sendMessage.mockResolvedValue({});
    const r = await evaluateConversation('o', 'c1', { now: NOW });
    expect(r.decision).toBe('sent');
    expect(aiServiceMock.generateText.mock.calls[1][3]).toContain('Nồi Chiên 8L Nineshield');
    vi.unstubAllGlobals();
  });

  it('không xem được ảnh → vẫn trả lời, nhắc AI hỏi khách món gì', async () => {
    prismaMock.message.findMany.mockImplementation(async (a: any) => a.where?.senderType === 'contact'
      ? [{ id: 'm1', content: IMG, contentType: 'image', sentAt: new Date(NOW.getTime() - 60_000) }] : []);
    aiServiceMock.generateWithImages.mockRejectedValue(new Error('boom'));
    aiServiceMock.generateText.mockResolvedValue('{"action":"reply","reply":"Dạ chị cho em xin tên món trong ảnh nha","reason":"x"}');
    sendMessage.mockResolvedValue({});
    await evaluateConversation('o', 'c1', { now: NOW });
    expect(aiServiceMock.generateText.mock.calls.at(-1)[4]).toContain('hệ thống chưa xem được ảnh');
    vi.unstubAllGlobals();
  });
});

describe('kiểm duyệt căn cứ — code thẩm tra lại', () => {
  it('moneyAmounts / unsupportedAmounts: nhận "72.000đ", "79k", tổng = giá × số lượng', async () => {
    const { moneyAmounts, unsupportedAmounts, isRealGroundingIssue } = await import('../src/modules/ai/auto-reply/auto-reply-service.js');
    expect(moneyAmounts('giá 72.000đ, lẻ 79k, tổng 1.440.000 đ')).toEqual([72000, 79000, 1440000]);
    const src = 'Nước Hoa Kat & Kev 20ml — giá lẻ 79.000đ · giá NPP 72.000đ (từ 20 Cái)';
    expect(unsupportedAmounts('20 chai tổng 1.440.000đ, giá NPP 72.000đ', src)).toEqual([]);
    expect(unsupportedAmounts('giá sỉ 65.000đ', src)).toEqual([65000]);
    // báo nhầm: câu chỉ có giá đúng nguồn → không phải lỗi thật
    expect(isRealGroundingIssue('Mẫu này giá NPP là 72.000đ/cái khi anh lấy từ 20 cái ạ.', src)).toBe(false);
    // chính sách / số lạ → lỗi thật
    expect(isRealGroundingIssue('Bên em bảo hành 12 tháng ạ', src)).toBe(true);
    expect(isRealGroundingIssue('Giá chỉ 50.000đ thôi ạ', src)).toBe(true);
    expect(isRealGroundingIssue('Chai này dung tích 100ml ạ', src)).toBe(true);
  });
});

describe('chặn lấy nhầm giá biến thể', () => {
  it('focusPriceSource: giá 25ml (71k) không hợp lệ khi đang tư vấn chai 20ml', async () => {
    const { focusPriceSource, unsupportedAmounts } = await import('../src/modules/ai/auto-reply/auto-reply-service.js');
    const products = [
      { id: 1, name: 'Nước Hoa Kat & Kev 20ml', priceRetail: 79000, priceCtv: 73000, priceNpp: 72000 },
      { id: 2, name: 'Nước Hoa Kat & Kev 25ml', priceRetail: 79000, priceCtv: 72000, priceNpp: 71000 },
    ];
    const src = focusPriceSource(products, [1])!;
    expect(unsupportedAmounts('20 chai giá NPP 71.000đ mỗi chai', src)).toEqual([71000]);
    expect(unsupportedAmounts('20 chai giá NPP 72.000đ, tổng 1.440.000đ', src)).toEqual([]);
    expect(focusPriceSource(products, [])).toBeNull();
  });
});

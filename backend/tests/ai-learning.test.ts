/**
 * ai-learning.test.ts — vòng tự học của AI tự trả lời: chấm kết quả, lọc bài học,
 * rút bài học từ phản hồi, học hằng ngày (thêm/bỏ, bảo vệ bài viết tay), điểm chất lượng.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = {
  aiAutoReplyLog: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  aiAutoReplyProfile: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  aiLesson: { findMany: vi.fn(), create: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
  message: { findMany: vi.fn() },
  organization: { findUnique: vi.fn() },
};
const aiServiceMock = { getAiConfig: vi.fn(), getProviderApiKey: vi.fn(), generateText: vi.fn() };

vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/modules/ai/ai-service.js', () => aiServiceMock);

const L = await import('../src/modules/ai/auto-reply/learning-service.js');
const { _clearAutoReplyConfigCache } = await import('../src/modules/ai/auto-reply/config-service.js');
const { buildSystemPrompt } = await import('../src/modules/ai/auto-reply/context-builder.js');

const NOW = new Date('2026-09-26T16:30:00.000Z'); // 23:30 giờ VN

const PROFILE = {
  id: 'p', orgId: 'org-1', zaloAccountId: 'za-1', enabled: true, mode: 'auto', triggerTags: ['Bot AI'],
  hourStart: 7, hourEnd: 22, debounceSeconds: 20, maxRepliesPerDay: 300, maxRepliesPerConvPerDay: 15,
  skipIfStaffRepliedWithinMin: 10, blockedKeywords: [], persona: null, extraInstruction: null, guideFileName: null,
  verifyGrounding: true, learningEnabled: true, lastLearnedAt: null, createdAt: NOW, updatedAt: NOW,
};

beforeEach(() => {
  for (const model of Object.values(prismaMock)) for (const fn of Object.values(model)) (fn as any).mockReset();
  vi.clearAllMocks();
  _clearAutoReplyConfigCache();
  prismaMock.aiAutoReplyProfile.findUnique.mockResolvedValue(PROFILE);
  aiServiceMock.getAiConfig.mockResolvedValue({ enabled: true, provider: 'gemini', model: 'm' });
  aiServiceMock.getProviderApiKey.mockResolvedValue('key');
});

const msg = (senderType: string, content: string, sentVia = 'user') => ({ senderType, sentVia, content, contentType: 'text' });

describe('classifyOutcome', () => {
  it('nhân viên vào trả lời sau AI → staff_intervened (kể cả khi khách cũng nhắn)', () => {
    const r = L.classifyOutcome('sent', [msg('contact', 'ok'), msg('self', 'Dạ để em báo lại giá đúng ạ')]);
    expect(r.outcome).toBe('staff_intervened');
    expect(r.staff).toContain('báo lại giá');
  });
  it('tin AI tự gửi không tính là nhân viên', () => {
    expect(L.classifyOutcome('sent', [msg('self', 'x', 'automation'), msg('contact', 'cảm ơn shop')]).outcome).toBe('customer_replied');
  });
  it('khách phàn nàn → customer_unhappy; không ai nhắn → no_reply', () => {
    expect(L.classifyOutcome('sent', [msg('contact', 'Sai rồi, cho gặp người thật')]).outcome).toBe('customer_unhappy');
    expect(L.classifyOutcome('sent', []).outcome).toBe('no_reply');
  });
  it('chạy thử: có nhân viên trả lời thật → staff_answered', () => {
    expect(L.classifyOutcome('dry_run', [msg('self', 'Dạ 890k ạ')]).outcome).toBe('staff_answered');
    expect(L.classifyOutcome('dry_run', []).outcome).toBe('no_staff');
  });
});

describe('sanitizeLesson', () => {
  it('che SĐT / số dài, bỏ bài có mật khẩu, chặn quá ngắn', () => {
    expect(L.sanitizeLesson('Khách cần gấp thì cho số 0912 345 678 của kho')).toContain('[SĐT]');
    expect(L.sanitizeLesson('Chuyển khoản vào 123456789012 nhé')).toContain('[số]');
    expect(L.sanitizeLesson('mật khẩu: abc123 dùng cho khách')).toBeNull();
    expect(L.sanitizeLesson('ok')).toBeNull();
    expect(L.sanitizeLesson(42)).toBeNull();
  });
});

describe('evaluateOutcomes', () => {
  it('chấm các lượt đủ 30 phút và lưu tin nhân viên / khách', async () => {
    prismaMock.aiAutoReplyLog.findMany.mockResolvedValue([{ id: 'log1', conversationId: 'c1', decision: 'sent', createdAt: new Date(NOW.getTime() - 3600_000) }]);
    prismaMock.message.findMany.mockResolvedValue([msg('self', 'Dạ em sửa lại: 950k ạ')]);
    prismaMock.aiAutoReplyLog.update.mockResolvedValue({});
    expect(await L.evaluateOutcomes(NOW)).toBe(1);
    expect(prismaMock.aiAutoReplyLog.update.mock.calls[0][0].data).toMatchObject({ outcome: 'staff_intervened', staffFollowup: 'Dạ em sửa lại: 950k ạ' });
  });
});

describe('learnFromFeedback', () => {
  it('👎 kèm câu đúng → tạo bài học nguồn feedback', async () => {
    prismaMock.aiAutoReplyLog.findUnique.mockResolvedValue({
      id: 'log1', orgId: 'org-1', zaloAccountId: 'za-1', customerText: 'giá sỉ sao shop', content: 'Dạ 890k ạ',
      correctedReply: 'Dạ em cần lấy bao nhiêu bịch để chị báo giá sỉ nha', feedbackNote: null,
    });
    prismaMock.aiLesson.findMany.mockResolvedValue([]);
    aiServiceMock.generateText.mockResolvedValue('{"lesson":"Khi khách hỏi giá sỉ, hỏi số lượng trước rồi mới báo giá."}');
    const r = await L.learnFromFeedback('log1');
    expect(r.lesson).toContain('hỏi số lượng');
    expect(prismaMock.aiLesson.create.mock.calls[0][0].data).toMatchObject({ zaloAccountId: 'za-1', source: 'feedback', evidence: ['log1'] });
  });

  it('nick tắt tự học → không học', async () => {
    prismaMock.aiAutoReplyProfile.findUnique.mockResolvedValue({ ...PROFILE, learningEnabled: false });
    prismaMock.aiAutoReplyLog.findUnique.mockResolvedValue({ id: 'log1', orgId: 'org-1', zaloAccountId: 'za-1', correctedReply: 'x' });
    expect((await L.learnFromFeedback('log1')).lesson).toBeNull();
    expect(aiServiceMock.generateText).not.toHaveBeenCalled();
  });
});

describe('runDailyLearning', () => {
  it('thêm bài mới, bỏ bài tự học sai, KHÔNG bỏ bài viết tay, ghi lastLearnedAt', async () => {
    prismaMock.aiAutoReplyLog.findMany.mockResolvedValue([
      { id: 'a', decision: 'sent', customerText: 'ship HN mấy ngày', content: 'Dạ 1 ngày ạ', outcome: 'staff_intervened', staffFollowup: 'Dạ HN 2-3 ngày ạ' },
      { id: 'b', decision: 'sent', customerText: 'ok', content: 'Dạ', outcome: 'customer_replied' },
    ]);
    prismaMock.aiLesson.findMany.mockResolvedValue([
      { id: 'old-auto', content: 'Ship HN 1 ngày', source: 'daily' },
      { id: 'old-manual', content: 'Luôn xưng em', source: 'manual' },
    ]);
    aiServiceMock.generateText.mockResolvedValue('{"add":["Ship Hà Nội mất 2-3 ngày, không hứa giao trong ngày.","Luôn xưng em"],"remove":["old-auto","old-manual"]}');
    const r = await L.runDailyLearning('org-1', 'za-1', NOW);
    expect(r).toMatchObject({ added: 1, removed: 1, reviewed: 1 });
    expect(prismaMock.aiLesson.createMany.mock.calls[0][0].data[0].content).toContain('2-3 ngày');
    expect(prismaMock.aiLesson.updateMany.mock.calls[0][0].where.id.in).toEqual(['old-auto']);
    expect(prismaMock.aiAutoReplyProfile.update.mock.calls[0][0].data.lastLearnedAt).toEqual(NOW);
    // chỉ học từ nhân viên: prompt có câu nhân viên thực tế nhắn
    expect(aiServiceMock.generateText.mock.calls[0][4]).toContain('Nhân viên thực tế nhắn: Dạ HN 2-3 ngày ạ');
  });

  it('không có lượt nào cần học → không gọi AI', async () => {
    prismaMock.aiAutoReplyLog.findMany.mockResolvedValue([{ id: 'b', decision: 'sent', outcome: 'customer_replied' }]);
    const r = await L.runDailyLearning('org-1', 'za-1', NOW);
    expect(r.skipped).toBe('không có lượt nào để học');
    expect(aiServiceMock.generateText).not.toHaveBeenCalled();
  });
});

describe('runDueDailyLearning', () => {
  it('23h mà hôm nay chưa học → học; đã học hôm nay → bỏ qua', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({ timezone: '+07:00' });
    prismaMock.aiAutoReplyProfile.findMany.mockResolvedValue([
      { orgId: 'org-1', zaloAccountId: 'za-1', lastLearnedAt: null },
      { orgId: 'org-1', zaloAccountId: 'za-2', lastLearnedAt: new Date('2026-09-26T16:00:00.000Z') },
    ]);
    prismaMock.aiAutoReplyLog.findMany.mockResolvedValue([]);
    await L.runDueDailyLearning(NOW);
    expect(prismaMock.aiAutoReplyLog.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.aiAutoReplyLog.findMany.mock.calls[0][0].where.zaloAccountId).toBe('za-1');
  });
});

describe('qualityByDay', () => {
  it('điểm = tốt / (tốt + xấu); chủ shop chấm tay được ưu tiên', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({ timezone: '+07:00' });
    const at = new Date('2026-09-26T05:00:00.000Z');
    prismaMock.aiAutoReplyLog.findMany.mockResolvedValue([
      { decision: 'sent', outcome: 'customer_replied', feedback: null, createdAt: at },
      { decision: 'sent', outcome: 'customer_replied', feedback: 'bad', createdAt: at },
      { decision: 'sent', outcome: 'staff_intervened', feedback: null, createdAt: at },
      { decision: 'sent', outcome: 'no_reply', feedback: 'good', createdAt: at },
      { decision: 'handoff', outcome: null, feedback: null, createdAt: at },
    ]);
    const days = await L.qualityByDay('org-1', 'za-1', 1, NOW);
    expect(days[0]).toMatchObject({ date: '2026-09-26', sent: 4, good: 2, bad: 2, handoff: 1, score: 50 });
  });
});

describe('buildSystemPrompt', () => {
  it('đưa bài học vào prompt, xếp dưới hướng dẫn', () => {
    const p = buildSystemPrompt(null, 'Xưng chị', ['Hỏi số lượng trước khi báo giá sỉ.']);
    expect(p).toContain('<bai_hoc>');
    expect(p).toContain('- Hỏi số lượng trước khi báo giá sỉ.');
    expect(p.indexOf('<huong_dan_cua_shop>')).toBeLessThan(p.indexOf('<bai_hoc>'));
  });
});

const { pickGuideFiles, queryTerms } = await import('../src/modules/ai/auto-reply/context-builder.js');

describe('pickGuideFiles (tài liệu tham khảo của skill)', () => {
  const files = [
    { path: 'references/03-gia-don-hang-giao-hang.md', content: '# Giao hàng\nGiao hàng toàn quốc 2-4 ngày, phí giao theo bưu điện.', mode: 'auto' as const },
    { path: 'references/04-bao-hanh-doi-tra.md', content: '# Bảo hành\nBảo hành 1 tháng, lỗi thì đổi mới.', mode: 'auto' as const },
    { path: 'references/05-khach-si-ctv-npp.md', content: '# Khách sỉ, CTV\nCTV doanh số từ 2 triệu mỗi tháng.', mode: 'auto' as const },
    { path: 'references/08-cam-va-chuyen-tin.md', content: 'Không nói rẻ nhất.', mode: 'always' as const },
    { path: 'references/00-huong-dan-gan.md', content: 'Ghi chú cho người, bảo hành giao hàng CTV.', mode: 'off' as const },
  ];
  const names = (q: string) => pickGuideFiles(files, q).map((f) => f.path.split('/')[1].slice(0, 2));

  it('chọn đúng file theo chủ đề, hiểu từ đồng nghĩa (ship → giao hàng, ctv)', () => {
    expect(names('Ship về Cần Thơ mấy ngày')).toEqual(['08', '03']);
    expect(names('máy bị lỗi có bảo hành không')).toEqual(['08', '04']);
    expect(names('muốn làm CTV')).toEqual(['08', '05']);
  });
  it('câu không có chủ đề chỉ nạp file luôn dùng; file tắt không bao giờ nạp', () => {
    expect(names('ok cảm ơn shop')).toEqual(['08']);
    expect(names('bảo hành giao hàng ctv').includes('00')).toBe(false);
  });
  it('giữ trong ngân sách ký tự', () => {
    const big = [{ path: 'a.md', content: 'x'.repeat(5000), mode: 'always' as const }, { path: 'b.md', content: 'y'.repeat(5000), mode: 'always' as const }];
    const out = pickGuideFiles(big, 'gì', 6000);
    expect(out.reduce((s, f) => s + f.content.length, 0)).toBeLessThanOrEqual(6000 + 20);
  });
  it('bỏ từ chức năng', () => {
    expect(queryTerms('cho em hỏi với ạ')).not.toContain('em');
  });
});

describe('validateProfileInput — tài liệu skill', () => {
  it('chặn chế độ lạ / file quá dài; nhận hợp lệ', async () => {
    const { validateProfileInput, GUIDE_FILE_MAX_CHARS } = await import('../src/modules/ai/auto-reply/config-service.js');
    expect(validateProfileInput({ guideFiles: [{ path: 'a.md', content: 'x', mode: 'sometimes' as any }] })).toBeTruthy();
    expect(validateProfileInput({ guideFiles: [{ path: 'a.md', content: 'x'.repeat(GUIDE_FILE_MAX_CHARS + 1), mode: 'auto' }] })).toBeTruthy();
    expect(validateProfileInput({ guideFiles: [{ path: 'a.md', content: 'nội dung', mode: 'always' }], extraInstruction: 'x'.repeat(25000) })).toBeNull();
  });
});

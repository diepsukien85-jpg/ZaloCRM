/**
 * response-report.test.ts — chỉ số nhân viên phản hồi khách (theo nick).
 */
import { describe, it, expect, vi } from 'vitest';
vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: {} }));
vi.mock('../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: { getInstance: () => undefined } }));
vi.mock('../src/shared/zalo-operations.js', () => ({ zaloOps: {} }));
const R = await import('../src/modules/analytics/response-report.js');

const NOW = new Date('2026-09-28T13:00:00Z'); // 20:00 VN
const t = (min: number) => new Date(NOW.getTime() - min * 60_000);
const turn = (conv: string, startMinAgo: number, replyAfterMin: number | null, via = 'user', name = 'Khách ' + conv) => ({
  zaloAccountId: 'n1', conversationId: conv, threadId: 'u' + conv, customerName: name,
  start: t(startMinAgo), replyAt: replyAfterMin == null ? null : new Date(t(startMinAgo).getTime() + replyAfterMin * 60_000), replyVia: via,
});

describe('summarizeTurns', () => {
  it('đếm trả lời, trung bình / trung vị, trong 5 / 15 / 30 phút, chậm, AI, khách đang chờ', () => {
    const s = R.summarizeTurns([
      turn('a', 300, 2), turn('a', 200, 10), turn('b', 250, 45), turn('c', 240, 1, 'automation'),
      turn('d', 90, null, 'user', 'Chị Lan'), turn('e', 10, null),
    ], NOW, 30);
    expect(s.customers).toBe(5);
    expect(s.turns).toBe(6);
    expect(s.answered).toBe(4);
    expect(s.answeredByAi).toBe(1);
    expect(s.within5).toBe(2);
    expect(s.within15).toBe(3);
    expect(s.withinSlow).toBe(3);
    expect(s.slow).toBe(2); // b trả lời sau 45p + d chờ 90p (e mới chờ 10p, chưa tính chậm)
    expect(s.avgMinutes).toBe(14.5);
    expect(s.medianMinutes).toBe(6);
    expect(s.waiting).toEqual([{ name: 'Chị Lan', minutes: 90, conversationId: 'd' }]);
  });

  it('trả lời sau 24 giờ không tính là trả lời', () => {
    const s = R.summarizeTurns([turn('a', 3000, 1500)], NOW, 30);
    expect(s.answered).toBe(0);
    expect(s.slow).toBe(1);
  });

  it('formatResponseReport: tổng + từng nick + khách chờ lâu nhất kèm link', () => {
    const sum = R.summarizeTurns([turn('a', 100, 3), turn('d', 90, null, 'user', 'Chị Lan')], NOW, 30);
    const txt = R.formatResponseReport({
      from: t(600), to: NOW, slowMinutes: 30,
      nicks: [{ zaloAccountId: 'n1', nick: 'Minh Mẫn', staff: ['Dương Minh Mẫn'], ...sum }],
      total: { ...sum, waiting: sum.waiting.length },
    }, 'Nhân viên phản hồi khách hôm nay', 'https://crm.x');
    expect(txt).toContain('Minh Mẫn</b> (Dương Minh Mẫn): 2 khách · trả lời 50%');
    expect(txt).toContain('Chị Lan · Minh Mẫn · chờ 1g30 · https://crm.x/chat/d');
  });

  it('vnDayStart: nửa đêm giờ VN', () => {
    expect(R.vnDayStart(NOW).toISOString()).toBe('2026-09-27T17:00:00.000Z');
    expect(R.vnDayStart(NOW, 7).toISOString()).toBe('2026-09-20T17:00:00.000Z');
  });
});

describe('fmtMin', () => {
  it('phút / giờ / ngày', () => {
    expect(R.fmtMin(12)).toBe('12p');
    expect(R.fmtMin(90)).toBe('1g30');
    expect(R.fmtMin(176 * 60 + 13)).toBe('7 ngày 8g');
    expect(R.fmtMin(null)).toBe('—');
  });
});

/**
 * conversation-search.test.ts — tìm hội thoại không dấu, 1 phần từ.
 */
import { describe, it, expect, vi } from 'vitest';
vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: {} }));
const S = await import('../src/modules/chat/conversation-search.js');

describe('tìm kiếm hội thoại', () => {
  it('bỏ dấu tiếng Việt, thường hoá', () => {
    expect(S.foldVi('Nguyễn Tiến')).toBe('nguyen tien');
    expect(S.foldVi('THUỶ QUỲNH – Đồ Chơi')).toBe('thuy quynh – do choi');
    expect(S.foldVi('Mẹ Đồ La')).toBe('me do la');
  });
  it('tách từ khoá, bỏ ký tự đại diện SQL, tối đa 6 từ', () => {
    expect(S.searchTokens('  Nguyễn   tiến ')).toEqual(['nguyen', 'tien']);
    expect(S.searchTokens('50% off_now')).toEqual(['50', 'off', 'now']);
    expect(S.searchTokens('a b c d e f g h')).toHaveLength(6);
    expect(S.searchTokens('   ')).toEqual([]);
  });
});

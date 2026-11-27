import { describe, it, expect } from 'vitest';
import { findDuplicate, jaccard, normalize } from '@/lib/similarity';
import { parseCsv, parseCsvObjects, toCsv } from '@/lib/csv';

describe('phát hiện ý tưởng trùng', () => {
  it('bỏ dấu & chuẩn hoá', () => { expect(normalize('Đám Cưới 100 Triệu!')).toBe('dam cuoi 100 trieu'); });
  it('bắt trùng gần giống, không bắt ý tưởng khác', () => {
    const ex = [{ id: '1', title: '3 khoản chi nhỏ âm thầm ăn lợi nhuận của chủ nhà rạp' }, { id: '2', title: 'Một ngày ở kho Trang Tùng Khang' }];
    expect(findDuplicate('Ba khoản chi nhỏ âm thầm ăn lợi nhuận chủ nhà rạp', ex)?.id).toBe('1');
    expect(findDuplicate('Cách chọn đèn chùm cho lễ đường', ex)).toBeNull();
    expect(jaccard('a b c', 'a b c')).toBe(1);
  });
});

describe('CSV', () => {
  it('xuất/nhập giữ nguyên dấu phẩy, ngoặc kép, xuống dòng, tiếng Việt', () => {
    const rows = [{ name: 'Nguyễn "Ly" Vân, CEO', note: 'dòng 1\ndòng 2', n: 5 }];
    const back = parseCsvObjects(toCsv(rows));
    expect(back[0].name).toBe('Nguyễn "Ly" Vân, CEO');
    expect(back[0].note).toBe('dòng 1\ndòng 2');
  });
  it('chống CSV/formula injection', () => {
    const out = toCsv([{ a: '=HYPERLINK("http://evil")', b: '+1', c: 'ok' }]);
    expect(out).toContain("'=HYPERLINK");
    expect(out).toContain("'+1");
  });
  it('bỏ BOM và dòng trống, hỗ trợ CRLF', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n\r\n3,4\r\n')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
});

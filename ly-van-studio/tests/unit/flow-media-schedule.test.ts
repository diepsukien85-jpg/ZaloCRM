import { describe, it, expect } from 'vitest';
import { buildAllFlowPrompts, buildFlowPrompt, buildSrt, fmtSrtTime, snapFlowDuration } from '@/lib/services/flow';
import { sniffMatches, validateUpload, assetPath, signAsset, verifyAssetSig } from '@/lib/services/media';
import { dueKey } from '@/lib/services/schedule';
import { buildZip, crc32 } from '@/lib/zip';
import { canTransition, selectIdeas } from '@/lib/services/content';
import { demoIdeas } from '@/lib/ai/demo';

const scene = (n: number, d = 8) => ({ scene_no: n, duration_sec: d, shot_description: `cảnh ${n}`, dialogue: `lời ${n}`, voiceover: '', camera: 'cận', lighting: 'mềm', audio: 'nhạc', environment: 'kho', outfit: 'áo trắng' });

describe('prompt Google Flow', () => {
  it('có đủ các trường bắt buộc & tag @me khi đã thiết lập', () => {
    const p = buildFlowPrompt(scene(1), { character: { name: 'Ly Vân', tag: 'me', consent_confirmed: true }, aspectRatio: '9:16' });
    for (const k of ['Character reference: @me', 'Identity consistency', 'Outfit', 'Environment', 'Camera movement', 'Lighting', 'Action', 'Dialogue', 'Audio', 'Aspect ratio: 9:16', 'Duration: 8', 'Continuity', 'Negative constraints']) expect(p).toContain(k);
  });
  it('cảnh sau tham chiếu cảnh trước; cảnh thiếu consent bị cảnh báo', () => {
    const [a, b] = buildAllFlowPrompts([scene(1), scene(2)], { character: { name: 'X', consent_confirmed: false }, aspectRatio: '16:9' });
    expect(a.prompt).toContain('Cảnh mở đầu');
    expect(b.prompt).toContain('Tiếp nối cảnh 1');
    expect(b.prompt).toContain('chưa xác nhận được cấp quyền');
  });
  it('làm tròn thời lượng về mốc 4/6/8/10', () => { expect(snapFlowDuration(5)).toBe(4); expect(snapFlowDuration(7)).toBe(6); expect(snapFlowDuration(30)).toBe(10); });
  it('SRT đúng timeline cộng dồn', () => {
    const srt = buildSrt([scene(1, 4), { ...scene(2, 6), dialogue: '' }, scene(3, 5)]);
    expect(srt).toContain('00:00:00,000 --> 00:00:04,000');
    expect(srt).toContain('00:00:10,000 --> 00:00:15,000');
    expect(fmtSrtTime(3725.5)).toBe('01:02:05,500');
  });
});

describe('upload an toàn', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  it('chấp nhận ảnh hợp lệ', () => { expect(validateUpload('a.png', 'image/png', 100, png)).toBe('image'); });
  it('chặn MIME lạ/SVG/HTML/exe, sai phần mở rộng, sai magic bytes, quá lớn, rỗng', () => {
    expect(() => validateUpload('a.svg', 'image/svg+xml', 10, png)).toThrow();
    expect(() => validateUpload('a.html', 'text/html', 10, png)).toThrow();
    expect(() => validateUpload('a.exe', 'image/png', 10, png)).toThrow(/mở rộng/);
    expect(() => validateUpload('a.png', 'image/png', 10, Buffer.from('<script>alert(1)</script>'))).toThrow(/không khớp/);
    expect(() => validateUpload('a.png', 'image/png', 999_999_999, png)).toThrow(/giới hạn/);
    expect(() => validateUpload('a.png', 'image/png', 0, png)).toThrow();
    expect(sniffMatches('application/pdf', Buffer.from('%PDF-1.7'))).toBe(true);
  });
  it('chống path traversal', () => { expect(() => assetPath('../../etc/passwd')).toThrow(); });
  it('signed URL: hợp lệ, hết hạn, bị sửa', () => {
    const u = new URL('http://x' + signAsset('abc', 60));
    expect(verifyAssetSig('abc', u.searchParams.get('exp'), u.searchParams.get('sig'))).toBe(true);
    expect(verifyAssetSig('abd', u.searchParams.get('exp'), u.searchParams.get('sig'))).toBe(false);
    const old = new URL('http://x' + signAsset('abc', -10));
    expect(verifyAssetSig('abc', old.searchParams.get('exp'), old.searchParams.get('sig'))).toBe(false);
  });
});

describe('lịch tự động', () => {
  const base = { workflow_key: 'daily', hour: 7, minute: 0, weekday: null, day_of_month: null, timezone: 'Asia/Ho_Chi_Minh', last_run_at: null };
  it('chưa tới giờ VN thì không chạy; qua giờ thì chạy đúng một lần mỗi ngày', () => {
    expect(dueKey(base, new Date('2026-11-27T23:30:00Z'))).toBeNull(); // 06:30 ICT
    const k = dueKey(base, new Date('2026-11-28T00:05:00Z')); // 07:05 ICT 28/11
    expect(k).toBe('sched:daily:2026-11-28');
    expect(dueKey({ ...base, last_run_at: '2026-11-28T00:05:00Z' }, new Date('2026-11-28T05:00:00Z'))).toBeNull();
  });
  it('weekly chỉ chạy đúng thứ; monthly đúng ngày', () => {
    const wk = { ...base, workflow_key: 'weekly', weekday: 1 }; // thứ Hai
    expect(dueKey(wk, new Date('2026-11-30T02:00:00Z'))).not.toBeNull(); // Mon 30/11
    expect(dueKey(wk, new Date('2026-12-01T02:00:00Z'))).toBeNull(); // Tue
    const mo = { ...base, workflow_key: 'monthly', day_of_month: 1 };
    expect(dueKey(mo, new Date('2026-12-01T02:00:00Z'))).not.toBeNull();
    expect(dueKey(mo, new Date('2026-12-02T02:00:00Z'))).toBeNull();
  });
});

describe('ZIP & máy trạng thái & chọn ý tưởng', () => {
  it('crc32 chuẩn', () => { expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926); });
  it('ZIP có chữ ký PK và số entry đúng', () => {
    const z = buildZip([{ name: 'a.txt', data: 'xin chào' }, { name: 'b.txt', data: 'x' }]);
    expect(z.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(z.readUInt16LE(z.length - 22 + 10)).toBe(2);
  });
  it('không cho nhảy cóc trạng thái', () => {
    expect(canTransition('draft', 'approved')).toBe(false);
    expect(canTransition('draft', 'published')).toBe(false);
    expect(canTransition('pending_review', 'approved')).toBe(true);
    expect(canTransition('approved', 'scheduled')).toBe(true);
    expect(canTransition('published', 'draft')).toBe(false);
  });
  it('chọn ý tưởng bám tỷ trọng trụ cột', () => {
    const batch = demoIdeas(30, [{ name: 'Kinh doanh & tiền bạc', weight: 30 }, { name: 'Đám cưới & thẩm mỹ', weight: 25 }, { name: 'Cuộc sống & gia đình', weight: 15 }, { name: 'Hậu trường doanh nghiệp', weight: 15 }, { name: 'AI & phát triển bản thân', weight: 10 }, { name: 'Sản phẩm & bán hàng', weight: 5 }], []);
    const items = batch.ideas.map((i) => ({ ...i, total: Object.values(i.scores).reduce((a, b) => a + b, 0) }));
    const pillars = [...new Set(items.map((i) => i.pillar))];
    expect(pillars.length).toBe(6);
    const sel = selectIdeas(items, 10, [{ name: 'Kinh doanh & tiền bạc', weight: 30 }, { name: 'Đám cưới & thẩm mỹ', weight: 25 }, { name: 'Cuộc sống & gia đình', weight: 15 }, { name: 'Hậu trường doanh nghiệp', weight: 15 }, { name: 'AI & phát triển bản thân', weight: 10 }, { name: 'Sản phẩm & bán hàng', weight: 5 }]);
    expect(sel).toHaveLength(10);
    expect(sel.filter((i) => i.pillar === 'Sản phẩm & bán hàng').length).toBeLessThanOrEqual(2); // không biến thành catalogue
  });
});

/**
 * media-routes.test.ts — route phục vụ ảnh/video chat (thay CDN R2 từ 2026-09-22).
 *
 * Kiểm cả nhánh Range: video trong khung chat không tua được nếu route trả 200
 * cho mọi request thay vì 206.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MEDIA_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalocrm-media-route-'));
process.env.MEDIA_DIR = MEDIA_DIR;

vi.mock('../src/shared/storage/drive-media.js', () => ({
  isAvailable: () => false,
  whyUnavailable: () => 'test: Drive tắt',
  uploadKey: async () => null,
  findFileId: async () => null,
  downloadKey: async () => false,
  listKeysSince: async () => [],
  accountEmail: async () => null,
  storageQuota: async () => null,
}));

const { mediaRoutes } = await import('../src/modules/chat/media-routes.js');
const { uploadBuffer } = await import('../src/shared/storage/media-store.js');

const app = Fastify();
await app.register(mediaRoutes);
await app.ready();

const BODY = Buffer.from('0123456789abcdef');
const stored = await uploadBuffer(BODY, 'image/jpeg', 'anh.jpg');

afterAll(async () => {
  await app.close();
  await fsp.rm(MEDIA_DIR, { recursive: true, force: true });
});

describe('GET /api/v1/media/*', () => {
  it('trả đủ file với content-type theo đuôi', async () => {
    const res = await app.inject({ method: 'GET', url: stored.url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Number(res.headers['content-length'])).toBe(BODY.length);
    expect(res.rawPayload).toEqual(BODY);
  });

  it('Range bytes=4-9 trả 206 đúng lát cắt', async () => {
    const res = await app.inject({
      method: 'GET',
      url: stored.url,
      headers: { range: 'bytes=4-9' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 4-9/${BODY.length}`);
    expect(res.rawPayload).toEqual(BODY.subarray(4, 10));
  });

  it('Range hở đuôi bytes=8- chạy tới hết file', async () => {
    const res = await app.inject({ method: 'GET', url: stored.url, headers: { range: 'bytes=8-' } });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload).toEqual(BODY.subarray(8));
  });

  it('Range âm bytes=-4 lấy 4 byte cuối', async () => {
    const res = await app.inject({ method: 'GET', url: stored.url, headers: { range: 'bytes=-4' } });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload).toEqual(BODY.subarray(BODY.length - 4));
  });

  it('Range vô nghĩa thì trả nguyên file, không 500', async () => {
    const res = await app.inject({ method: 'GET', url: stored.url, headers: { range: 'items=1-2' } });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(BODY);
  });

  it('key vượt thư mục bị chặn ở 400, không đọc ra ngoài kho', async () => {
    for (const bad of [
      '/api/v1/media/../../../etc/passwd',
      '/api/v1/media/2026-09-22/..%2F..%2F..%2Fetc%2Fpasswd',
      '/api/v1/media/etc/passwd',
    ]) {
      const res = await app.inject({ method: 'GET', url: bad });
      expect([400, 404], bad).toContain(res.statusCode);
      expect(res.rawPayload.toString(), bad).not.toContain('root:');
    }
  });

  it('không có file, Drive cũng tắt → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/media/2026-09-22/khong-co.jpg' });
    expect(res.statusCode).toBe(404);
  });
});

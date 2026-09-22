/**
 * media-routes.ts — phục vụ ảnh/video/file của khung chat từ kho đĩa + Drive.
 *
 * Thay chỗ của CDN R2 cũ (crmcdn.shinsulab.com) từ 2026-09-22.
 *
 * KHÔNG đòi đăng nhập — cố ý, và đúng bằng mức bảo mật của bucket R2 trước đây:
 * thẻ <img>/<video> của trình duyệt không gửi được header Authorization, còn
 * đường dẫn thì chứa UUID v4 ngẫu nhiên nên không đoán ra. Muốn siết hơn thì
 * phải ký URL, và phải làm kèm một lượt chuyển đổi dữ liệu cũ trong DB.
 *
 * File không còn trên đĩa (đã dọn theo hạn) sẽ được kéo về từ Drive ngay trong
 * request đầu tiên, rồi nằm lại đĩa cho các lượt sau.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { authMiddleware } from '../auth/auth-middleware.js';
import { config } from '../../config/index.js';
import { ensureLocalFile, freeDiskBytes, isValidKey } from '../../shared/storage/media-store.js';
import { reconcileOnce, syncCounters } from '../../shared/storage/media-sync.js';
import * as drive from '../../shared/storage/drive-media.js';
import { logger } from '../../shared/utils/logger.js';

/** Bản nóng giữ 7 ngày ở trình duyệt; nội dung sau một key là bất biến. */
const CACHE_CONTROL = 'private, max-age=604800';

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
};

function contentTypeFor(key: string): string {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream';
}

/** Đọc header Range dạng `bytes=start-end`. Trả null nếu không có / không hiểu. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (!rawStart && !rawEnd) return null;

  // `bytes=-500` = 500 byte CUỐI file.
  let start = rawStart ? Number(rawStart) : size - Number(rawEnd);
  let end = rawStart ? (rawEnd ? Number(rawEnd) : size - 1) : size - 1;
  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
  return { start, end };
}

export async function mediaRoutes(app: FastifyInstance) {
  app.get('/api/v1/media/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = (request.params as Record<string, string>)['*'] || '';
    let key: string;
    try {
      key = decodeURIComponent(raw);
    } catch {
      return reply.status(400).send({ error: 'Bad media key' });
    }
    if (!isValidKey(key)) return reply.status(400).send({ error: 'Bad media key' });

    const filePath = await ensureLocalFile(key);
    if (!filePath) return reply.status(404).send({ error: 'Media not found' });

    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch {
      return reply.status(404).send({ error: 'Media not found' });
    }

    const contentType = contentTypeFor(key);
    reply.header('Cache-Control', CACHE_CONTROL);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', contentType);

    // Video cần Range thì tua mới chạy được; ảnh gần như luôn đi nhánh full.
    const range = parseRange(request.headers.range, size);
    if (range) {
      reply.status(206);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      reply.header('Content-Length', range.end - range.start + 1);
      return reply.send(createReadStream(filePath, { start: range.start, end: range.end }));
    }

    reply.header('Content-Length', size);
    return reply.send(createReadStream(filePath));
  });
}

/** Route quản trị cho kho media — CÓ đăng nhập, tách hẳn khỏi đường phục vụ file. */
export async function mediaAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  app.get('/api/v1/media-sync/status', async () => {
    const reason = drive.whyUnavailable();
    const [email, quota, freeBytes] = await Promise.all([
      reason ? null : drive.accountEmail(),
      reason ? null : drive.storageQuota(),
      freeDiskBytes(),
    ]);
    const gb = (n: number) => Math.round((n / 1024 ** 3) * 10) / 10;
    return {
      driveReady: !reason,
      reason,
      account: email,
      drive: quota && {
        usedGb: gb(quota.usage),
        limitGb: quota.limit ? gb(quota.limit) : null,
        freeGb: quota.limit ? gb(quota.limit - quota.usage) : null,
      },
      disk: {
        freeGb: freeBytes >= 0 ? gb(freeBytes) : null,
        minFreeGb: config.mediaMinFreeGb,
        retentionDays: config.mediaLocalRetentionDays,
      },
      queue: syncCounters(),
    };
  });

  app.post('/api/v1/media-sync/run', async (_request, reply) => {
    try {
      return await reconcileOnce();
    } catch (err) {
      logger.error('[media-routes] chạy đối chiếu lỗi:', err);
      return reply.status(500).send({ error: (err as Error).message });
    }
  });
}

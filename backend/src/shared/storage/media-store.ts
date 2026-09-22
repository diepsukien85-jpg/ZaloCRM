/**
 * media-store.ts — kho ảnh / video / file của khung chat.
 *
 * Thay Cloudflare R2 từ 2026-09-22 để cắt chi phí Cloudflare. Mô hình mới:
 *   BẢN GỐC  nằm trên ĐĨA của máy chạy zalocrm (MEDIA_DIR)
 *   BẢN SAO  nằm trên Google Drive, đồng bộ HAI CHIỀU (xem media-sync.ts)
 *     ghi  → đĩa ngay lập tức → xếp hàng đẩy lên Drive ở nền (không chặn gửi tin)
 *     đọc  → đĩa; nếu đã bị dọn theo hạn thì kéo lại từ Drive rồi cache xuống đĩa
 *
 * `key` giữ NGUYÊN dạng cũ của R2: `YYYY-MM-DD/<uuid>.<ext>`. Cây thư mục trên
 * Drive soi gương đúng cấu trúc đó, nên không cần bảng ánh xạ key→fileId trong DB.
 *
 * URL trả ra là ĐƯỜNG DẪN TƯƠNG ĐỐI `/api/v1/media/<key>` — KHÔNG phải URL tuyệt
 * đối. Lý do: APP_URL trên máy này là http://127.0.0.1:3080 (đứng sau Cloudflare
 * Tunnel), nhúng vào DB thì trình duyệt ngoài Internet tải không nổi. Đường dẫn
 * tương đối luôn bám đúng origin mà người dùng đang mở.
 *
 * Mức bảo mật BẰNG ĐÚNG R2 trước đây (bucket public, khóa là UUID ngẫu nhiên):
 * đường dẫn chứa UUID v4 không đoán được, route phục vụ không đòi đăng nhập —
 * bắt buộc, vì thẻ <img> của trình duyệt không gửi kèm header Authorization.
 */
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { extname } from 'node:path';
import { config } from '../../config/index.js';
import { logger } from '../utils/logger.js';
import * as drive from './drive-media.js';

/** Tiền tố route phục vụ file. Đổi ở đây là đổi cả FE lẫn DB ghi mới. */
export const MEDIA_URL_PREFIX = '/api/v1/media/';

export interface UploadResult {
  key: string;
  url: string;
  size: number;
  mimeType: string;
}

/** Thư mục gốc trên đĩa, đã quy về đường dẫn tuyệt đối. */
export function mediaRoot(): string {
  return path.isAbsolute(config.mediaDir)
    ? config.mediaDir
    : path.resolve(process.cwd(), config.mediaDir);
}

export function publicUrlForKey(key: string): string {
  return MEDIA_URL_PREFIX + key;
}

/**
 * Key hợp lệ đúng một dạng: `YYYY-MM-DD/<tên file không có dấu />`.
 * Chặn đường dẫn vượt thư mục (`..`, `/`, byte NUL) TRƯỚC khi ghép vào fs path —
 * key đến từ URL do người ngoài gọi, không được tin.
 */
export function isValidKey(key: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(key) && !key.includes('..');
}

export function localPathForKey(key: string): string {
  if (!isValidKey(key)) throw new Error(`Key media không hợp lệ: ${key}`);
  return path.join(mediaRoot(), key);
}

/** URL/giá trị này có phải do kho của mình phát ra không (kể cả kho cũ). */
export function isManagedMediaUrl(value: string): boolean {
  if (value.startsWith(MEDIA_URL_PREFIX)) return true;
  // URL kho cũ còn tồn trong DB: R2 qua crmcdn.shinsulab.com, và MinIO thời 2026-08.
  if (config.s3PublicUrl && value.startsWith(`${config.s3PublicUrl}/`)) return true;
  if (config.s3Endpoint && value.startsWith(`${config.s3Endpoint}/`)) return true;
  return value.includes('127.0.0.1:9000/');
}

/** Rút key ra từ URL kho mới (tương đối hoặc tuyệt đối). null nếu không phải. */
export function keyFromUrl(value: string): string | null {
  let pathname = value;
  if (/^https?:\/\//i.test(value)) {
    try {
      pathname = new URL(value).pathname;
    } catch {
      return null;
    }
  }
  if (!pathname.startsWith(MEDIA_URL_PREFIX)) return null;
  const key = decodeURIComponent(pathname.slice(MEDIA_URL_PREFIX.length));
  return isValidKey(key) ? key : null;
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'video/mp4': return '.mp4';
    case 'video/quicktime': return '.mov';
    case 'video/webm': return '.webm';
    case 'audio/mpeg': return '.mp3';
    case 'audio/mp4': return '.m4a';
    case 'audio/ogg': return '.ogg';
    case 'application/pdf': return '.pdf';
    default: return '';
  }
}

/** Phần mở rộng an toàn cho tên file trên đĩa: chỉ chữ/số, tối đa 12 ký tự. */
function safeExt(originalName: string | undefined, mimeType: string): string {
  const raw = originalName ? extname(originalName) : '';
  const cleaned = /^\.[A-Za-z0-9]{1,12}$/.test(raw) ? raw.toLowerCase() : '';
  return cleaned || mimeToExt(mimeType);
}

/**
 * Ghi buffer vào kho. Trả về ngay khi đĩa đã ghi xong — việc đẩy lên Drive chạy
 * ở nền để không làm chậm thao tác gửi tin của nhân viên.
 *
 * Giữ nguyên chữ ký + hình dạng trả về của `r2-client.uploadBuffer` cũ nên mọi
 * nơi gọi (chat-attachment-routes, message-handler) không phải đổi gì.
 */
export async function uploadBuffer(
  buffer: Buffer,
  mimeType: string,
  originalName?: string,
): Promise<UploadResult> {
  // Lưới chắn cuối: file media 0 byte không bao giờ là thứ hợp lệ, mà lưu nó thì
  // url gốc bị ghi đè và ảnh hỏng vĩnh viễn. Nguồn lỗi chính đã chặn ở
  // message-handler, đây là lớp phòng hờ cho mọi đường ghi khác.
  if (buffer.length === 0) {
    throw new Error('Từ chối lưu media rỗng (0 byte)');
  }

  const day = new Date().toISOString().slice(0, 10);
  const key = `${day}/${randomUUID()}${safeExt(originalName, mimeType)}`;
  const dest = localPathForKey(key);

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, buffer);

  // Nạp trễ để tránh vòng import (media-sync cũng import media-store).
  const { enqueueUpload } = await import('./media-sync.js');
  enqueueUpload(key, mimeType);

  return { key, url: publicUrlForKey(key), size: buffer.length, mimeType };
}

/**
 * Bảo đảm file có mặt trên đĩa, kéo từ Drive nếu thiếu. Trả đường dẫn, hoặc null
 * khi không còn ở đâu cả. Nhiều request cùng đòi một key đang tải → gộp chung
 * một lượt tải nhờ map `inflight`.
 */
const inflight = new Map<string, Promise<string | null>>();

export async function ensureLocalFile(key: string): Promise<string | null> {
  if (!isValidKey(key)) return null;
  const localPath = localPathForKey(key);
  try {
    await fsp.access(localPath);
    return localPath;
  } catch {
    /* chưa có trên đĩa → thử Drive */
  }

  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    try {
      const ok = await drive.downloadKey(key, localPath);
      if (ok) logger.info(`[media-store] kéo lại từ Drive: ${key}`);
      return ok ? localPath : null;
    } catch (err) {
      logger.warn(`[media-store] kéo từ Drive lỗi (${key}):`, (err as Error).message);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

/**
 * Chuyển URL media thành đường dẫn đĩa, kéo từ Drive nếu cần.
 * Dùng cho các chỗ SERVER tự đọc lại file (chuyển tiếp tin nhắn, gửi lại ảnh…) —
 * đọc thẳng đĩa thay vì tự gọi HTTP vào chính mình.
 */
export async function localPathForUrl(url: string): Promise<string | null> {
  const key = keyFromUrl(url);
  return key ? ensureLocalFile(key) : null;
}

/** Danh sách mọi key đang nằm trên đĩa (quét 2 cấp: <ngày>/<file>). */
export async function listLocalKeys(): Promise<string[]> {
  const root = mediaRoot();
  const keys: string[] = [];
  let days: string[];
  try {
    days = await fsp.readdir(root);
  } catch {
    return keys;
  }
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    let names: string[];
    try {
      names = await fsp.readdir(path.join(root, day));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.includes('.part-')) continue; // file đang tải dở
      const key = `${day}/${name}`;
      if (isValidKey(key)) keys.push(key);
    }
  }
  return keys;
}

/** Số byte còn trống trên phân vùng chứa kho. -1 nếu không đọc được. */
export async function freeDiskBytes(): Promise<number> {
  try {
    const s = await fsp.statfs(mediaRoot());
    return s.bavail * s.bsize;
  } catch {
    return -1;
  }
}

/**
 * Dọn bản nóng trên đĩa: xoá các thư mục ngày cũ hơn hạn giữ.
 * Trả về số file đã xoá. MEDIA_LOCAL_RETENTION_DAYS = 0 → không dọn.
 *
 * BÌNH THƯỜNG chỉ xoá file đã có bản sao trên Drive — mất bản gốc khi chưa kịp
 * sao lưu là mất hẳn.
 *
 * NHƯNG khi đĩa tụt dưới MEDIA_MIN_FREE_GB thì chuyển sang CHẾ ĐỘ CỨU ĐĨA:
 * xoá ngày cũ nhất trước, KHÔNG chờ xác nhận Drive và KHÔNG tôn trọng hạn giữ
 * (trừ ngày hôm nay — đang có người xem), cho tới khi chỗ trống vượt ngưỡng lại.
 *
 * Vì sao phải phá cả hạn giữ: đo 22/09/2026 là ~19 GiB/ngày, ngày cao điểm 24
 * GiB. Máy còn 77 GiB trống, mà giữ 3 ngày cao điểm đã là 73 GiB. Nếu chỉ xoá
 * được file "quá hạn" thì đúng ngày cao điểm sẽ không có gì để xoá và ổ đầy,
 * kéo sập cả Mac mini. Mất ảnh cũ vẫn hơn mất máy — và ảnh vẫn còn trên Drive.
 */
export async function pruneLocalCache(): Promise<number> {
  const days = config.mediaLocalRetentionDays;
  if (!days || days <= 0) return 0;

  const floor = config.mediaMinFreeGb * 1024 ** 3;
  const free = await freeDiskBytes();
  const lowDisk = free >= 0 && free < floor;
  const driveOn = drive.isAvailable();

  if (!driveOn && !lowDisk) return 0; // chưa có nơi sao lưu, đĩa còn rộng → giữ nguyên
  if (lowDisk) {
    logger.warn(
      `[media-store] ĐĨA SẮP ĐẦY — còn ${(free / 1024 ** 3).toFixed(1)}GB ` +
      `(ngưỡng ${config.mediaMinFreeGb}GB). Dọn ngày cũ nhất trước, bỏ qua hạn giữ và Drive.`,
    );
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const root = mediaRoot();
  let removed = 0;

  let dirNames: string[];
  try {
    dirNames = await fsp.readdir(root);
  } catch {
    return 0;
  }

  for (const day of dirNames.sort()) {   // ngày cũ nhất trước — giải phóng chỗ sớm nhất
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    // Cứu đĩa: ngày hôm nay luôn được giữ (nhân viên đang mở xem), còn lại xoá
    // dần từ cũ nhất. Kiểm tra chỗ trống ở CUỐI mỗi vòng, không phải đầu —
    // kiểm tra ở đầu thì ngày cũ nhất thoát được mà chỗ vẫn chưa hồi.
    if (lowDisk ? day >= today : day >= cutoff) continue;
    let names: string[];
    try {
      names = await fsp.readdir(path.join(root, day));
    } catch {
      continue;
    }
    // Hỏi Drive MỘT lần cho cả ngày rồi đối chiếu trong bộ nhớ. Ở mức ~148k
    // file/ngày, hỏi từng file là 148k lượt gọi API — cách này chỉ ~150 lượt.
    let onDrive: Set<string> | null = null;
    if (!lowDisk) {
      try {
        onDrive = await drive.listNamesForDay(day);
      } catch (err) {
        logger.warn(`[media-store] không liệt kê được Drive ngày ${day}:`, (err as Error).message);
        continue;   // không biết Drive có gì thì KHÔNG xoá — để lượt sau
      }
      if (!onDrive) continue;   // Drive chưa có thư mục ngày này → chưa sao lưu gì
    }

    let allRemoved = true;
    for (const name of names) {
      const key = `${day}/${name}`;
      if (!isValidKey(key)) { allRemoved = false; continue; }
      if (onDrive && !onDrive.has(name)) {
        allRemoved = false;   // chưa lên Drive → để lượt sau, trừ khi đĩa nguy cấp
        continue;
      }
      try {
        await fsp.rm(path.join(root, day, name), { force: true });
        removed += 1;
      } catch (err) {
        allRemoved = false;
        logger.warn(`[media-store] dọn ${key} lỗi:`, (err as Error).message);
      }
    }
    // Thư mục ngày chỉ gỡ khi đã rỗng hẳn.
    if (allRemoved) await fsp.rmdir(path.join(root, day)).catch(() => {});

    // Cứu đĩa xong thì dừng ngay — không xoá sạch cả kho vì một lúc chật.
    if (lowDisk && (await freeDiskBytes()) >= floor) break;
  }

  if (removed) {
    const vi_sao = lowDisk ? 'chế độ cứu đĩa' : `cũ hơn ${days} ngày`;
    logger.info(`[media-store] dọn ${removed} file (${vi_sao})`);
  }
  return removed;
}

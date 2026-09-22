/**
 * media-sync.ts — đồng bộ HAI CHIỀU giữa kho đĩa của zalocrm và Google Drive.
 *
 *   đĩa → Drive : hàng đợi nền, chạy ngay sau mỗi lần ghi file mới (enqueueUpload).
 *                 Thất bại thì thử lại theo cấp số nhân, không chặn luồng gửi tin.
 *   Drive → đĩa : vòng quét định kỳ kéo về các file CHỈ có trên Drive — nhờ đó ảnh
 *                 Sếp bỏ tay vào thư mục Drive cũng hiện được trong zalocrm, và
 *                 máy cài lại cũng tự lấy lại kho cũ.
 *
 * Vòng quét còn làm hai việc dọn dẹp:
 *   - bắt kịp các file trên đĩa chưa kịp lên Drive (mất mạng, Drive lỗi…)
 *   - gỡ bản nóng quá hạn trên đĩa, CHỈ khi Drive đã có bản sao
 *
 * Chưa cấu hình Drive → mọi thứ ở đây im lặng đứng yên, zalocrm chạy chế độ
 * chỉ-đĩa-cục-bộ và không có gì hỏng.
 */
import path from 'node:path';
import { config } from '../../config/index.js';
import { logger } from '../utils/logger.js';
import * as drive from './drive-media.js';
import {
  ensureLocalFile,
  isValidKey,
  listLocalKeys,
  localPathForKey,
  pruneLocalCache,
} from './media-store.js';

interface QueueItem {
  key: string;
  mimeType: string;
  attempts: number;
}

/** Hàng đợi đang ùn bao nhiêu — route trạng thái đọc số này. */
export function queueDepth(): number {
  return queue.length;
}

/** Số file đã đẩy / hỏng kể từ lúc khởi động. */
export function syncCounters(): { uploaded: number; failed: number; queued: number } {
  return { ...counters, queued: queue.length };
}

const queue: QueueItem[] = [];
const queued = new Set<string>();
/** Số nhánh drain đang chạy — trần là config.mediaUploadConcurrency. */
let workers = 0;
let timer: NodeJS.Timeout | null = null;
/** Đếm dồn để log nhịp, thay vì mỗi file một dòng (148k dòng/ngày là vô dụng). */
const counters = { uploaded: 0, failed: 0 };

const MAX_ATTEMPTS = 5;
/** Chờ 5s, 15s, 45s, 135s giữa các lần thử lại. */
function backoffMs(attempts: number): number {
  return 5_000 * 3 ** (attempts - 1);
}

function mimeFromExt(key: string): string {
  switch (path.extname(key).toLowerCase()) {
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.mp4': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.webm': return 'video/webm';
    case '.mp3': return 'audio/mpeg';
    case '.m4a': return 'audio/mp4';
    case '.ogg': return 'audio/ogg';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

/**
 * Xếp một key vừa ghi xuống đĩa vào hàng đợi đẩy lên Drive.
 * Không async, không ném lỗi — nơi gọi (đường gửi tin) không được phép chậm lại
 * hay gãy vì Drive.
 */
export function enqueueUpload(key: string, mimeType?: string): void {
  if (!drive.isAvailable() || !isValidKey(key) || queued.has(key)) return;
  queued.add(key);
  queue.push({ key, mimeType: mimeType || mimeFromExt(key), attempts: 0 });
  pump();
}

/** Mở thêm nhánh đẩy cho tới trần song song. */
function pump(): void {
  const limit = Math.max(1, config.mediaUploadConcurrency);
  while (workers < limit && queue.length > 0) {
    workers += 1;
    void drain();
  }
}

/**
 * Một nhánh đẩy: rút việc khỏi hàng đợi cho tới khi hết.
 * Chạy nhiều nhánh song song vì nối tiếp không kịp — đo 22/09/2026 là ~148k
 * file/ngày, mỗi lượt upload cỡ vài trăm ms, nối tiếp thì mất hơn 12 tiếng/ngày
 * và không còn tí dư địa nào cho ngày cao điểm.
 */
async function drain(): Promise<void> {
  try {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      queued.delete(item.key);
      try {
        // Lần đầu bỏ qua bước hỏi "Drive có chưa" — key là UUID vừa sinh.
        // Các lần thử lại thì hỏi, phòng khi lỗi xảy ra SAU khi Drive đã nhận.
        await drive.uploadKey(item.key, localPathForKey(item.key), item.mimeType, item.attempts === 0);
        counters.uploaded += 1;
      } catch (err) {
        const msg = (err as Error).message;
        item.attempts += 1;
        if (item.attempts >= MAX_ATTEMPTS) {
          // Bỏ cuộc ở đây thôi — vòng đối chiếu định kỳ sẽ nhặt lại file này.
          counters.failed += 1;
          logger.warn(`[media-sync] bỏ đẩy ${item.key} sau ${MAX_ATTEMPTS} lần: ${msg}`);
          continue;
        }
        const delay = backoffMs(item.attempts);
        setTimeout(() => {
          if (queued.has(item.key)) return;
          queued.add(item.key);
          queue.push(item);
          pump();
        }, delay).unref?.();
      }
    }
  } finally {
    workers -= 1;
  }
}

export interface ReconcileReport {
  pushed: number;   // đĩa → Drive
  pulled: number;   // Drive → đĩa
  pruned: number;   // bản nóng đã gỡ khỏi đĩa
  driveTrashed: number; // thư mục ngày đã dọn trên Drive
  window: string;   // cửa sổ ngày đã soi
  skipped?: string; // lý do không chạy
}

function dayOffset(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Trần số file kéo về mỗi lượt — chặn kịch bản kéo cả kho làm nghẽn đường mạng. */
const PULL_BUDGET = 500;

/**
 * Một lượt đối chiếu hai chiều.
 *
 * CHỈ soi `MEDIA_RECONCILE_WINDOW_DAYS` ngày gần nhất, không soi cả cửa sổ giữ
 * bản nóng: ở mức ~148k file/ngày, liệt kê trọn 3 ngày là ~450k mục mỗi lượt,
 * 15 phút một lần thì thành mấy chục nghìn lượt gọi Drive API mỗi ngày cho một
 * việc chỉ là lưới an toàn. Lỗ hổng luôn nằm ở ngày hôm nay và hôm qua.
 */
export async function reconcileOnce(): Promise<ReconcileReport> {
  const empty = { pushed: 0, pulled: 0, pruned: 0, driveTrashed: 0, window: '' };
  const why = drive.whyUnavailable();
  if (why) {
    // Drive hỏng mà đĩa sắp đầy thì vẫn phải dọn — pruneLocalCache tự lo phần đó.
    const pruned = await pruneLocalCache();
    return { ...empty, pruned, skipped: why };
  }

  const windowDays = Math.max(1, config.mediaReconcileWindowDays);
  const sinceDay = dayOffset(windowDays - 1);

  const [localAll, driveKeys] = await Promise.all([
    listLocalKeys(),
    drive.listKeysSince(sinceDay),
  ]);
  const localKeys = localAll.filter((k) => k >= sinceDay);
  const localSet = new Set(localKeys);
  const driveSet = new Set(driveKeys);

  // đĩa → Drive: file còn thiếu bản sao (mạng chập chờn lúc ghi, Drive vừa bật lại…).
  let pushed = 0;
  for (const key of localKeys) {
    if (driveSet.has(key)) continue;
    enqueueUpload(key);
    pushed += 1;
  }

  // Drive → đĩa: file chỉ có trên Drive (Sếp bỏ tay vào, hoặc máy vừa cài lại).
  let pulled = 0;
  for (const key of driveKeys) {
    if (localSet.has(key)) continue;
    if (pulled >= PULL_BUDGET) {
      logger.info(`[media-sync] còn file chờ kéo về, để lượt sau (trần ${PULL_BUDGET}/lượt)`);
      break;
    }
    if (await ensureLocalFile(key)) pulled += 1;
  }

  const pruned = await pruneLocalCache();

  // Dọn Drive theo hạn riêng — mặc định tắt (giữ mãi).
  let driveTrashed = 0;
  if (config.driveRetentionDays > 0) {
    driveTrashed = await drive.trashDayFoldersBefore(dayOffset(config.driveRetentionDays));
  }

  const window = `${sinceDay}…${dayOffset(0)}`;
  if (pushed || pulled || pruned || driveTrashed) {
    logger.info(
      `[media-sync] đối chiếu ${window} — đẩy bù ${pushed}, kéo về ${pulled}, ` +
      `dọn đĩa ${pruned}, dọn Drive ${driveTrashed} thư mục`,
    );
  }
  return { pushed, pulled, pruned, driveTrashed, window };
}

/** Bật vòng đồng bộ nền. Gọi một lần khi khởi động (app.ts). */
export function startMediaSync(): void {
  const minutes = config.mediaSyncIntervalMinutes;
  if (!minutes || minutes <= 0) {
    logger.info('[media-sync] tắt theo cấu hình (MEDIA_SYNC_INTERVAL_MINUTES=0)');
    return;
  }
  const why = drive.whyUnavailable();
  if (why) {
    // KHÔNG return: vòng này còn gánh việc dọn đĩa. Bỏ qua nó thì Mac mini đầy
    // sau vài ngày (~19 GiB/ngày), Drive có bật hay không cũng vậy.
    logger.warn(`[media-sync] Drive chưa dùng được (${why}) — chỉ chạy phần dọn đĩa`);
  }

  let lastUploaded = 0;
  const run = () => {
    reconcileOnce()
      .then(() => {
        const { uploaded, failed, queued } = syncCounters();
        const delta = uploaded - lastUploaded;
        lastUploaded = uploaded;
        if (delta || queued || failed) {
          logger.info(`[media-sync] ${delta} file lên Drive trong ${minutes}' · đang chờ ${queued} · hỏng ${failed}`);
        }
      })
      .catch((err) => logger.error('[media-sync] đối chiếu lỗi:', err));
  };
  // Chờ 30s sau khi boot cho server ổn định rồi mới đụng vào Drive.
  setTimeout(run, 30_000).unref?.();
  timer = setInterval(run, minutes * 60 * 1000);
  timer.unref?.();
  logger.info(
    `[media-sync] bật — mỗi ${minutes} phút, giữ đĩa ${config.mediaLocalRetentionDays} ngày, ` +
    `đẩy ${config.mediaUploadConcurrency} luồng`,
  );
}

export function stopMediaSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

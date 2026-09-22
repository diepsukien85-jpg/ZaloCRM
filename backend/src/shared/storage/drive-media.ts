/**
 * drive-media.ts — lớp nói chuyện với Google Drive cho kho media của khung chat.
 *
 * VÌ SAO OAUTH CHỨ KHÔNG PHẢI SERVICE ACCOUNT:
 * Google KHÔNG cho service account tạo file CÓ NỘI DUNG trong My Drive —
 * "Service Accounts do not have storage quota" (đã kiểm chứng ở dự án bot-noi-bo
 * ngày 14/09/2026). Nên phải dùng refresh token của một tài khoản Google thật:
 * chạy `npm run drive:setup` một lần, token ghi ra DRIVE_OAUTH_TOKEN.
 *
 * CHƯA CẤU HÌNH THÌ KHÔNG SAO: isAvailable() = false, cả hệ thống chạy ở chế độ
 * chỉ-đĩa-cục-bộ. Không có đường nào ở đây được phép ném lỗi ra tới người dùng.
 *
 * Cây thư mục trên Drive SOI GƯƠNG key của kho đĩa: <gốc>/<YYYY-MM-DD>/<uuid>.<ext>.
 * Nhờ vậy không cần bảng ánh xạ key→fileId trong DB — tra bằng chính tên file.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { google, type drive_v3 } from 'googleapis';
import { config } from '../../config/index.js';
import { logger } from '../utils/logger.js';

const SCOPES = ['https://www.googleapis.com/auth/drive'];

let cachedDrive: drive_v3.Drive | null = null;
let cachedRootId: string | null = null;
/** key → fileId. Chỉ cache lượt tra THÀNH CÔNG (miss có thể thành hit sau khi đẩy). */
const fileIdByKey = new Map<string, string>();
/** Thư mục ngày `YYYY-MM-DD` → folderId, tránh tra lại mỗi lần upload. */
const dayFolderIdByName = new Map<string, string>();

function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, os.homedir());
}

function readJsonSync(file: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function clientPath(): string {
  return expandHome(config.driveOauthClientPath);
}

function tokenPath(): string {
  return expandHome(config.driveOauthTokenPath);
}

/** Có đủ client JSON + refresh token để gọi Drive hay chưa. */
export function isAvailable(): boolean {
  const c = readJsonSync(clientPath());
  const t = readJsonSync(tokenPath());
  return Boolean((c?.installed || c?.web) && t?.refresh_token);
}

/** Câu giải thích ngắn khi chưa dùng được — để log/route trả cho người vận hành. */
export function whyUnavailable(): string | null {
  const c = readJsonSync(clientPath());
  if (!(c?.installed || c?.web)) return `chưa có OAuth client JSON tại ${clientPath()}`;
  if (!readJsonSync(tokenPath())?.refresh_token) {
    return 'chưa cấp quyền Drive — chạy `npm run drive:setup` trong backend/';
  }
  return null;
}

function driveClient(): drive_v3.Drive {
  if (cachedDrive) return cachedDrive;
  const clientJson = readJsonSync(clientPath());
  const cfg = clientJson?.installed || clientJson?.web;
  if (!cfg) throw new Error(`Không thấy OAuth client JSON (DRIVE_OAUTH_CLIENT=${clientPath()})`);
  const token = readJsonSync(tokenPath());
  if (!token?.refresh_token) throw new Error('Chưa có refresh token Drive — chạy `npm run drive:setup`');

  const redirect = cfg.redirect_uris?.[0] || 'http://127.0.0.1:53682/oauth2callback';
  const auth = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, redirect);
  auth.setCredentials(token);
  // Google cấp access token mới theo giờ — ghi đè lại file để lần khởi động sau
  // không phải refresh từ đầu. refresh_token giữ nguyên (Google không gửi lại).
  auth.on('tokens', (fresh) => {
    try {
      fs.writeFileSync(tokenPath(), JSON.stringify({ ...token, ...fresh }, null, 2), { mode: 0o600 });
    } catch {
      /* mất cache token không phải lỗi chí mạng */
    }
  });
  cachedDrive = google.drive({ version: 'v3', auth });
  return cachedDrive;
}

/** Thoát chuỗi cho mệnh đề `q` của Drive API (nháy đơn và backslash). */
function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findFolder(parentId: string, name: string): Promise<string | null> {
  const drive = driveClient();
  const res = await drive.files.list({
    q: `'${escapeQuery(parentId)}' in parents and mimeType = 'application/vnd.google-apps.folder' ` +
       `and name = '${escapeQuery(name)}' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? null;
}

async function ensureFolder(parentId: string, name: string): Promise<string> {
  const existing = await findFolder(parentId, name);
  if (existing) return existing;
  const created = await driveClient().files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  const id = created.data.id;
  if (!id) throw new Error(`Tạo thư mục Drive "${name}" không trả về id`);
  return id;
}

/** Thư mục gốc chứa toàn bộ media — theo DRIVE_MEDIA_FOLDER_ID, nếu trống thì theo tên. */
async function rootFolderId(): Promise<string> {
  if (cachedRootId) return cachedRootId;
  cachedRootId = config.driveMediaFolderId
    ? config.driveMediaFolderId
    : await ensureFolder('root', config.driveMediaFolderName);
  return cachedRootId;
}

/** Thư mục ngày trong gốc. `create=false` → chỉ tra, không tạo (dùng khi đọc). */
async function dayFolderId(day: string, create: boolean): Promise<string | null> {
  const cached = dayFolderIdByName.get(day);
  if (cached) return cached;
  const root = await rootFolderId();
  const id = create ? await ensureFolder(root, day) : await findFolder(root, day);
  if (id) dayFolderIdByName.set(day, id);
  return id;
}

/** Tách key `YYYY-MM-DD/uuid.ext` thành phần ngày + tên file. */
function splitKey(key: string): { day: string; name: string } | null {
  const slash = key.indexOf('/');
  if (slash <= 0) return null;
  const day = key.slice(0, slash);
  const name = key.slice(slash + 1);
  if (!day || !name || name.includes('/')) return null;
  return { day, name };
}

/**
 * Đẩy một file từ đĩa lên Drive. Trả fileId, hoặc null nếu Drive chưa cấu hình.
 *
 * `skipExistsCheck` = true (mặc định) cho đường ghi mới: key vừa sinh từ UUID nên
 * chắc chắn Drive chưa có, hỏi trước là phí đúng một lượt gọi API — ở mức ~148k
 * file/ngày thì đó là 148k lượt gọi vứt đi. Vòng đối chiếu và lượt thử lại thì
 * truyền false để tránh tải lên bản trùng.
 */
export async function uploadKey(
  key: string,
  localPath: string,
  mimeType: string,
  skipExistsCheck = true,
): Promise<string | null> {
  if (!isAvailable()) return null;
  const parts = splitKey(key);
  if (!parts) throw new Error(`Key không hợp lệ cho Drive: ${key}`);

  if (!skipExistsCheck) {
    const existing = await findFileId(key);
    if (existing) return existing;
  }

  const folderId = await dayFolderId(parts.day, true);
  if (!folderId) throw new Error(`Không tạo được thư mục Drive cho ngày ${parts.day}`);

  const res = await driveClient().files.create({
    requestBody: { name: parts.name, parents: [folderId] },
    media: { mimeType, body: fs.createReadStream(localPath) },
    fields: 'id',
    supportsAllDrives: true,
  });
  const id = res.data.id ?? null;
  if (id) fileIdByKey.set(key, id);
  return id;
}

/** Tra fileId theo key. null = Drive chưa cấu hình, hoặc chưa có bản sao. */
export async function findFileId(key: string): Promise<string | null> {
  if (!isAvailable()) return null;
  const cached = fileIdByKey.get(key);
  if (cached) return cached;
  const parts = splitKey(key);
  if (!parts) return null;

  const folderId = await dayFolderId(parts.day, false);
  if (!folderId) return null;

  const res = await driveClient().files.list({
    q: `'${escapeQuery(folderId)}' in parents and name = '${escapeQuery(parts.name)}' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const id = res.data.files?.[0]?.id ?? null;
  if (id) fileIdByKey.set(key, id);
  return id;
}

/**
 * Kéo bản sao Drive về `destPath`. Trả true nếu tải xong.
 * Ghi ra file tạm rồi rename — độc giả song song không bao giờ thấy file nửa vời.
 */
export async function downloadKey(key: string, destPath: string): Promise<boolean> {
  const fileId = await findFileId(key);
  if (!fileId) return false;

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part-${process.pid}`;
  const res = await driveClient().files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(tmpPath);
      res.data.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', () => resolve());
      res.data.pipe(ws);
    });
    await fsp.rename(tmpPath, destPath);
    return true;
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Liệt kê tên file trong ĐÚNG MỘT thư mục ngày. Trả `null` nếu Drive chưa cấu
 * hình hoặc thư mục ngày đó không tồn tại (khác hẳn với "có thư mục mà rỗng").
 *
 * Dùng khi dọn đĩa: hỏi `findFileId` từng file thì 148k file/ngày = 148k lượt
 * gọi API; liệt kê cả ngày chỉ tốn ~150 lượt (1000 file/trang) rồi đối chiếu
 * trong bộ nhớ.
 */
export async function listNamesForDay(day: string): Promise<Set<string> | null> {
  if (!isAvailable()) return null;
  const folderId = await dayFolderId(day, false);
  if (!folderId) return null;

  const drive = driveClient();
  const names = new Set<string>();
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${escapeQuery(folderId)}' in parents and trashed = false ` +
         `and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'files(id,name),nextPageToken',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      if (f.name) names.add(f.name);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return names;
}

/**
 * Liệt kê mọi key đang có trên Drive, giới hạn ở các thư mục ngày >= `sinceDay`
 * (dạng `YYYY-MM-DD`, so sánh chuỗi là đủ vì định dạng đã cố định độ dài).
 * Dùng cho vòng đối chiếu hai chiều trong media-sync.ts.
 */
export async function listKeysSince(sinceDay: string): Promise<string[]> {
  if (!isAvailable()) return [];
  const drive = driveClient();
  const root = await rootFolderId();

  const dayFolders: Array<{ id: string; name: string }> = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${escapeQuery(root)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name),nextPageToken',
      pageSize: 200,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name && f.name >= sinceDay) dayFolders.push({ id: f.id, name: f.name });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const keys: string[] = [];
  for (const folder of dayFolders) {
    dayFolderIdByName.set(folder.name, folder.id);
    let filePage: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${escapeQuery(folder.id)}' in parents and trashed = false ` +
           `and mimeType != 'application/vnd.google-apps.folder'`,
        fields: 'files(id,name),nextPageToken',
        pageSize: 1000,
        pageToken: filePage,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of res.data.files ?? []) {
        if (!f.id || !f.name) continue;
        const key = `${folder.name}/${f.name}`;
        fileIdByKey.set(key, f.id);
        keys.push(key);
      }
      filePage = res.data.nextPageToken ?? undefined;
    } while (filePage);
  }
  return keys;
}

/**
 * Ném vào thùng rác các thư mục ngày cũ hơn `beforeDay` (dạng `YYYY-MM-DD`).
 * Trả số thư mục đã dọn. Dùng khi bật DRIVE_RETENTION_DAYS.
 *
 * Cố ý `trashed: true` chứ không xoá vĩnh viễn — còn 30 ngày trong Thùng rác để
 * cứu nếu lỡ đặt sai hạn. Nhưng CŨNG vì vậy mà chỗ chỉ thực sự được trả lại sau
 * khi Thùng rác tự dọn (hoặc Sếp đổ tay).
 */
export async function trashDayFoldersBefore(beforeDay: string): Promise<number> {
  if (!isAvailable()) return 0;
  const drive = driveClient();
  const root = await rootFolderId();
  let trashed = 0;
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${escapeQuery(root)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name),nextPageToken',
      pageSize: 200,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      if (!f.id || !f.name || !/^\d{4}-\d{2}-\d{2}$/.test(f.name) || f.name >= beforeDay) continue;
      try {
        await drive.files.update({ fileId: f.id, requestBody: { trashed: true }, supportsAllDrives: true });
        dayFolderIdByName.delete(f.name);
        trashed += 1;
      } catch (err) {
        logger.warn(`[drive-media] không dọn được thư mục ${f.name}:`, (err as Error).message);
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  if (trashed) logger.info(`[drive-media] đã ném ${trashed} thư mục ngày trước ${beforeDay} vào Thùng rác`);
  return trashed;
}

/** Email tài khoản Drive đang dùng — để màn hình cấu hình hiện cho người vận hành. */
export async function accountEmail(): Promise<string | null> {
  if (!isAvailable()) return null;
  try {
    const res = await driveClient().about.get({ fields: 'user(emailAddress),storageQuota(limit,usage)' });
    return res.data.user?.emailAddress ?? null;
  } catch (err) {
    logger.warn('[drive-media] không đọc được about.get:', (err as Error).message);
    return null;
  }
}

/** Dung lượng Drive đã dùng / tổng (byte). null khi Drive chưa cấu hình. */
export async function storageQuota(): Promise<{ usage: number; limit: number | null } | null> {
  if (!isAvailable()) return null;
  try {
    const res = await driveClient().about.get({ fields: 'storageQuota(limit,usage)' });
    const q = res.data.storageQuota;
    if (!q) return null;
    return { usage: Number(q.usage ?? 0), limit: q.limit ? Number(q.limit) : null };
  } catch {
    return null;
  }
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env, appSecret } from '../env';
import { badRequest } from '../errors';

/** Danh sách cho phép: loại file + phần mở rộng. Chặn file thực thi/HTML/SVG (nguy cơ XSS). */
export const ALLOWED: Record<string, { kind: 'image' | 'video' | 'audio' | 'document'; exts: string[] }> = {
  'image/jpeg': { kind: 'image', exts: ['jpg', 'jpeg'] }, 'image/png': { kind: 'image', exts: ['png'] }, 'image/webp': { kind: 'image', exts: ['webp'] },
  'video/mp4': { kind: 'video', exts: ['mp4'] }, 'video/quicktime': { kind: 'video', exts: ['mov'] }, 'video/webm': { kind: 'video', exts: ['webm'] },
  'audio/mpeg': { kind: 'audio', exts: ['mp3'] }, 'audio/wav': { kind: 'audio', exts: ['wav'] }, 'audio/mp4': { kind: 'audio', exts: ['m4a'] }, 'audio/ogg': { kind: 'audio', exts: ['ogg'] }, 'audio/webm': { kind: 'audio', exts: ['webm'] },
  'application/pdf': { kind: 'document', exts: ['pdf'] }, 'text/plain': { kind: 'document', exts: ['txt', 'md'] }, 'text/csv': { kind: 'document', exts: ['csv'] },
};

/** Kiểm tra chữ ký (magic bytes) cho các định dạng phổ biến để không tin MIME do client khai. */
export function sniffMatches(mime: string, buf: Buffer): boolean {
  const starts = (...b: number[]) => b.every((x, i) => buf[i] === x);
  switch (mime) {
    case 'image/jpeg': return starts(0xff, 0xd8, 0xff);
    case 'image/png': return starts(0x89, 0x50, 0x4e, 0x47);
    case 'image/webp': return buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
    case 'application/pdf': return buf.subarray(0, 4).toString() === '%PDF';
    case 'video/mp4': case 'video/quicktime': case 'audio/mp4': return buf.subarray(4, 8).toString() === 'ftyp';
    case 'audio/mpeg': return buf.subarray(0, 3).toString() === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
    case 'audio/wav': return buf.subarray(0, 4).toString() === 'RIFF';
    case 'audio/ogg': return buf.subarray(0, 4).toString() === 'OggS';
    case 'video/webm': case 'audio/webm': return starts(0x1a, 0x45, 0xdf, 0xa3);
    case 'text/plain': case 'text/csv': return !buf.subarray(0, 2000).includes(0);
    default: return false;
  }
}

export function validateUpload(filename: string, mime: string, size: number, head: Buffer) {
  const a = ALLOWED[mime];
  if (!a) throw badRequest(`Loại file không được hỗ trợ: ${mime}`);
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (!a.exts.includes(ext)) throw badRequest(`Phần mở rộng .${ext} không khớp loại ${mime}`);
  if (size <= 0) throw badRequest('File rỗng');
  if (size > env.maxUploadBytes) throw badRequest(`File vượt giới hạn ${Math.round(env.maxUploadBytes / 1048576)}MB`);
  if (!sniffMatches(mime, head)) throw badRequest('Nội dung file không khớp định dạng khai báo');
  return a.kind;
}

const root = () => path.resolve(env.uploadDir);
export function assetPath(rel: string) {
  const p = path.resolve(root(), rel);
  if (!p.startsWith(root() + path.sep)) throw badRequest('Đường dẫn không hợp lệ'); // chống path traversal
  return p;
}
export function saveFile(workspaceId: string, ext: string, data: Buffer) {
  const rel = path.join(workspaceId, `${crypto.randomUUID()}.${ext}`);
  const full = assetPath(rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  return rel;
}

// ---- Signed URL (HMAC, hết hạn) ----
export function signAsset(id: string, ttlSec = 900) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = crypto.createHmac('sha256', appSecret()).update(`${id}.${exp}`).digest('base64url');
  return `/api/media/${id}/file?exp=${exp}&sig=${sig}`;
}
export function verifyAssetSig(id: string, exp: string | null, sig: string | null) {
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const good = crypto.createHmac('sha256', appSecret()).update(`${id}.${exp}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(good);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

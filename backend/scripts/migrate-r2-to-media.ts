/**
 * migrate-r2-to-media.ts — kéo ảnh/video còn sống trên Cloudflare R2 về kho mới
 * (đĩa + Google Drive) và viết lại URL trong bảng Message.
 *
 * CHẠY TRƯỚC KHI XOÁ BUCKET R2. Bucket `zalocrm-media` có lifecycle xoá object sau
 * 3 NGÀY, nên chỉ media của ~3 ngày gần nhất mới còn tải được; phần cũ hơn đã mất
 * từ lâu rồi, script sẽ đếm vào mục "đã chết" và bỏ qua (không đụng vào DB).
 *
 *   npm run media:migrate-from-r2            # chạy thật
 *   npm run media:migrate-from-r2 -- --dry   # chỉ đếm, không ghi gì
 *   npm run media:migrate-from-r2 -- --days=7
 *
 * Chạy lại được nhiều lần: tin nào đã đổi sang /api/v1/media/ thì lần sau không
 * lọt vào câu truy vấn nữa.
 */
import { prisma } from '../src/shared/database/prisma-client.js';
import { config } from '../src/config/index.js';
import { uploadBuffer } from '../src/shared/storage/media-store.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const DAYS = Number(args.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 30);

/** Đúng các trường mà message-handler ghi URL vào — giữ đồng bộ với file đó. */
const URL_FIELDS = ['hdUrl', 'href', 'normalUrl', 'fileUrl', 'url', 'thumbUrl', 'thumb', 'thumbnail'];
const PARAM_FIELDS = ['rawUrl', 'hd'];

const legacyBases = [config.s3PublicUrl, config.s3Endpoint].filter(Boolean).map((b) => b.replace(/\/+$/, ''));

function isLegacyUrl(value: unknown): value is string {
  return typeof value === 'string' && legacyBases.some((b) => value.startsWith(`${b}/`));
}

const stats = { messages: 0, rewritten: 0, files: 0, dead: 0, failed: 0 };
/** URL cũ → URL mới. Một ảnh thường nằm ở nhiều trường / nhiều tin, chỉ tải một lần. */
const moved = new Map<string, string | null>();

async function rehost(url: string): Promise<string | null> {
  if (moved.has(url)) return moved.get(url)!;
  let result: string | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (res.status === 404 || res.status === 403) {
      stats.dead += 1;                      // lifecycle R2 đã xoá — chấp nhận mất
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    } else {
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) throw new Error('empty body');
      const mime = res.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      if (DRY) {
        result = '(dry-run)';
      } else {
        result = (await uploadBuffer(buffer, mime, name)).url;
      }
      stats.files += 1;
    }
  } catch (err) {
    stats.failed += 1;
    console.warn(`  ⚠️  ${url} — ${(err as Error).message}`);
  }
  moved.set(url, result);
  return result;
}

/** Trả content mới, hoặc null nếu không có gì đổi. */
async function rewriteContent(content: string): Promise<string | null> {
  if (!content.trim().startsWith('{')) {
    if (!isLegacyUrl(content)) return null;
    return (await rehost(content)) ?? null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  let changed = false;
  for (const field of URL_FIELDS) {
    const value = parsed[field];
    if (!isLegacyUrl(value)) continue;
    const next = await rehost(value);
    if (next) { parsed[field] = next; changed = true; }
  }

  if (typeof parsed.params === 'string' && parsed.params.trim().startsWith('{')) {
    try {
      const params = JSON.parse(parsed.params) as Record<string, unknown>;
      let paramsChanged = false;
      for (const field of PARAM_FIELDS) {
        const value = params[field];
        if (!isLegacyUrl(value)) continue;
        const next = await rehost(value);
        if (next) { params[field] = next; paramsChanged = true; }
      }
      if (paramsChanged) { parsed.params = JSON.stringify(params); changed = true; }
    } catch {
      /* params hỏng thì bỏ qua, không làm hỏng thêm */
    }
  }

  return changed ? JSON.stringify(parsed) : null;
}

async function main() {
  if (legacyBases.length === 0) {
    console.error('❌ S3_PUBLIC_URL / S3_ENDPOINT đang trống — không biết URL cũ trông thế nào. Dừng.');
    process.exit(1);
  }
  console.log(`🔎 Tìm tin nhắn ${DAYS} ngày gần nhất còn trỏ vào: ${legacyBases.join(', ')}`);
  if (DRY) console.log('   (--dry: chỉ đếm, không ghi DB và không ghi file)\n');

  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const BATCH = 200;
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.message.findMany({
      where: {
        sentAt: { gte: since },
        OR: legacyBases.map((b) => ({ content: { contains: b } })),
      },
      select: { id: true, content: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      if (!row.content) continue;
      stats.messages += 1;
      const next = await rewriteContent(row.content);
      if (!next) continue;
      if (!DRY) {
        await prisma.message.update({ where: { id: row.id }, data: { content: next } });
      }
      stats.rewritten += 1;
    }
    process.stdout.write(`\r   đã soi ${stats.messages} tin…`);
  }

  console.log('\n');
  console.log(`✅ Tin đã soi      : ${stats.messages}`);
  console.log(`✅ Tin viết lại URL: ${stats.rewritten}`);
  console.log(`✅ File kéo về     : ${stats.files}`);
  console.log(`⚰️  File R2 đã chết : ${stats.dead}  (lifecycle 3 ngày đã xoá — không cứu được)`);
  console.log(`❌ Lỗi tải         : ${stats.failed}`);
  console.log('\n👉 Số còn lại trên Drive sẽ tự lên trong vài phút (media-sync chạy nền).');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

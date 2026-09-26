/**
 * catalog-service.ts — tra kho sản phẩm THẬT của bot-noi-bo (cùng nguồn con bot
 * màu hồng dùng) để AI tư vấn cụ thể: tên, giá lẻ / CTV / NPP, tồn kho, mô tả, ảnh.
 *
 * Đọc thẳng Postgres của bot-noi-bo bằng role CHỈ ĐỌC (ai_ro_<schema>) — không đi
 * qua bot hồng (bot đó chạy Claude CLI tuần tự từng khách, quá chậm cho Zalo).
 *   BOT_NOIBO_RO_DB_URL  postgres://ai_ro_noibo:...@127.0.0.1:5432/botniobo
 *   BOT_NOIBO_SCHEMA     noibo
 * Không bao giờ lấy giá vốn. Chưa cấu hình → isCatalogEnabled() = false, AI trả lời như cũ.
 */
import pg from 'pg';
import { logger } from '../../../shared/utils/logger.js';
import { fold } from './guardrails.js';

export type CatalogProduct = {
  id: number;
  code: string;
  name: string;
  unit: string;
  stock: number;
  priceRetail: number | null;
  priceCtv: number | null; // từ 10 cái cùng món
  priceNpp: number | null; // từ 20 cái
  ctvMinQty: number | null;
  nppMinQty: number | null;
  onSale: boolean;
  saleNote: string | null;
  description: string;
  thumbnail: string | null;
  /** Chỉ khớp một phần câu khách hỏi (kho không có đúng món) — AI phải nói rõ. */
  approx: boolean;
};

export type ProductQuery = { name: string; hints?: string[] };

let pool: pg.Pool | null = null;
let schema = 'noibo';
let tiers: { at: number; retailId: number | null; ctv: { id: number; min: number } | null; npp: { id: number; min: number } | null } | null = null;

export function isCatalogEnabled(): boolean {
  return !!process.env.BOT_NOIBO_RO_DB_URL;
}

function getPool(): pg.Pool | null {
  if (pool) return pool;
  if (!isCatalogEnabled()) return null;
  if (!pool) {
    const s = (process.env.BOT_NOIBO_SCHEMA || 'noibo').trim();
    if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error('BOT_NOIBO_SCHEMA không hợp lệ');
    schema = s;
    pool = new pg.Pool({
      connectionString: process.env.BOT_NOIBO_RO_DB_URL,
      max: 3,
      idleTimeoutMillis: 60_000,
      statement_timeout: 5_000,
    });
    pool.on('error', (err) => logger.warn('[catalog] pool lỗi:', err.message));
  }
  return pool;
}

/** Bảng giá: mặc định = giá lẻ; tên có "CTV" / "NPP". Cache 10 phút. */
async function loadTiers(db: pg.Pool) {
  if (tiers && Date.now() - tiers.at < 10 * 60_000) return tiers;
  const { rows } = await db.query<{ id: number; name: string; is_default: boolean; min_quantity: number | null }>(
    `SELECT id, name, is_default, min_quantity FROM ${schema}.price_books WHERE status = 'active'`,
  );
  const find = (re: RegExp) => rows.find((r) => !r.is_default && re.test(fold(r.name)));
  const ctv = find(/ctv|cong tac vien|sl ?10/);
  const npp = find(/npp|nha phan phoi|sl ?20/);
  tiers = {
    at: Date.now(),
    retailId: rows.find((r) => r.is_default)?.id ?? null,
    ctv: ctv ? { id: ctv.id, min: Number(ctv.min_quantity) || 10 } : null,
    npp: npp ? { id: npp.id, min: Number(npp.min_quantity) || 20 } : null,
  };
  return tiers;
}

/** Từ đã bỏ dấu, viết thường, bỏ ký tự lạ. */
function words(text: string): string[] {
  return fold(text).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 2).slice(0, 6);
}

function clip(text: string, max: number) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Tìm sản phẩm CÒN HÀNG theo danh sách truy vấn (tên + gợi ý). Tên phải chứa đủ các
 * từ (không dấu); không ra thì bớt dần từ cuối. Gợi ý (vd "nữ", "ngọt") dùng để xếp
 * hạng theo tên + mô tả. Trả tối đa `limit` sản phẩm, không trùng.
 */
export async function searchProducts(queries: ProductQuery[], limit = 10): Promise<CatalogProduct[]> {
  const db = getPool();
  if (!db || queries.length === 0) return [];
  const t = await loadTiers(db);
  const found = new Map<number, { row: any; score: number; order: number }>();
  let order = 0;

  for (const q of queries.slice(0, 4)) {
    const full = words(q.name);
    let w = full;
    const hints = (q.hints ?? []).flatMap(words);
    let rows: any[] = [];
    while (w.length && rows.length === 0) {
      const res = await db.query(
        `SELECT p.id, p.code, p.name, COALESCE(p.unit_name, p.base_unit_name, '') AS unit,
                p.stock_quantity AS stock, p.sell_price, p.is_sale, p.sale_note, p.sale_until,
                LEFT(COALESCE(p.description, ''), 1500) AS description, p.thumbnail
           FROM ${schema}.products p
          WHERE p.status = 'active' AND p.stock_quantity > 0
            AND public.unaccent(lower(p.name || ' ' || COALESCE(p.full_name, ''))) LIKE ALL ($1::text[])
          ORDER BY p.stock_quantity DESC
          LIMIT 40`,
        [w.map((x) => `%${x}%`)],
      );
      rows = res.rows;
      if (rows.length === 0) w = w.slice(0, -1); // bớt từ cuối rồi tìm lại
      if (w.length === 1 && w[0].length < 3) break; // 1 từ quá ngắn → quá rộng
    }
    const approx = w.length < full.length;
    for (const r of rows) {
      const hay = fold(`${r.name} ${r.description}`);
      const name = fold(r.name).replace(/[^a-z0-9 ]/g, ' ').trim();
      const score = hints.filter((h) => hay.includes(h)).length * 2
        + (name.includes(full.join(' ')) ? 3 : 0)
        + (full[0] && name.startsWith(full[0]) ? 2 : 0)
        - (approx ? 5 : 0);
      const prev = found.get(r.id);
      if (!prev || prev.score < score) found.set(r.id, { row: { ...r, approx: approx && !(prev && !prev.row.approx) }, score, order: prev?.order ?? order++ });
    }
  }

  const picked = [...found.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((x) => x.row);
  if (picked.length === 0) return [];

  const ids = picked.map((r) => r.id);
  const bookIds = [t.retailId, t.ctv?.id, t.npp?.id].filter((x): x is number => typeof x === 'number');
  const { rows: prices } = bookIds.length
    ? await db.query<{ product_id: number; price_book_id: number; price: string }>(
        `SELECT product_id, price_book_id, price FROM ${schema}.product_prices
          WHERE product_id = ANY($1::bigint[]) AND price_book_id = ANY($2::bigint[]) AND unit_conversion_id IS NULL`,
        [ids, bookIds],
      )
    : { rows: [] as Array<{ product_id: number; price_book_id: number; price: string }> };
  const priceOf = (pid: number, book: number | undefined | null) => {
    if (!book) return null;
    const hit = prices.find((p) => Number(p.product_id) === pid && Number(p.price_book_id) === book);
    const v = hit ? Number(hit.price) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  return picked.map((r) => {
    const id = Number(r.id);
    const retail = priceOf(id, t.retailId) ?? (Number(r.sell_price) > 0 ? Number(r.sell_price) : null);
    const saleActive = !!r.is_sale && (!r.sale_until || new Date(r.sale_until) > new Date());
    return {
      id,
      code: r.code,
      name: r.name,
      unit: r.unit || 'cái',
      stock: Math.floor(Number(r.stock) || 0),
      priceRetail: retail,
      priceCtv: priceOf(id, t.ctv?.id),
      priceNpp: priceOf(id, t.npp?.id),
      ctvMinQty: t.ctv?.min ?? null,
      nppMinQty: t.npp?.min ?? null,
      onSale: saleActive,
      saleNote: saleActive ? (r.sale_note || null) : null,
      description: clip(String(r.description || '').replace(/[#*_`>]/g, ''), 400),
      thumbnail: typeof r.thumbnail === 'string' && /^https:\/\//.test(r.thumbnail) ? r.thumbnail : null,
      approx: !!r.approx,
    };
  });
}

const vnd = (n: number) => `${n.toLocaleString('vi-VN')}đ`;

/** Khối dữ liệu sản phẩm đưa vào prompt (và nguồn kiểm duyệt). */
export function renderProducts(products: CatalogProduct[]): string {
  if (products.length === 0) return '';
  const lines = products.map((p) => {
    const prices = [
      p.priceRetail ? `giá lẻ ${vnd(p.priceRetail)}` : 'CHƯA CÓ GIÁ (không báo giá, hẹn kiểm tra)',
      p.priceCtv ? `giá CTV ${vnd(p.priceCtv)} (từ ${p.ctvMinQty ?? 10} ${p.unit} cùng món)` : null,
      p.priceNpp ? `giá NPP ${vnd(p.priceNpp)} (từ ${p.nppMinQty ?? 20} ${p.unit})` : null,
    ].filter(Boolean).join(' · ');
    return [
      `- [id ${p.id}] ${p.name} (mã ${p.code}) — ${prices} — còn hàng${p.stock <= 3 ? ` (ít, ${p.stock} ${p.unit})` : ''}${p.approx ? ' — GẦN ĐÚNG: kho không có đúng món khách hỏi, chỉ là món liên quan' : ''}`,
      p.onSale ? `  KHUYẾN MÃI: ${p.saleNote || 'đang khuyến mãi'}` : null,
      p.description ? `  Mô tả: ${p.description}` : null,
      p.thumbnail ? '  (có ảnh)' : null,
    ].filter(Boolean).join('\n');
  });
  return ['<san_pham_trong_kho>', ...lines, '</san_pham_trong_kho>'].join('\n');
}

/** Chỉ cho test. */
export function _setCatalogPoolForTest(p: pg.Pool | null, s = 'noibo'): void {
  pool = p;
  schema = s;
  tiers = null;
}

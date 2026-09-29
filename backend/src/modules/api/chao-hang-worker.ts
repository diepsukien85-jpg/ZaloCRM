/**
 * chao-hang-worker.ts — Worker gửi CHÀO HÀNG chạy nền (throttle), cho job do BOT
 * nội bộ bắn qua POST /api/public/chao-hang/jobs.
 *
 * Luồng: GET recipients từ BOT → lặp từng khách (giãn cách, chỉ trong khung giờ VN,
 * có hạn mức tìm UID/ngày) → nếu thiếu UID thì findUser theo SĐT qua 1 nick cố định
 * → gửi ảnh chào hàng theo tier (chunk theo CHAO_HANG_IMAGE_LOT) → ghi ChaoHangResult
 * → callback BOT /uid (UID mới) + /ket-qua (định kỳ partial, 1 lần cuối final).
 *
 * Idempotent theo job_id: re-trigger cùng job bỏ qua khách đã 'sent' (không gửi trùng).
 * Tái dùng sendToThread/PartialSendError của public-api-routes (KHÔNG dựng gửi mới).
 * BÍ MẬT: internal_key chỉ đi trong header x-internal-key, KHÔNG bao giờ log ra ngoài.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { zaloOps } from '../../shared/zalo-operations.js';
import { SsrfBlockedError } from '../../shared/utils/ssrf-guard.js';
import { sendToThread, PartialSendError, CHAO_HANG_IMAGE_LOT } from './public-api-routes.js';

// ── Kiểu dữ liệu hợp đồng với BOT ───────────────────────────────────────────────
export interface ChaoHangProduct {
  ma: string;
  ten?: string;
  ton_kho?: number;
  don_vi?: string;
  anh?: Partial<Record<'base' | 'SL5' | 'SL10' | 'SL20', string>>;
}
interface Recipient {
  customer_id: number;
  name?: string;
  phone?: string;
  zalo_uid?: string | null;
  uid_status?: 'found' | 'unknown' | 'not_found' | 'no_phone';
  tier?: string;
  product_codes?: string[];
}
interface JobConfig {
  send_delay_sec: number;
  uid_lookup_daily_limit: number;
  uid_lookup_delay_sec: number;
  active_start_hour: number;
  active_end_hour: number;
}

const DEFAULT_CONFIG: JobConfig = {
  send_delay_sec: 8,
  uid_lookup_daily_limit: 50,
  uid_lookup_delay_sec: 30,
  active_start_hour: 7,
  active_end_hour: 21,
};

const VN_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Ho_Chi_Minh = UTC+7 (không DST)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CALLBACK_EVERY_N = 10; // callback partial sau mỗi N khách
const CALLBACK_EVERY_MS = 30_000; // hoặc mỗi 30s
const RESUME_MAX_MS = 13 * 60 * 60 * 1000; // không hẹn lại quá 13h

// Chống chạy trùng 1 job + chống hẹn lại trùng.
const running = new Set<string>();
const resumeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function normalizeConfig(raw: unknown): JobConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    send_delay_sec: num(c.send_delay_sec, DEFAULT_CONFIG.send_delay_sec),
    uid_lookup_daily_limit: num(c.uid_lookup_daily_limit, DEFAULT_CONFIG.uid_lookup_daily_limit),
    uid_lookup_delay_sec: num(c.uid_lookup_delay_sec, DEFAULT_CONFIG.uid_lookup_delay_sec),
    active_start_hour: num(c.active_start_hour, DEFAULT_CONFIG.active_start_hour),
    active_end_hour: num(c.active_end_hour, DEFAULT_CONFIG.active_end_hour),
  };
}

function vnHour(): number {
  return new Date(Date.now() + VN_OFFSET_MS).getUTCHours();
}
function withinActiveHours(cfg: JobConfig): boolean {
  const h = vnHour();
  return h >= cfg.active_start_hour && h < cfg.active_end_hour;
}
/** ms còn lại đến lần mở cửa hoạt động kế tiếp (giờ VN). */
function msUntilActiveStart(cfg: JobConfig): number {
  const nowVN = Date.now() + VN_OFFSET_MS;
  const dayStart = Math.floor(nowVN / 86_400_000) * 86_400_000;
  let startVN = dayStart + cfg.active_start_hour * 3_600_000;
  if (nowVN >= startVN) startVN += 86_400_000; // đã qua giờ mở hôm nay → sang mai
  return Math.max(0, startVN - nowVN);
}
/** Mốc 00:00 hôm nay theo giờ VN, quy về Date UTC — để đếm hạn mức tìm UID/ngày. */
function startOfTodayVN(): Date {
  const nowVN = Date.now() + VN_OFFSET_MS;
  const dayStartVN = Math.floor(nowVN / 86_400_000) * 86_400_000;
  return new Date(dayStartVN - VN_OFFSET_MS);
}

/** Gom ảnh chào hàng cho 1 khách: mỗi product lấy anh[tier], thiếu thì fallback base. */
function imagesForRecipient(products: ChaoHangProduct[], tier?: string, productCodes?: string[]): string[] {
  const out: string[] = [];
  const allow = Array.isArray(productCodes) && productCodes.length ? new Set(productCodes) : null;
  for (const p of products) {
    if (allow && !allow.has(p.ma)) continue;
    const anh = p.anh ?? {};
    const byTier = tier ? (anh as Record<string, string | undefined>)[tier] : undefined;
    const url = byTier || anh.base;
    if (typeof url === 'string' && url.length > 0) out.push(url);
  }
  return out;
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Lỗi Zalo chặn tin TEXT (khách chưa kết bạn + tắt nhận tin từ người lạ). */
function isTextBlockedError(msg: string): boolean {
  const m = (msg || '').toLowerCase();
  return m.includes('không thể nhận tin nhắn')
    || m.includes('không muốn nhận tin nhắn')
    || m.includes('chưa thể gửi tin nhắn');
}

/**
 * Khách này có cần gửi lời nhắn dạng DESC của ảnh (captionMode) thay vì tin text riêng?
 * TRUE khi: (a) chưa kết bạn với nick gửi → Zalo hay chặn tin text từ người lạ, HOẶC
 *           (b) đã từng bị chặn tin text ở lần chào trước (học từ lịch sử).
 * captionMode gửi lời nhắn kèm ảnh trong 1 tin ảnh → không bị chặn, lại đỡ 1 tin/khách.
 */
async function shouldUseCaption(
  orgId: string,
  zaloAccountId: string,
  customerId: number,
  uid: string,
): Promise<boolean> {
  try {
    const friend = await prisma.friend.findFirst({
      where: { orgId, zaloAccountId, zaloUidInNick: uid },
      select: { friendshipStatus: true },
    });
    if (!friend || friend.friendshipStatus !== 'accepted') return true;
    const blocked = await prisma.chaoHangResult.findFirst({
      where: {
        customerId,
        job: { orgId, zaloAccountId },
        OR: [
          { error: { contains: 'không thể nhận tin nhắn', mode: 'insensitive' } },
          { error: { contains: 'không muốn nhận tin nhắn', mode: 'insensitive' } },
        ],
      },
      select: { id: true },
    });
    return !!blocked;
  } catch (err) {
    logger.warn(`[chao-hang] shouldUseCaption customer=${customerId} lỗi: ${(err as Error)?.message}`);
    return false; // lỗi tra cứu → giữ luồng cũ (tin text riêng)
  }
}

// ── Gọi ngược BOT (đính x-internal-key, KHÔNG log key) ──────────────────────────

/** Slug công ty (tenant) suy từ subdomain của botBaseUrl — vd https://noibo.shinsulab.com → 'noibo'.
 *  BOT là đa công ty; mỗi job lưu botBaseUrl riêng theo công ty nên không cần thêm cột DB. */
function tenantSlugFromBaseUrl(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl).hostname;
    const parts = host.split('.');
    return parts.length > 2 && parts[0] ? parts[0] : null;
  } catch {
    return null;
  }
}

/** tenant_slug BOT gửi kèm lúc tạo job (lưu trong config JSON, 18/09/2026) — ưu tiên hơn suy từ subdomain,
 *  vì bot_base_url nay có thể là http://127.0.0.1:3001 (không có subdomain). */
function tenantSlugFromConfig(config: unknown): string | null {
  const v = (config as Record<string, unknown> | null)?.tenant_slug;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

async function botFetch(
  baseUrl: string,
  internalKey: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  tenantSlug?: string | null,
): Promise<any> {
  const url = new URL(path, baseUrl).toString();
  const slug = tenantSlug ?? tenantSlugFromBaseUrl(baseUrl);
  const res = await fetch(url, {
    method: init.method,
    headers: {
      'x-internal-key': internalKey,
      // BOT là đa công ty (multi-tenant): header này cho BOT biết callback thuộc công ty nào.
      // Thiếu nó BOT phải suy từ subdomain, và nếu cũng không có thì fallback về tenant mặc
      // định → ghi dữ liệu sang nhầm công ty.
      ...(slug ? { 'x-tenant-slug': slug } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`BOT ${init.method} ${path} → HTTP ${res.status}`);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  return ct.includes('application/json') ? res.json() : null;
}


/** POST UID mới tìm được về BOT (best-effort, nuốt lỗi). */
async function postUidToBot(
  job: { botBaseUrl: string; internalKey: string; tenantSlug?: string | null },
  customerId: number,
  zaloUid: string | null,
  status: 'found' | 'not_found' | 'no_phone',
): Promise<void> {
  try {
    await botFetch(job.botBaseUrl, job.internalKey, '/api/chao-hang/uid', {
      method: 'POST',
      body: { customer_id: customerId, zalo_uid: zaloUid, status },
    }, job.tenantSlug);
  } catch (err) {
    logger.warn(`[chao-hang] postUid customer=${customerId} thất bại: ${(err as Error)?.message}`);
  }
}


/** Đếm số khách trong job để cập nhật sent/failed/skipped. */
async function recomputeCounts(crmJobId: string) {
  const grouped = await prisma.chaoHangResult.groupBy({
    by: ['status'],
    where: { jobId: crmJobId },
    _count: { _all: true },
  });
  const m: Record<string, number> = {};
  for (const g of grouped) m[g.status] = g._count._all;
  return {
    sentCount: m.sent ?? 0,
    failedCount: m.failed ?? 0,
    skippedCount: m.skipped ?? 0,
  };
}

/** Gửi callback /ket-qua về BOT (partial trong lúc chạy, final khi xong). */
async function sendKetQua(
  job: { id: string; botBaseUrl: string; internalKey: string; botJobId: number; config?: unknown },
  partial: boolean,
): Promise<void> {
  const rows = await prisma.chaoHangResult.findMany({
    where: { jobId: job.id },
    orderBy: { createdAt: 'asc' },
  });
  const results = rows.map((r) => ({
    customer_id: r.customerId,
    name: r.name,
    phone: r.phone,
    tier: r.tier,
    uid_used: r.uidUsed,
    status: r.status,
    error: r.error,
  }));
  // 18/09/2026: trước đây callback lỗi chỉ ghi warn rồi BỎ — 4 đợt (PN00483/527/606/628) CRM xong mà BOT
  // ghi "đang chạy" mãi vì đúng cú callback CUỐI rơi lúc tunnel đứt. Nay: partial vẫn 1 lần (không quan trọng),
  // FINAL thử lại 5 lần giãn dần (10s → 30s → 60s → 2p → 5p, tổng ~8.5 phút).
  const delays = partial ? [0] : [0, 10_000, 30_000, 60_000, 120_000, 300_000];
  const slug = tenantSlugFromConfig(job.config);
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
    try {
      await botFetch(job.botBaseUrl, job.internalKey, '/api/chao-hang/ket-qua', {
        method: 'POST',
        body: { job_id: job.botJobId, partial, summary: { total: rows.length }, results },
      }, slug);
      await prisma.chaoHangJob.update({ where: { id: job.id }, data: { lastCallbackAt: new Date() } }).catch(() => {});
      return;
    } catch (err) {
      const last = i === delays.length - 1;
      logger.warn(`[chao-hang] ket-qua (partial=${partial}) lần ${i + 1}/${delays.length} thất bại: ${(err as Error)?.message}${last ? ' — BỎ CUỘC, BOT phải tự đối chiếu qua GET /jobs/:botJobId' : ''}`);
    }
  }
}

function scheduleResume(crmJobId: string, cfg: JobConfig): void {
  if (resumeTimers.has(crmJobId)) return; // đã hẹn rồi
  const delay = msUntilActiveStart(cfg);
  if (delay > RESUME_MAX_MS) return; // quá xa → để BOT re-trigger
  logger.info(`[chao-hang] job ${crmJobId} ngoài giờ hoạt động — hẹn chạy lại sau ${Math.round(delay / 60000)} phút`);
  const t = setTimeout(() => {
    resumeTimers.delete(crmJobId);
    void runChaoHangJob(crmJobId);
  }, delay);
  if (typeof t.unref === 'function') t.unref();
  resumeTimers.set(crmJobId, t);
}

// ── Entry point ────────────────────────────────────────────────────────────────
/** Chạy 1 job chào hàng (idempotent, chống chạy trùng). Fire-and-forget từ route. */
export async function runChaoHangJob(crmJobId: string): Promise<void> {
  if (running.has(crmJobId)) {
    logger.info(`[chao-hang] job ${crmJobId} đang chạy — bỏ qua trigger trùng`);
    return;
  }
  running.add(crmJobId);
  try {
    await processJob(crmJobId);
  } catch (err) {
    logger.error(`[chao-hang] job ${crmJobId} LỖI:`, (err as Error)?.message);
    await prisma.chaoHangJob
      .update({ where: { id: crmJobId }, data: { status: 'failed', error: (err as Error)?.message ?? 'unknown', finishedAt: new Date() } })
      .catch(() => {});
  } finally {
    running.delete(crmJobId);
  }
}

async function processJob(crmJobId: string): Promise<void> {
  const job = await prisma.chaoHangJob.findUnique({ where: { id: crmJobId } });
  if (!job) {
    logger.warn(`[chao-hang] job ${crmJobId} không tồn tại`);
    return;
  }
  if (job.status === 'done') return;

  const cfg = normalizeConfig(job.config);

  // Lấy API nick gửi cố định (qua pool, KHÔNG dựng kết nối mới).
  const { zaloPool } = await import('../zalo/zalo-pool.js');
  const api = zaloPool.getApi(job.zaloAccountId);
  if (!api) {
    // Nick chưa active trong pool → để dành, hẹn lại trong giờ kế (BOT cũng có thể re-trigger).
    logger.warn(`[chao-hang] job ${crmJobId}: nick ${job.zaloAccountId} chưa active trong pool — hoãn`);
    scheduleResume(crmJobId, cfg);
    return;
  }

  // 1) Lấy recipients + products mới nhất từ BOT.
  const data = await botFetch(job.botBaseUrl, job.internalKey, `/api/chao-hang/recipients?job_id=${job.botJobId}`, { method: 'GET' }, tenantSlugFromConfig(job.config));
  const recipients: Recipient[] = Array.isArray(data?.recipients) ? data.recipients : [];
  const products: ChaoHangProduct[] = Array.isArray(data?.products)
    ? data.products
    : (Array.isArray(job.products) ? (job.products as unknown as ChaoHangProduct[]) : []);

  // Loi chao hang (text) tu BOT (BOT tao anh) — gui truoc anh, chi 1 lan o lo dau.
  const chaoMessage = typeof (data as { message?: unknown })?.message === "string" ? ((data as { message?: string }).message ?? "") : "";
  // Cau chao (text) tu BOT — gui NGAY SAU khi gui xong bo anh cua MOI khach,
  // gui xong text moi chuyen sang khach ke tiep. Rong = khong gui.
  const outroMessage = typeof (data as { message_after?: unknown })?.message_after === "string" ? ((data as { message_after?: string }).message_after ?? "").trim() : "";

  // Seed kết quả pending cho khách mới (create-if-missing — KHÔNG ghi đè khách đã 'sent').
  for (const r of recipients) {
    await prisma.chaoHangResult.upsert({
      where: { jobId_customerId: { jobId: job.id, customerId: r.customer_id } },
      create: {
        jobId: job.id,
        customerId: r.customer_id,
        name: r.name ?? null,
        phone: r.phone ?? null,
        tier: r.tier ?? null,
        status: 'pending',
      },
      update: {}, // giữ nguyên trạng thái cũ (idempotent)
    });
  }
  await prisma.chaoHangJob.update({
    where: { id: job.id },
    data: { status: 'running', totalCount: recipients.length, products: products as any, error: null },
  });

  let processedSinceCb = 0;
  let lastCbMs = Date.now();

  // 2) Lặp từng khách theo thứ tự.
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];

    // Idempotent: khách đã gửi thành công trong job này → bỏ qua.
    const existing = await prisma.chaoHangResult.findUnique({
      where: { jobId_customerId: { jobId: job.id, customerId: r.customer_id } },
      select: { status: true },
    });
    if (existing?.status === 'sent') continue;

    // Chỉ gửi trong khung giờ VN; ngoài giờ → callback partial, hẹn chạy lại, dừng.
    if (!withinActiveHours(cfg)) {
      await recountAndPersist(job.id);
      await sendKetQua(job, true);
      scheduleResume(crmJobId, cfg);
      return;
    }

    const imageUrls = imagesForRecipient(products, r.tier, r.product_codes);
    if (imageUrls.length === 0) {
      await markResult(job.id, r, { status: 'skipped', error: 'không có ảnh phù hợp tier', uidUsed: r.zalo_uid ?? null, imagesCount: 0 });
      continue;
    }

    // 3) Xác định UID gửi.
    let uid = r.zalo_uid ?? null;
    if (!uid || r.uid_status !== 'found') {
      // Đã biết không tìm được / không có SĐT → bỏ qua, không tìm lại.
      if (r.uid_status === 'not_found' || r.uid_status === 'no_phone') {
        await markResult(job.id, r, { status: 'skipped', error: `uid_status=${r.uid_status}`, uidUsed: null, imagesCount: 0 });
        continue;
      }
      // Chưa biết → cần tìm UID theo SĐT.
      if (!r.phone) {
        await markResult(job.id, r, { status: 'skipped', error: 'không có SĐT để tìm UID', uidUsed: null, imagesCount: 0, uidLookupAt: null });
        await postUidToBot(job, r.customer_id, null, 'no_phone');
        continue;
      }
      // Hạn mức tìm UID/ngày.
      const usedToday = await prisma.chaoHangResult.count({
        where: { uidLookupAt: { gte: startOfTodayVN() }, job: { orgId: job.orgId, zaloAccountId: job.zaloAccountId } },
      });
      if (usedToday >= cfg.uid_lookup_daily_limit) {
        await markResult(job.id, r, { status: 'skipped', error: 'hết hạn mức tìm UID trong ngày', uidUsed: null, imagesCount: 0 });
        continue; // để dành lần sau (re-trigger sẽ thử lại)
      }
      // Giãn cách trước khi tìm (chống khóa nick), rồi findUser theo SĐT.
      if (cfg.uid_lookup_delay_sec > 0) await sleep(cfg.uid_lookup_delay_sec * 1000);
      const lookupAt = new Date();
      let foundUid: string | null = null;
      try {
        const res = (await zaloOps.findUser(job.zaloAccountId, r.phone)) as Record<string, unknown> | null;
        foundUid = res ? String((res.uid as string) || (res.userId as string) || '') || null : null;
      } catch (err) {
        logger.warn(`[chao-hang] findUser customer=${r.customer_id} lỗi: ${(err as Error)?.message}`);
      }
      if (!foundUid) {
        await markResult(job.id, r, { status: 'skipped', error: 'không tìm được UID', uidUsed: null, imagesCount: 0, uidLookupAt: lookupAt });
        await postUidToBot(job, r.customer_id, null, 'not_found');
        continue;
      }
      uid = foundUid;
      await markResult(job.id, r, { status: 'pending', error: null, uidUsed: uid, imagesCount: 0, uidLookupAt: lookupAt });
      await postUidToBot(job, r.customer_id, uid, 'found');
    }

    // 4) Gửi ảnh chào hàng (chia lô theo CHAO_HANG_IMAGE_LOT; threadType user = 0).
    // Khách đã từng bị Zalo chặn tin TEXT (chưa kết bạn + tắt nhận tin người lạ) → gửi lời
    // nhắn làm DESC của ảnh cuối ngay từ đầu (1 tin ảnh, không bị chặn) thay vì tin text riêng.
    const useCaption = outroMessage ? await shouldUseCaption(job.orgId, job.zaloAccountId, r.customer_id, uid) : false;
    const lots = chunk(imageUrls, CHAO_HANG_IMAGE_LOT);
    let ok = true;
    let errMsg: string | undefined;
    for (let li = 0; li < lots.length; li++) {
      const isLastLot = li === lots.length - 1;
      try {
        await sendToThread(
          api, job.orgId, job.zaloAccountId, uid, 0 /* user */,
          useCaption && isLastLot ? outroMessage : (li === 0 ? chaoMessage : ''),
          lots[li],
          useCaption && isLastLot,
        );
      } catch (err) {
        ok = false;
        errMsg = err instanceof PartialSendError
          ? `có thể đã gửi một phần ảnh (đã giao ${err.deliveredCount}) — kiểm tra trước khi gửi lại`
          : err instanceof SsrfBlockedError
            ? 'URL ảnh không hợp lệ (HTTPS only)'
            : (err as Error)?.message;
        logger.error(`[chao-hang] gửi customer=${r.customer_id} LỖI: ${errMsg}`);
        break;
      }
    }
    // 4b) Gửi câu chào (text) NGAY SAU khi gửi xong bộ ảnh — xong mới sang khách kế tiếp.
    // useCaption=true: lời nhắn ĐÃ đi kèm ảnh cuối ở bước 4 → không gửi tin text nữa.
    // Ảnh đã gửi OK mà text lỗi → vẫn giữ status 'sent' (tránh re-send trùng ảnh), chỉ ghi chú lỗi.
    let outroErr: string | undefined;
    if (ok && outroMessage && !useCaption) {
      try {
        await sendToThread(api, job.orgId, job.zaloAccountId, uid, 0 /* user */, outroMessage, []);
      } catch (err) {
        outroErr = (err as Error)?.message ?? 'gửi câu chào thất bại';
        logger.warn(`[chao-hang] gửi câu chào customer=${r.customer_id} LỖI: ${outroErr}`
          + (isTextBlockedError(outroErr) ? ' → lần chào sau sẽ tự gửi kèm ảnh (caption)' : ''));
      }
    }
    await markResult(job.id, r, {
      status: ok ? 'sent' : 'failed',
      error: ok ? (outroErr ? `ảnh OK, câu chào lỗi: ${outroErr}` : null) : (errMsg ?? 'gửi thất bại'),
      uidUsed: uid,
      imagesCount: imageUrls.length,
      sentAt: ok ? new Date() : undefined,
    });

    // 5) Callback partial định kỳ.
    processedSinceCb++;
    if (processedSinceCb >= CALLBACK_EVERY_N || Date.now() - lastCbMs >= CALLBACK_EVERY_MS) {
      await recountAndPersist(job.id);
      await sendKetQua(job, true);
      processedSinceCb = 0;
      lastCbMs = Date.now();
    }

    // Giãn cách giữa 2 lần gửi (chỉ khi còn khách phía sau).
    if (i < recipients.length - 1 && cfg.send_delay_sec > 0) await sleep(cfg.send_delay_sec * 1000);
  }

  // 6) Xong toàn bộ → cập nhật, callback final, set done.
  const counts = await recountAndPersist(job.id);
  await prisma.chaoHangJob.update({
    where: { id: job.id },
    data: { status: 'done', finishedAt: new Date(), ...counts },
  });
  await sendKetQua(job, false);
  logger.info(`[chao-hang] job ${crmJobId} XONG: sent=${counts.sentCount} failed=${counts.failedCount} skipped=${counts.skippedCount}`);
}

/** Ghi/đổi kết quả 1 khách (upsert theo [jobId, customerId]). */
async function markResult(
  crmJobId: string,
  r: Recipient,
  patch: { status: string; error: string | null; uidUsed: string | null; imagesCount: number; sentAt?: Date; uidLookupAt?: Date | null },
): Promise<void> {
  const data: Record<string, unknown> = {
    name: r.name ?? null,
    phone: r.phone ?? null,
    tier: r.tier ?? null,
    status: patch.status,
    error: patch.error,
    uidUsed: patch.uidUsed,
    imagesCount: patch.imagesCount,
  };
  if (patch.sentAt !== undefined) data.sentAt = patch.sentAt;
  if (patch.uidLookupAt !== undefined) data.uidLookupAt = patch.uidLookupAt;
  await prisma.chaoHangResult.upsert({
    where: { jobId_customerId: { jobId: crmJobId, customerId: r.customer_id } },
    create: { jobId: crmJobId, customerId: r.customer_id, ...(data as any) },
    update: data as any,
  });
}

async function recountAndPersist(crmJobId: string) {
  const counts = await recomputeCounts(crmJobId);
  await prisma.chaoHangJob.update({ where: { id: crmJobId }, data: counts }).catch(() => {});
  return counts;
}


// ── Auto tìm UID Zalo (nền tảng auto-RMKT) ──────────────────────────────────────
// BOT cron đẩy batch khách cần tìm UID → resolver tìm dần (giãn cách), backoff khi
// Zalo rate-limit (findUser THROW) — KHÔNG đánh dấu not_found trong trường hợp đó.
/** Mã lỗi findUser mang nghĩa "SĐT này không có/không dùng được Zalo" — không phải bị chặn tra cứu. */
export function isFindUserNotFoundError(message: string): boolean {
  return /\[zalo:(212|216|219)\]/.test(message);
}

export async function runUidResolve(params: {
  orgId: string;
  botBaseUrl: string;
  internalKey: string;
  zaloAccountId: string;
  items: Array<{ customer_id: number; phone: string }>;
  delaySec: number;
}): Promise<void> {
  const job = { botBaseUrl: params.botBaseUrl, internalKey: params.internalKey };
  const delay = Number.isFinite(params.delaySec) ? params.delaySec : 30;
  let done = 0;
  for (const it of params.items) {
    if (!it || !it.customer_id) continue;
    const phone = (it.phone || "").trim();
    if (!phone) { await postUidToBot(job, it.customer_id, null, "no_phone"); continue; }
    if (delay > 0) await sleep(delay * 1000);
    let foundUid: string | null = null;
    try {
      const res = (await zaloOps.findUser(params.zaloAccountId, phone)) as Record<string, unknown> | null;
      foundUid = res ? String((res.uid as string) || (res.userId as string) || "") || null : null;
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      // 2026-09-08: Zalo trả LỖI riêng cho từng SĐT (không phải rate-limit) → coi là not_found
      // và đi tiếp. Trước đây mọi lỗi đều break → batch dừng ở khách đầu tiên, khách đó không
      // được báo về BOT nên BOT đẩy lại đúng 20 khách ấy mỗi 5 phút → cả ngày chỉ tìm được ~25.
      //   [zalo:212] Không tìm thấy · [zalo:216] User không hợp lệ · [zalo:219] SĐT không hợp lệ
      if (isFindUserNotFoundError(msg)) {
        await postUidToBot(job, it.customer_id, null, 'not_found');
        done++;
        continue;
      }
      // Lỗi khác (rất có thể Zalo chặn vì tra quá nhiều) → BACKOFF: dừng batch, KHÔNG đánh dấu not_found.
      logger.warn(`[uid-resolve] findUser customer=${it.customer_id} lỗi → backoff: ${msg}`);
      break;
    }
    if (foundUid) await postUidToBot(job, it.customer_id, foundUid, "found");
    else await postUidToBot(job, it.customer_id, null, "not_found"); // trả rỗng = chặn tìm kiếm / không có Zalo
    done++;
  }
  logger.info(`[uid-resolve] xử lý ${done}/${params.items.length} khách`);
}

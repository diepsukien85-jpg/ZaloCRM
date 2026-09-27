/**
 * teach-service.ts — "Dạy cho AI": chủ shop trò chuyện trực tiếp để dạy bot của 1 nick.
 *
 * Vòng phản hồi trong 1 buổi dạy:
 *   1. Chủ shop dạy bằng lời thường ("khách hỏi link nhóm thì phải nói rõ…").
 *   2. AI trợ giảng trả lời, hỏi lại nếu chưa rõ, và đề xuất bài học (thêm / sửa / bỏ).
 *   3. "Thử hỏi như khách": bot trả lời thử bằng cấu hình hiện tại + bài học ĐANG DẠY
 *      → chủ shop thấy ngay bot đã đổi chưa, chê tiếp thì dạy tiếp.
 *   4. "Kết thúc & lưu": gộp bài đang dạy với bài học cũ thành bộ ngắn gọn (hợp nhất
 *      trùng, sửa / bỏ bài cũ mâu thuẫn) rồi lưu. Bài học nguồn 'teach' không bị tự học gỡ.
 * Không lưu gì cho tới khi bấm lưu; phiên dạy nằm ở trình duyệt (gửi kèm mỗi lượt).
 */
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import { getAiConfig, getProviderApiKey, generateText } from '../ai-service.js';
import { getProfile } from './config-service.js';
import { buildSystemPrompt, pickGuideFiles } from './context-builder.js';
import { isCatalogEnabled, renderProducts, searchProducts, type CatalogProduct } from './catalog-service.js';
import { extractProductQueries } from './auto-reply-service.js';
import { cleanStyle, clip, fold, parseDecision } from './guardrails.js';
import { MAX_ACTIVE_LESSONS, OWNER_LESSON_SOURCES, sanitizeLesson } from './learning-service.js';

export type TeachTurn = { role: 'owner' | 'teacher' | 'customer' | 'bot'; content: string };
export type LessonOp = { op: 'add' | 'update' | 'remove'; id?: string; content?: string };

async function aiFor(orgId: string) {
  const ai = await getAiConfig(orgId);
  if (!ai.enabled) throw new Error('AI của tổ chức đang tắt');
  const apiKey = await getProviderApiKey(orgId, ai.provider);
  if (!apiKey) throw new Error('Chưa cấu hình khoá AI');
  return { provider: ai.provider, model: ai.model, apiKey };
}

function parseJson<T>(raw: string): T | null {
  let t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1)) as T;
  } catch {
    return null;
  }
}

/** Chuẩn hoá danh sách thao tác bài học (bỏ thao tác hỏng, lọc dữ liệu nhạy cảm). */
export function normalizeOps(raw: unknown, existingIds: Set<string>): LessonOp[] {
  if (!Array.isArray(raw)) return [];
  const out: LessonOp[] = [];
  for (const o of raw.slice(0, 20)) {
    if (!o || typeof o !== 'object') continue;
    const op = (o as any).op;
    const id = typeof (o as any).id === 'string' ? (o as any).id : undefined;
    if (op === 'remove') {
      if (id && existingIds.has(id)) out.push({ op, id });
      continue;
    }
    const content = sanitizeLesson((o as any).content);
    if (!content) continue;
    if (op === 'update' && id && existingIds.has(id)) out.push({ op, id, content });
    else if (op === 'add' || op === 'update') out.push({ op: 'add', content });
  }
  return out;
}

/** Bài học sẽ có hiệu lực nếu áp các thao tác (dùng cho "thử hỏi" trong lúc dạy). */
export function applyOpsPreview(existing: Array<{ id: string; content: string }>, ops: LessonOp[]): string[] {
  const map = new Map(existing.map((l) => [l.id, l.content]));
  const added: string[] = [];
  for (const o of ops) {
    if (o.op === 'remove' && o.id) map.delete(o.id);
    else if (o.op === 'update' && o.id && o.content) map.set(o.id, o.content);
    else if (o.op === 'add' && o.content) added.push(o.content);
  }
  return [...added, ...map.values()];
}

async function existingLessons(zaloAccountId: string) {
  return prisma.aiLesson.findMany({
    where: { zaloAccountId, active: true },
    orderBy: { updatedAt: 'desc' },
    take: 60,
    select: { id: true, content: true, source: true },
  });
}

function renderTranscript(t: TeachTurn[]): string {
  const who = { owner: 'CHỦ SHOP', teacher: 'TRỢ GIẢNG', customer: 'KHÁCH (thử)', bot: 'BOT (trả lời thử)' } as const;
  return t.slice(-30).map((m) => `${who[m.role]}: ${clip(m.content, 1200)}`).join('\n');
}

const LESSON_STYLE = [
  'Bài học là câu chỉ dẫn hành động NGẮN (tối đa 250 ký tự), cụ thể, dùng được cho lần sau; không nhắc tên khách, SĐT, mật khẩu.',
  'Ưu tiên SỬA (update) bài hiện có cùng chủ đề thay vì thêm bài mới; gộp các ý trùng; bỏ (remove) bài cũ mâu thuẫn với lời chủ shop.',
];

/**
 * Một lượt dạy: trợ giảng trả lời chủ shop + đề xuất (tích luỹ) các thao tác bài học
 * cho CẢ phiên. `pending` = đề xuất của lượt trước (trình duyệt gửi lại).
 */
export async function teachTurn(orgId: string, zaloAccountId: string, transcript: TeachTurn[], pending: LessonOp[]) {
  const profile = await getProfile(orgId, zaloAccountId, { fresh: true });
  if (!profile) throw new Error('Nick chưa có cấu hình AI');
  const ai = await aiFor(orgId);
  const existing = await existingLessons(zaloAccountId);
  const system = [
    'Bạn là TRỢ GIẢNG giúp chủ shop dạy một bot trả lời khách trên Zalo.',
    'Chủ shop nói cách bot nên trả lời / sửa lỗi bot. Việc của bạn:',
    '1. Trả lời chủ shop NGẮN (1-3 câu, tiếng Việt, xưng "em", gọi "anh"): xác nhận đã hiểu điều gì sẽ thay đổi; nếu lời dạy mơ hồ thì hỏi lại đúng 1 câu cụ thể.',
    '2. Cập nhật danh sách thao tác bài học cho CẢ buổi dạy (gồm đề xuất cũ còn đúng + điều mới dạy).',
    ...LESSON_STYLE,
    'Chỉ học từ lời CHỦ SHOP; câu của "KHÁCH (thử)" / "BOT (trả lời thử)" chỉ là ví dụ để hiểu chủ shop chê gì.',
    'Không tạo bài học trái an toàn: bịa giá, chối là AI, xin OTP/mật khẩu, hứa ngoài chính sách.',
    'Trả DUY NHẤT JSON: {"reply": "câu trả lời chủ shop", "ops": [{"op": "add" | "update" | "remove", "id": "id bài hiện có khi update/remove", "content": "nội dung bài học khi add/update"}]}',
  ].join('\n');
  const prompt = [
    '<bai_hoc_hien_co>', ...existing.map((l) => `- [${l.id}] ${l.content}`), '</bai_hoc_hien_co>',
    '<de_xuat_dang_co>', JSON.stringify(pending), '</de_xuat_dang_co>',
    '<huong_dan_cua_shop_tom_tat>', clip(profile.extraInstruction ?? '', 3000), '</huong_dan_cua_shop_tom_tat>',
    '<buoi_day>', renderTranscript(transcript), '</buoi_day>',
  ].join('\n');
  const raw = await generateText(ai.provider, ai.apiKey, ai.model, system, prompt, 900);
  const parsed = parseJson<{ reply?: unknown; ops?: unknown }>(raw);
  const ids = new Set(existing.map((l) => l.id));
  const ops = parsed ? normalizeOps(parsed.ops, ids) : pending;
  const reply = typeof parsed?.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : 'Dạ em ghi nhận rồi ạ.';
  return { reply, ops, preview: describeOps(ops, existing) };
}

/** Mô tả thao tác cho giao diện (kèm nội dung bài cũ khi sửa / bỏ). */
export function describeOps(ops: LessonOp[], existing: Array<{ id: string; content: string }>) {
  const byId = new Map(existing.map((l) => [l.id, l.content]));
  return ops.map((o) => ({ ...o, before: o.id ? byId.get(o.id) ?? null : null }));
}

/**
 * Bot trả lời thử một câu khách, dùng cấu hình thật của nick + bài học đang dạy
 * (chưa lưu). Không gửi, không ghi nhật ký.
 */
export async function trySimulate(orgId: string, zaloAccountId: string, customerText: string, pending: LessonOp[], gender: 'male' | 'female' | null, history: TeachTurn[]) {
  const profile = await getProfile(orgId, zaloAccountId, { fresh: true });
  if (!profile) throw new Error('Nick chưa có cấu hình AI');
  const ai = await aiFor(orgId);
  const existing = await existingLessons(zaloAccountId);
  // Bài đang dạy + bài chủ shop đã dạy trước đó → ưu tiên trên skill; bài tự rút → dưới skill.
  const touched = new Set(pending.filter((o) => o.id).map((o) => o.id!));
  const ownerExisting = existing.filter((l) => OWNER_LESSON_SOURCES.includes(l.source) || touched.has(l.id));
  const ownerLessons = applyOpsPreview(ownerExisting, pending).slice(0, MAX_ACTIVE_LESSONS + 10);
  const lessons = profile.learningEnabled
    ? existing.filter((l) => !OWNER_LESSON_SOURCES.includes(l.source) && !touched.has(l.id)).map((l) => l.content)
    : [];
  // Hội thoại thử = các lượt khách/bot trước đó trong buổi dạy.
  const convo = history.filter((m) => m.role === 'customer' || m.role === 'bot').slice(-8)
    .map((m) => `${m.role === 'customer' ? 'khách' : 'shop (tự động)'}: ${clip(m.content, 400)}`);
  let products: CatalogProduct[] = [];
  if (profile.useProductCatalog && isCatalogEnabled()) {
    const queries = await extractProductQueries(ai, customerText, convo);
    if (queries.length) products = await searchProducts(queries, 8).catch(() => []);
  }
  const system = buildSystemPrompt(
    profile.persona, profile.extraInstruction, lessons, pickGuideFiles(profile.guideFiles, customerText),
    profile.addressByGender ? { selfPronoun: profile.selfPronoun || 'em', gender } : null,
    renderProducts(products), { firstMessage: convo.length === 0, ownerLessons },
  );
  const raw = await generateText(ai.provider, ai.apiKey, ai.model, system,
    ['<lich_su_chat>', ...convo, '</lich_su_chat>', '<tin_khach_vua_gui>', customerText.slice(0, 1200), '</tin_khach_vua_gui>'].join('\n'), 1000);
  const d = parseDecision(raw);
  if (!d) return { action: 'error' as const, reply: 'Bot trả về sai định dạng, thử lại nhé.', reason: '', images: [] as string[] };
  return {
    action: d.action,
    reply: cleanStyle(d.reply || ''),
    reason: d.reason,
    images: d.productIds.map((id) => products.find((p) => p.id === id)?.name).filter((n): n is string => !!n),
  };
}

/**
 * Kết thúc buổi dạy: gộp đề xuất với bài học cũ thành bộ gọn rồi lưu.
 * Trả số bài thêm / sửa / bỏ và danh sách bài học sau cùng.
 */
export async function finishTeaching(orgId: string, zaloAccountId: string, transcript: TeachTurn[], pending: LessonOp[]) {
  const existing = await existingLessons(zaloAccountId);
  const ids = new Set(existing.map((l) => l.id));
  let ops = normalizeOps(pending, ids);

  // Lượt gộp: tránh danh sách phình dài — hợp nhất bài trùng ý, giữ tối đa MAX_ACTIVE_LESSONS.
  try {
    const ai = await aiFor(orgId);
    const system = [
      'Bạn chốt bộ BÀI HỌC cho bot trả lời khách sau một buổi chủ shop dạy.',
      'Nhận: bài học hiện có, các thao tác đề xuất trong buổi dạy, và nội dung buổi dạy.',
      `Việc: trả về danh sách thao tác CUỐI CÙNG sao cho bộ bài học sau khi áp dụng gọn, không trùng ý, không mâu thuẫn, tối đa ${MAX_ACTIVE_LESSONS} bài.`,
      'Giữ trọn ý chủ shop vừa dạy. Được gộp nhiều bài cũ cùng chủ đề thành 1 (update 1 bài + remove các bài còn lại).',
      ...LESSON_STYLE,
      'Trả DUY NHẤT JSON: {"ops": [{"op": "add" | "update" | "remove", "id": "...", "content": "..."}]}',
    ].join('\n');
    const prompt = [
      '<bai_hoc_hien_co>', ...existing.map((l) => `- [${l.id}] (${l.source}) ${l.content}`), '</bai_hoc_hien_co>',
      '<de_xuat>', JSON.stringify(ops), '</de_xuat>',
      '<buoi_day>', renderTranscript(transcript), '</buoi_day>',
    ].join('\n');
    const raw = await generateText(ai.provider, ai.apiKey, ai.model, system, prompt, 1200);
    const parsed = parseJson<{ ops?: unknown }>(raw);
    if (parsed && Array.isArray(parsed.ops)) {
      const merged = normalizeOps(parsed.ops, ids);
      if (merged.length) ops = merged;
    }
  } catch (err: any) {
    logger.warn(`[ai-teach] lượt gộp bài học lỗi, lưu đề xuất nguyên trạng: ${err?.message ?? err}`);
  }

  let added = 0; let updated = 0; let removed = 0;
  const seen = new Set(existing.map((l) => fold(l.content)));
  for (const o of ops) {
    if (o.op === 'remove' && o.id) {
      await prisma.aiLesson.updateMany({ where: { id: o.id, zaloAccountId }, data: { active: false } });
      removed++;
    } else if (o.op === 'update' && o.id && o.content) {
      await prisma.aiLesson.updateMany({ where: { id: o.id, zaloAccountId }, data: { content: o.content, source: 'teach' } });
      updated++;
    } else if (o.op === 'add' && o.content && !seen.has(fold(o.content))) {
      await prisma.aiLesson.create({ data: { orgId, zaloAccountId, content: o.content, source: 'teach' } });
      seen.add(fold(o.content));
      added++;
    }
  }
  const lessons = await prisma.aiLesson.findMany({
    where: { zaloAccountId }, orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }], take: 200,
  });
  logger.info(`[ai-teach] nick=${zaloAccountId} buổi dạy: +${added} ~${updated} -${removed}`);
  return { added, updated, removed, lessons };
}

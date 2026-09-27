/**
 * learning-service.ts — vòng tự học (feedback loop) của AI tự trả lời, theo từng nick.
 *
 * 1. CHẤM KẾT QUẢ mỗi lượt (≈30 phút sau khi AI trả lời / chạy thử):
 *      sent    → customer_replied | no_reply | staff_intervened | customer_unhappy
 *      dry_run → staff_answered (nhân viên trả lời thật — mẫu để so) | no_staff
 * 2. PHẢN HỒI CỦA CHỦ SHOP (👍/👎 + "câu đúng lẽ ra là") → rút 1 bài học NGAY.
 * 3. HỌC HẰNG ĐÊM: đọc các lượt trong ngày (nhất là lượt nhân viên phải vào sửa)
 *    + bài học hiện có → thêm bài học mới, gộp trùng, bỏ bài học sai/lỗi thời.
 * 4. Bài học đang bật được đưa vào prompt các lượt sau (context-builder).
 *
 * An toàn: chỉ học từ tin NHÂN VIÊN gõ và phản hồi của chủ shop. Lời khách chỉ là
 * bối cảnh — không bao giờ thành "luật" (khách không thể dạy AI báo giá sai).
 * Bài học được lọc SĐT / số tài khoản / mật khẩu trước khi lưu.
 */
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import { getAiConfig, getProviderApiKey, generateText } from '../ai-service.js';
import { orgDayRange, parseOffsetMinutes } from '../daily-brief-service.js';
import { getProfile } from './config-service.js';
import { clip, fold, localHour } from './guardrails.js';

/** Chấm kết quả sau khoảng này. */
export const OUTCOME_WINDOW_MS = 30 * 60_000;
/** Tối đa bài học đang bật mỗi nick (đưa vào prompt). */
export const MAX_ACTIVE_LESSONS = 30;
const LESSON_MAX_CHARS = 300;
/** Giờ học hằng đêm (giờ địa phương của tổ chức). */
const DAILY_LEARN_HOUR = 23;

export type Outcome =
  | 'customer_replied' | 'no_reply' | 'staff_intervened' | 'customer_unhappy'
  | 'staff_answered' | 'no_staff';

/** Kết quả được coi là tốt / cần học. Dùng cho điểm chất lượng. */
export const GOOD_OUTCOMES: Outcome[] = ['customer_replied'];
export const BAD_OUTCOMES: Outcome[] = ['staff_intervened', 'customer_unhappy'];

const UNHAPPY = /(sai roi|khong dung|khong phai|noi gi vay|tra loi linh tinh|bot a|may tra loi|gap nguoi that|cho gap|nhan vien dau|khong hieu|hoi mot dang|chan qua|buc minh|lua dao|te qua|kem qua)/;

type FollowMsg = { senderType: string; sentVia: string; content: string | null; contentType: string };

/** Hàm thuần: chấm kết quả một lượt dựa trên các tin trong cửa sổ sau đó. */
export function classifyOutcome(decision: string, after: FollowMsg[]): { outcome: Outcome; staff: string | null; customer: string | null } {
  const text = (m: FollowMsg) => (m.contentType === 'text' || m.contentType === 'rich' ? (m.content ?? '').trim() : `(${m.contentType})`);
  const staffMsgs = after.filter((m) => m.senderType === 'self' && m.sentVia !== 'automation');
  const customerMsgs = after.filter((m) => m.senderType === 'contact');
  const staff = staffMsgs.length ? clip(staffMsgs.map(text).join('\n'), 1500) : null;
  const customer = customerMsgs.length ? clip(customerMsgs.map(text).join('\n'), 1500) : null;

  if (decision === 'dry_run') return { outcome: staff ? 'staff_answered' : 'no_staff', staff, customer };
  if (staff) return { outcome: 'staff_intervened', staff, customer };
  if (customer && UNHAPPY.test(fold(customer))) return { outcome: 'customer_unhappy', staff, customer };
  if (customer) return { outcome: 'customer_replied', staff, customer };
  return { outcome: 'no_reply', staff, customer };
}

/** Bỏ SĐT, số tài khoản dài, mật khẩu/OTP khỏi bài học; cắt độ dài. null nếu rỗng. */
export function sanitizeLesson(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(/(\+?84|0)(\s?\d){8,10}/g, '[SĐT]');
  t = t.replace(/\b\d{9,}\b/g, '[số]');
  if (/(mat khau|password|\botp\b|ma xac thuc)\s*[:=]/.test(fold(t))) return null;
  if (t.length < 8) return null;
  return t.length > LESSON_MAX_CHARS ? `${t.slice(0, LESSON_MAX_CHARS)}…` : t;
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

async function aiFor(orgId: string) {
  const ai = await getAiConfig(orgId);
  if (!ai.enabled) return null;
  const apiKey = await getProviderApiKey(orgId, ai.provider);
  return apiKey ? { provider: ai.provider, model: ai.model, apiKey } : null;
}

// ── 1. Chấm kết quả ────────────────────────────────────────────────────────

/** Chấm các lượt đủ 30 phút mà chưa có kết quả. Trả số lượt đã chấm. */
export async function evaluateOutcomes(now = new Date(), limit = 200): Promise<number> {
  const logs = await prisma.aiAutoReplyLog.findMany({
    where: {
      decision: { in: ['sent', 'dry_run'] },
      outcome: null,
      createdAt: { lt: new Date(now.getTime() - OUTCOME_WINDOW_MS), gt: new Date(now.getTime() - 3 * 86_400_000) },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, conversationId: true, decision: true, createdAt: true },
  });
  for (const log of logs) {
    const after = await prisma.message.findMany({
      where: {
        conversationId: log.conversationId,
        isDeleted: false,
        sentAt: { gt: log.createdAt, lte: new Date(log.createdAt.getTime() + OUTCOME_WINDOW_MS) },
      },
      orderBy: { sentAt: 'asc' },
      take: 20,
      select: { senderType: true, sentVia: true, content: true, contentType: true },
    });
    const r = classifyOutcome(log.decision, after);
    await prisma.aiAutoReplyLog.update({
      where: { id: log.id },
      data: { outcome: r.outcome, outcomeAt: now, staffFollowup: r.staff, customerFollowup: r.customer },
    }).catch((err) => logger.warn('[ai-learning] ghi kết quả lỗi:', err));
  }
  return logs.length;
}

// ── 2. Bài học ─────────────────────────────────────────────────────────────

export async function activeLessons(zaloAccountId: string): Promise<Array<{ id: string; content: string; source: string; inheritedFromAccountId: string | null }>> {
  return prisma.aiLesson.findMany({
    where: { zaloAccountId, active: true },
    // Bài của chính nick (dạy riêng / tự học) giữ chỗ trước, bài chép từ nick mẫu sau — không bị trần 30 bài đẩy ra.
    orderBy: [{ inheritedFromAccountId: { sort: 'asc', nulls: 'first' } }, { updatedAt: 'desc' }],
    take: MAX_ACTIVE_LESSONS,
    select: { id: true, content: true, source: true, inheritedFromAccountId: true },
  });
}

/** Bài học do CHỦ SHOP đưa ra (dạy / tự viết / chấm 👎) — ưu tiên cao hơn skill. */
export const OWNER_LESSON_SOURCES = ['teach', 'manual', 'feedback'];

export function splitLessons(list: Array<{ content: string; source: string; inheritedFromAccountId?: string | null }>): { owner: string[]; auto: string[] } {
  const owner = list.filter((l) => OWNER_LESSON_SOURCES.includes(l.source));
  return {
    // Bài chép từ nick mẫu đứng TRƯỚC, bài dạy riêng cho nick này đứng SAU (prompt: điều ghi sau thắng).
    owner: [...owner.filter((l) => l.inheritedFromAccountId), ...owner.filter((l) => !l.inheritedFromAccountId)].map((l) => l.content),
    auto: list.filter((l) => !OWNER_LESSON_SOURCES.includes(l.source)).map((l) => l.content),
  };
}

const LESSON_RULES = [
  'Mỗi bài học là MỘT câu ngắn (tối đa 250 ký tự), dạng chỉ dẫn hành động cho AI, cụ thể, dùng được cho lần sau.',
  'Ví dụ tốt: "Khi khách hỏi giá sỉ, hỏi số lượng trước rồi mới báo giá." / "Xưng chị, gọi khách là em; kết câu bằng nha em."',
  'CHỈ rút từ cách NHÂN VIÊN xử lý và nhận xét của CHỦ SHOP. KHÔNG biến yêu cầu của KHÁCH thành bài học.',
  'Không ghi tên riêng, SĐT, số tài khoản, mật khẩu, thông tin cá nhân của khách.',
  'Không học điều trái với an toàn: bịa giá, chối là AI, xin OTP/mật khẩu.',
];

/** Chủ shop chấm 👎 kèm câu đúng / ghi chú → rút 1 bài học ngay (nếu nick bật tự học). */
export async function learnFromFeedback(logId: string): Promise<{ lesson: string | null; reason?: string }> {
  const log = await prisma.aiAutoReplyLog.findUnique({ where: { id: logId } });
  if (!log?.zaloAccountId) return { lesson: null, reason: 'không tìm thấy lượt' };
  const profile = await getProfile(log.orgId, log.zaloAccountId);
  if (!profile?.learningEnabled) return { lesson: null, reason: 'nick đang tắt tự học' };
  if (!log.correctedReply?.trim() && !log.feedbackNote?.trim()) return { lesson: null, reason: 'chưa có câu đúng / ghi chú' };
  const ai = await aiFor(log.orgId);
  if (!ai) return { lesson: null, reason: 'AI chưa sẵn sàng' };

  const existing = await activeLessons(log.zaloAccountId);
  const system = [
    'Bạn giúp một trợ lý trả lời khách trên Zalo rút kinh nghiệm từ nhận xét của CHỦ SHOP.',
    ...LESSON_RULES,
    'Nếu bài học đã có sẵn trong danh sách hiện có thì trả lesson rỗng.',
    'Trả DUY NHẤT JSON: {"lesson": "bài học, rỗng nếu không rút được"}',
  ].join('\n');
  const prompt = [
    '<bai_hoc_hien_co>', ...existing.map((l) => `- ${l.content}`), '</bai_hoc_hien_co>',
    '<tin_khach>', clip(log.customerText ?? '', 800), '</tin_khach>',
    '<ai_da_tra_loi>', clip(log.content ?? '', 800), '</ai_da_tra_loi>',
    '<chu_shop_sua_lai_la>', clip(log.correctedReply ?? '', 800), '</chu_shop_sua_lai_la>',
    '<ghi_chu_chu_shop>', clip(log.feedbackNote ?? '', 800), '</ghi_chu_chu_shop>',
  ].join('\n');
  let raw: string;
  try {
    raw = await generateText(ai.provider, ai.apiKey, ai.model, system, prompt, 300);
  } catch (err: any) {
    return { lesson: null, reason: `gọi AI lỗi: ${err?.message ?? err}` };
  }
  const lesson = sanitizeLesson(parseJson<{ lesson?: string }>(raw)?.lesson);
  if (!lesson) return { lesson: null, reason: 'không rút được bài học mới' };
  await prisma.aiLesson.create({
    data: { orgId: log.orgId, zaloAccountId: log.zaloAccountId, content: lesson, source: 'feedback', evidence: [log.id] },
  });
  await trimLessons(log.zaloAccountId);
  return { lesson };
}

/** Giữ tối đa MAX_ACTIVE_LESSONS bài đang bật: tắt bớt bài tự học cũ nhất (không đụng bài viết tay). */
async function trimLessons(zaloAccountId: string) {
  const active = await prisma.aiLesson.findMany({
    where: { zaloAccountId, active: true },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, source: true },
  });
  const extra = active.slice(MAX_ACTIVE_LESSONS).filter((l) => l.source !== 'manual' && l.source !== 'teach').map((l) => l.id);
  if (extra.length) await prisma.aiLesson.updateMany({ where: { id: { in: extra } }, data: { active: false } });
}

// ── 3. Học hằng đêm ────────────────────────────────────────────────────────

export type DailyLearnResult = { added: number; removed: number; reviewed: number; skipped?: string };

/**
 * Đọc các lượt từ lần học trước (tối đa 2 ngày), ưu tiên lượt nhân viên phải
 * vào sửa / khách phàn nàn / chủ shop chấm 👎 / chạy thử có câu trả lời thật
 * của nhân viên, cộng vài lượt tốt làm mẫu → cập nhật bộ bài học của nick.
 */
export async function runDailyLearning(orgId: string, zaloAccountId: string, now = new Date()): Promise<DailyLearnResult> {
  const profile = await getProfile(orgId, zaloAccountId, { fresh: true });
  if (!profile) return { added: 0, removed: 0, reviewed: 0, skipped: 'nick chưa cấu hình' };
  if (!profile.learningEnabled) return { added: 0, removed: 0, reviewed: 0, skipped: 'nick đang tắt tự học' };

  const since = profile.lastLearnedAt
    ? new Date(Math.max(new Date(profile.lastLearnedAt).getTime(), now.getTime() - 2 * 86_400_000))
    : new Date(now.getTime() - 2 * 86_400_000);
  const logs = await prisma.aiAutoReplyLog.findMany({
    where: { zaloAccountId, decision: { in: ['sent', 'dry_run', 'handoff'] }, createdAt: { gt: since } },
    orderBy: { createdAt: 'desc' },
    take: 300,
    select: {
      id: true, decision: true, customerText: true, content: true, outcome: true,
      staffFollowup: true, customerFollowup: true, feedback: true, correctedReply: true, feedbackNote: true, reason: true,
    },
  });
  const markDone = () => prisma.aiAutoReplyProfile.update({ where: { zaloAccountId }, data: { lastLearnedAt: now } });

  const teaching = logs.filter((l) =>
    l.feedback === 'bad' || l.correctedReply || l.outcome === 'staff_intervened' || l.outcome === 'customer_unhappy'
    || l.outcome === 'staff_answered' || l.feedback === 'good');
  if (teaching.length === 0) {
    await markDone();
    return { added: 0, removed: 0, reviewed: logs.length, skipped: 'không có lượt nào để học' };
  }
  const ai = await aiFor(orgId);
  if (!ai) return { added: 0, removed: 0, reviewed: 0, skipped: 'AI chưa sẵn sàng' };

  const cases = teaching.slice(0, 25).map((l, i) => [
    `### Lượt ${i + 1} (${l.decision === 'dry_run' ? 'chạy thử' : 'đã gửi'}; kết quả: ${l.outcome ?? 'chưa chấm'}${l.feedback ? `; chủ shop chấm: ${l.feedback === 'good' ? '👍' : '👎'}` : ''})`,
    `Khách: ${clip(l.customerText ?? '', 400)}`,
    `AI: ${clip(l.content ?? '(không trả lời)', 400)}`,
    l.staffFollowup ? `Nhân viên thực tế nhắn: ${clip(l.staffFollowup, 400)}` : '',
    l.correctedReply ? `Chủ shop sửa lại là: ${clip(l.correctedReply, 400)}` : '',
    l.feedbackNote ? `Ghi chú chủ shop: ${clip(l.feedbackNote, 300)}` : '',
    l.customerFollowup && l.outcome === 'customer_unhappy' ? `Khách phản ứng: ${clip(l.customerFollowup, 300)}` : '',
  ].filter(Boolean).join('\n'));

  const existing = await prisma.aiLesson.findMany({
    where: { zaloAccountId, active: true },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, content: true, source: true },
  });
  const system = [
    'Bạn là người huấn luyện một trợ lý AI trả lời khách trên Zalo cho một nick bán hàng.',
    'Nhận: bài học hiện có + các lượt trả lời gần đây (kèm cách nhân viên thực tế xử lý và nhận xét của chủ shop).',
    'Việc: rút ra bài học MỚI giúp AI trả lời giống nhân viên giỏi hơn; và chỉ ra bài học hiện có nào SAI hoặc bị lượt mới chứng minh là lỗi thời.',
    ...LESSON_RULES,
    'Tối đa 5 bài học mới, không trùng ý bài hiện có. Không bỏ bài có nguồn "manual" hoặc "teach" (chủ shop tự viết / trực tiếp dạy).',
    'Trả DUY NHẤT JSON: {"add": ["bài học mới"], "remove": ["id bài học hiện có cần bỏ"]}',
  ].join('\n');
  const prompt = [
    '<bai_hoc_hien_co>',
    ...existing.map((l) => `- [${l.id}] (${l.source}) ${l.content}`),
    '</bai_hoc_hien_co>',
    '<cac_luot_gan_day>',
    ...cases,
    '</cac_luot_gan_day>',
  ].join('\n');

  let raw: string;
  try {
    raw = await generateText(ai.provider, ai.apiKey, ai.model, system, prompt, 900);
  } catch (err: any) {
    logger.warn(`[ai-learning] học hằng ngày nick=${zaloAccountId} lỗi: ${err?.message ?? err}`);
    return { added: 0, removed: 0, reviewed: teaching.length, skipped: 'gọi AI lỗi' };
  }
  const parsed = parseJson<{ add?: unknown; remove?: unknown }>(raw);
  if (!parsed) return { added: 0, removed: 0, reviewed: teaching.length, skipped: 'AI trả sai định dạng' };

  const known = new Set(existing.map((l) => fold(l.content)));
  const toAdd = (Array.isArray(parsed.add) ? parsed.add : [])
    .map(sanitizeLesson)
    .filter((l): l is string => !!l && !known.has(fold(l)))
    .slice(0, 5);
  const removable = new Set(existing.filter((l) => l.source !== 'manual' && l.source !== 'teach').map((l) => l.id));
  const toRemove = (Array.isArray(parsed.remove) ? parsed.remove : [])
    .filter((id): id is string => typeof id === 'string' && removable.has(id));

  const evidence = teaching.slice(0, 25).map((l) => l.id);
  if (toAdd.length) {
    await prisma.aiLesson.createMany({
      data: toAdd.map((content) => ({ orgId, zaloAccountId, content, source: 'daily', evidence })),
    });
  }
  if (toRemove.length) await prisma.aiLesson.updateMany({ where: { id: { in: toRemove } }, data: { active: false } });
  await trimLessons(zaloAccountId);
  await markDone();
  logger.info(`[ai-learning] nick=${zaloAccountId} học ${teaching.length} lượt → +${toAdd.length} / -${toRemove.length} bài học`);
  return { added: toAdd.length, removed: toRemove.length, reviewed: teaching.length };
}

// ── 4. Điểm chất lượng theo ngày ───────────────────────────────────────────

export type DayQuality = {
  date: string; sent: number; good: number; bad: number; noReply: number; handoff: number;
  feedbackGood: number; feedbackBad: number; score: number | null;
};

/**
 * Điểm chất lượng mỗi ngày = lượt tốt / (lượt tốt + lượt xấu), trong đó
 * tốt = khách trả lời tiếp hoặc chủ shop 👍; xấu = nhân viên phải vào sửa,
 * khách phàn nàn hoặc chủ shop 👎. (Chủ shop chấm thì ưu tiên chấm tay.)
 */
export async function qualityByDay(orgId: string, zaloAccountId: string, days = 14, now = new Date()): Promise<DayQuality[]> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
  const { start: todayStart } = orgDayRange(now, org?.timezone);
  const from = new Date(todayStart.getTime() - (days - 1) * 86_400_000);
  const logs = await prisma.aiAutoReplyLog.findMany({
    where: { zaloAccountId, createdAt: { gte: from }, decision: { in: ['sent', 'handoff'] } },
    select: { decision: true, outcome: true, feedback: true, createdAt: true },
  });
  const offset = parseOffsetMinutes(org?.timezone) * 60_000;
  const out: DayQuality[] = [];
  for (let i = 0; i < days; i++) {
    const s = new Date(from.getTime() + i * 86_400_000);
    const e = new Date(s.getTime() + 86_400_000);
    const day = logs.filter((l) => l.createdAt >= s && l.createdAt < e);
    const sent = day.filter((l) => l.decision === 'sent');
    const isGood = (l: typeof sent[number]) => l.feedback ? l.feedback === 'good' : GOOD_OUTCOMES.includes(l.outcome as Outcome);
    const isBad = (l: typeof sent[number]) => l.feedback ? l.feedback === 'bad' : BAD_OUTCOMES.includes(l.outcome as Outcome);
    const good = sent.filter(isGood).length;
    const bad = sent.filter(isBad).length;
    out.push({
      date: new Date(s.getTime() + offset).toISOString().slice(0, 10),
      sent: sent.length,
      good,
      bad,
      noReply: sent.filter((l) => !l.feedback && l.outcome === 'no_reply').length,
      handoff: day.filter((l) => l.decision === 'handoff').length,
      feedbackGood: sent.filter((l) => l.feedback === 'good').length,
      feedbackBad: sent.filter((l) => l.feedback === 'bad').length,
      score: good + bad > 0 ? Math.round((good / (good + bad)) * 100) : null,
    });
  }
  return out;
}

// ── Lịch chạy ─────────────────────────────────────────────────────────────

let outcomeTimer: NodeJS.Timeout | null = null;
let learnTimer: NodeJS.Timeout | null = null;

/** Nick nào đến giờ học (23h giờ địa phương) mà hôm nay chưa học thì học. */
export async function runDueDailyLearning(now = new Date()): Promise<void> {
  const profiles = await prisma.aiAutoReplyProfile.findMany({
    where: { learningEnabled: true },
    select: { orgId: true, zaloAccountId: true, lastLearnedAt: true },
  });
  const tzCache = new Map<string, string | null>();
  for (const p of profiles) {
    if (!tzCache.has(p.orgId)) {
      const org = await prisma.organization.findUnique({ where: { id: p.orgId }, select: { timezone: true } });
      tzCache.set(p.orgId, org?.timezone ?? null);
    }
    const tz = tzCache.get(p.orgId);
    if (localHour(now, parseOffsetMinutes(tz)) < DAILY_LEARN_HOUR) continue;
    const { start } = orgDayRange(now, tz);
    if (p.lastLearnedAt && p.lastLearnedAt >= start) continue;
    try {
      await runDailyLearning(p.orgId, p.zaloAccountId, now);
    } catch (err) {
      logger.error(`[ai-learning] học hằng ngày nick=${p.zaloAccountId} lỗi:`, err);
    }
  }
}

export function startLearningScheduler(): void {
  if (outcomeTimer) return;
  outcomeTimer = setInterval(() => {
    evaluateOutcomes().catch((err) => logger.warn('[ai-learning] chấm kết quả lỗi:', err));
  }, 10 * 60_000);
  learnTimer = setInterval(() => {
    runDueDailyLearning().catch((err) => logger.warn('[ai-learning] lịch học lỗi:', err));
  }, 15 * 60_000);
  outcomeTimer.unref?.();
  learnTimer.unref?.();
  logger.info('[ai-learning] vòng tự học đã bật — chấm kết quả mỗi 10 phút, học hằng đêm lúc 23h');
}

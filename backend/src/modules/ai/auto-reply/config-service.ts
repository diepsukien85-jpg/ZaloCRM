/**
 * config-service.ts — cấu hình AI tự trả lời + kho kịch bản (bộ khung trả lời).
 *
 * Mỗi nick Zalo một cấu hình riêng (xưng hô, lời dặn, khung giờ, thẻ kích
 * hoạt, trần tin). Mặc định TẮT. Đọc trên mọi tin đến → cache 30 giây, xoá
 * cache ngay khi lưu.
 */
import { prisma } from '../../../shared/database/prisma-client.js';

/* Khách nhắn trúng những từ này thì AI không trả lời, để người thật xử lý. */
export const DEFAULT_BLOCKED_KEYWORDS = [
  'hoàn tiền', 'trả hàng', 'đổi trả', 'khiếu nại', 'lừa đảo', 'kiện tụng', 'khởi kiện', 'luật sư',
  'công an', 'báo chí', 'tố cáo', 'bồi thường', 'bóc phốt', 'huỷ đơn', 'hủy đơn',
];

/** Trần độ dài hướng dẫn chính (SKILL.md) — luôn nằm trong prompt. */
export const GUIDE_MAX_CHARS = 30000;
/** Tài liệu tham khảo của skill (references/*.md). */
export const GUIDE_FILES_MAX = 30;
export const GUIDE_FILE_MAX_CHARS = 40000;
export const GUIDE_FILES_TOTAL_MAX_CHARS = 200000;
export type GuideFileMode = 'always' | 'auto' | 'off';
export type GuideFile = { path: string; content: string; mode: GuideFileMode };

export type AutoReplyMode = 'auto' | 'dry_run';

/** Cấu hình AI tự trả lời của MỘT nick (mỗi nick một bản riêng). */
export type AutoReplyProfile = {
  zaloAccountId: string;
  enabled: boolean;
  mode: AutoReplyMode;
  triggerTags: string[];
  hourStart: number;
  hourEnd: number;
  debounceSeconds: number;
  maxRepliesPerDay: number;
  maxRepliesPerConvPerDay: number;
  skipIfStaffRepliedWithinMin: number;
  blockedKeywords: string[];
  /** cũ — giao diện mới gộp vào extraInstruction. */
  persona: string | null;
  /** Hướng dẫn cho AI (skill): vai trò, xưng hô, cách tư vấn… */
  extraInstruction: string | null;
  /** Tên file skill đã tải lên (null nếu viết tay). */
  guideFileName: string | null;
  /** Tài liệu tham khảo của skill: luôn dùng / tự chọn theo câu hỏi / không dùng. */
  guideFiles: GuideFile[];
  verifyGrounding: boolean;
  /** Xưng hô theo giới tính Zalo: nữ → chị, nam → anh (AI tự xưng selfPronoun). */
  addressByGender: boolean;
  selfPronoun: string;
  /** Tra kho sản phẩm bot-noi-bo để tư vấn cụ thể; gửi kèm ảnh sản phẩm. */
  useProductCatalog: boolean;
  sendProductImages: boolean;
  /** Chuyển người → báo Telegram (chat id riêng nick, null = mặc định server). */
  notifyHandoff: boolean;
  handoffChatId: string | null;
  handoffPauseMinutes: number;
  /** Vòng tự học: rút bài học từ kết quả trả lời + phản hồi của chủ shop. */
  learningEnabled: boolean;
  lastLearnedAt: string | null;
  /** "Học theo nick khác": nick mẫu đã chép hướng dẫn + bài học (null = tự cấu hình). */
  clonedFromAccountId: string | null;
  clonedAt: string | null;
};
export type ProfileInput = Partial<Omit<AutoReplyProfile, 'zaloAccountId' | 'lastLearnedAt' | 'clonedFromAccountId' | 'clonedAt'>>;

const CACHE_MS = 30_000;
/** zaloAccountId → profile (null = nick chưa cấu hình). */
const cache = new Map<string, { at: number; value: AutoReplyProfile | null }>();

export function normalizeGuideFiles(v: unknown): GuideFile[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .filter((f) => typeof f.path === 'string' && typeof f.content === 'string')
    .map((f) => ({
      path: String(f.path).trim(),
      content: String(f.content).replace(/\r\n/g, '\n').trim(),
      mode: (['always', 'auto', 'off'].includes(f.mode as string) ? f.mode : 'auto') as GuideFileMode,
    }))
    .filter((f) => f.path && f.content);
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

type Row = NonNullable<Awaited<ReturnType<typeof prisma.aiAutoReplyProfile.findUnique>>>;

function normalize(row: Row): AutoReplyProfile {
  return {
    zaloAccountId: row.zaloAccountId,
    enabled: row.enabled,
    mode: row.mode === 'auto' ? 'auto' : 'dry_run',
    triggerTags: strArr(row.triggerTags),
    hourStart: row.hourStart,
    hourEnd: row.hourEnd,
    debounceSeconds: row.debounceSeconds,
    maxRepliesPerDay: row.maxRepliesPerDay,
    maxRepliesPerConvPerDay: row.maxRepliesPerConvPerDay,
    skipIfStaffRepliedWithinMin: row.skipIfStaffRepliedWithinMin,
    blockedKeywords: strArr(row.blockedKeywords),
    persona: row.persona,
    extraInstruction: row.extraInstruction,
    guideFileName: row.guideFileName,
    guideFiles: normalizeGuideFiles(row.guideFiles),
    addressByGender: row.addressByGender,
    selfPronoun: row.selfPronoun,
    useProductCatalog: row.useProductCatalog,
    sendProductImages: row.sendProductImages,
    notifyHandoff: row.notifyHandoff,
    handoffChatId: row.handoffChatId,
    handoffPauseMinutes: row.handoffPauseMinutes,
    learningEnabled: row.learningEnabled,
    lastLearnedAt: row.lastLearnedAt ? row.lastLearnedAt.toISOString() : null,
    verifyGrounding: row.verifyGrounding,
    clonedFromAccountId: row.clonedFromAccountId,
    clonedAt: row.clonedAt ? row.clonedAt.toISOString() : null,
  };
}

/** Giá trị mặc định cho nick chưa có cấu hình (hiện ở form "Thêm nick"). */
export function defaultProfile(zaloAccountId: string): AutoReplyProfile {
  return {
    zaloAccountId, enabled: false, mode: 'dry_run', triggerTags: [], hourStart: 7, hourEnd: 22,
    debounceSeconds: 20, maxRepliesPerDay: 300, maxRepliesPerConvPerDay: 15, skipIfStaffRepliedWithinMin: 10,
    blockedKeywords: [...DEFAULT_BLOCKED_KEYWORDS], persona: null, extraInstruction: null, guideFileName: null, guideFiles: [], verifyGrounding: true,
    addressByGender: true, selfPronoun: 'em', learningEnabled: true, lastLearnedAt: null,
    useProductCatalog: true, sendProductImages: true, notifyHandoff: true, handoffChatId: null, handoffPauseMinutes: 60,
    clonedFromAccountId: null, clonedAt: null,
  };
}

/** Profile của nick (null nếu chưa cấu hình). Cache 30 giây — đọc trên mọi tin đến. */
export async function getProfile(orgId: string, zaloAccountId: string, opts: { fresh?: boolean } = {}): Promise<AutoReplyProfile | null> {
  const hit = cache.get(zaloAccountId);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const row = await prisma.aiAutoReplyProfile.findUnique({ where: { zaloAccountId } });
  const value = row && row.orgId === orgId ? normalize(row) : null;
  cache.set(zaloAccountId, { at: Date.now(), value });
  return value;
}

export async function listProfiles(orgId: string): Promise<AutoReplyProfile[]> {
  const rows = await prisma.aiAutoReplyProfile.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
  return rows.map(normalize);
}

export function validateProfileInput(input: ProfileInput): string | null {
  const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return 'Công tắc bật/tắt không hợp lệ';
  if (input.mode !== undefined && input.mode !== 'auto' && input.mode !== 'dry_run') return 'Chế độ phải là auto hoặc dry_run';
  if (input.hourStart !== undefined || input.hourEnd !== undefined) {
    const s = input.hourStart ?? 0;
    const e = input.hourEnd ?? 24;
    if (!int(s, 0, 23) || !int(e, 1, 24) || s >= e) return 'Khung giờ: giờ bắt đầu 0-23, giờ kết thúc 1-24 và phải lớn hơn giờ bắt đầu';
  }
  if (input.debounceSeconds !== undefined && !int(input.debounceSeconds, 3, 300)) return 'Thời gian gom tin phải từ 3 đến 300 giây';
  if (input.maxRepliesPerDay !== undefined && !int(input.maxRepliesPerDay, 1, 10000)) return 'Số tin AI mỗi ngày phải từ 1 đến 10000';
  if (input.maxRepliesPerConvPerDay !== undefined && !int(input.maxRepliesPerConvPerDay, 1, 500)) return 'Số tin mỗi khách mỗi ngày phải từ 1 đến 500';
  if (input.skipIfStaffRepliedWithinMin !== undefined && !int(input.skipIfStaffRepliedWithinMin, 0, 1440)) return 'Thời gian nhường nhân viên phải từ 0 đến 1440 phút';
  for (const key of ['triggerTags', 'blockedKeywords'] as const) {
    const v = input[key];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) return `${key} phải là mảng chuỗi`;
  }
  if (input.triggerTags && input.triggerTags.length > 50) return 'Tối đa 50 thẻ kích hoạt';
  if (input.persona != null && input.persona.length > 1000) return 'Vai trò / xưng hô tối đa 1000 ký tự';
  if (input.extraInstruction != null && input.extraInstruction.length > GUIDE_MAX_CHARS) return `Hướng dẫn cho AI tối đa ${GUIDE_MAX_CHARS.toLocaleString('vi-VN')} ký tự`;
  if (input.guideFileName != null && (typeof input.guideFileName !== 'string' || input.guideFileName.length > 200)) return 'Tên file hướng dẫn không hợp lệ';
  if (input.guideFiles !== undefined) {
    if (!Array.isArray(input.guideFiles)) return 'Tài liệu tham khảo không hợp lệ';
    if (input.guideFiles.length > GUIDE_FILES_MAX) return `Tối đa ${GUIDE_FILES_MAX} tài liệu tham khảo`;
    let total = 0;
    for (const f of input.guideFiles) {
      if (!f || typeof f.path !== 'string' || !f.path.trim() || f.path.length > 300) return 'Tên tài liệu không hợp lệ';
      if (typeof f.content !== 'string') return `Nội dung tài liệu "${f.path}" không hợp lệ`;
      if (f.content.length > GUIDE_FILE_MAX_CHARS) return `Tài liệu "${f.path}" dài quá ${GUIDE_FILE_MAX_CHARS.toLocaleString('vi-VN')} ký tự`;
      if (!['always', 'auto', 'off'].includes(f.mode)) return `Chế độ của tài liệu "${f.path}" không hợp lệ`;
      total += f.content.length;
    }
    if (total > GUIDE_FILES_TOTAL_MAX_CHARS) return `Tổng tài liệu tham khảo vượt ${GUIDE_FILES_TOTAL_MAX_CHARS.toLocaleString('vi-VN')} ký tự`;
  }
  if (input.verifyGrounding !== undefined && typeof input.verifyGrounding !== 'boolean') return 'verifyGrounding phải là true/false';
  if (input.learningEnabled !== undefined && typeof input.learningEnabled !== 'boolean') return 'learningEnabled phải là true/false';
  if (input.addressByGender !== undefined && typeof input.addressByGender !== 'boolean') return 'addressByGender phải là true/false';
  for (const k of ['useProductCatalog', 'sendProductImages', 'notifyHandoff'] as const) {
    if (input[k] !== undefined && typeof input[k] !== 'boolean') return `${k} phải là true/false`;
  }
  if (input.handoffChatId != null && (typeof input.handoffChatId !== 'string' || !/^-?\d{3,20}$/.test(input.handoffChatId.trim()) && input.handoffChatId.trim() !== '')) return 'Telegram chat id phải là số';
  if (input.handoffPauseMinutes !== undefined && !int(input.handoffPauseMinutes, 0, 1440)) return 'Thời gian không báo lại phải từ 0 đến 1440 phút';
  if (input.selfPronoun !== undefined && (typeof input.selfPronoun !== 'string' || !input.selfPronoun.trim() || input.selfPronoun.length > 30)) return 'Tự xưng phải có 1-30 ký tự';
  return null;
}

export async function saveProfile(orgId: string, zaloAccountId: string, input: ProfileInput): Promise<AutoReplyProfile> {
  const data = {
    enabled: input.enabled,
    mode: input.mode,
    triggerTags: input.triggerTags?.map((t) => t.trim()).filter(Boolean),
    hourStart: input.hourStart,
    hourEnd: input.hourEnd,
    debounceSeconds: input.debounceSeconds,
    maxRepliesPerDay: input.maxRepliesPerDay,
    maxRepliesPerConvPerDay: input.maxRepliesPerConvPerDay,
    skipIfStaffRepliedWithinMin: input.skipIfStaffRepliedWithinMin,
    blockedKeywords: input.blockedKeywords?.map((t) => t.trim()).filter(Boolean),
    persona: input.persona === undefined ? undefined : (input.persona?.trim() || null),
    extraInstruction: input.extraInstruction === undefined ? undefined : (input.extraInstruction?.trim() || null),
    guideFileName: input.guideFileName === undefined ? undefined : (input.guideFileName?.trim() || null),
    guideFiles: input.guideFiles === undefined ? undefined : normalizeGuideFiles(input.guideFiles),
    verifyGrounding: input.verifyGrounding,
    learningEnabled: input.learningEnabled,
    addressByGender: input.addressByGender,
    selfPronoun: input.selfPronoun?.trim(),
    useProductCatalog: input.useProductCatalog,
    sendProductImages: input.sendProductImages,
    notifyHandoff: input.notifyHandoff,
    handoffChatId: input.handoffChatId === undefined ? undefined : (input.handoffChatId?.trim() || null),
    handoffPauseMinutes: input.handoffPauseMinutes,
  };
  const row = await prisma.aiAutoReplyProfile.upsert({
    where: { zaloAccountId },
    create: { orgId, zaloAccountId, ...data, blockedKeywords: data.blockedKeywords ?? DEFAULT_BLOCKED_KEYWORDS },
    update: data,
  });
  const value = normalize(row);
  cache.set(zaloAccountId, { at: Date.now(), value });
  return value;
}

export async function deleteProfile(orgId: string, zaloAccountId: string): Promise<number> {
  const res = await prisma.aiAutoReplyProfile.deleteMany({ where: { orgId, zaloAccountId } });
  cache.delete(zaloAccountId);
  return res.count;
}

/** Chỉ cho test. */
export function _clearAutoReplyConfigCache(): void {
  cache.clear();
}

// ── Kho kịch bản ──────────────────────────────────────────────────────────

export type PlaybookInput = {
  /** null = dùng chung mọi nick; id nick = riêng nick đó. */
  zaloAccountId?: string | null;
  title?: string;
  category?: string | null;
  keywords?: string[];
  content?: string;
  priority?: number;
  enabled?: boolean;
};

export function validatePlaybookInput(input: PlaybookInput, creating: boolean): string | null {
  if (creating || input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) return 'Tiêu đề bắt buộc, tối đa 200 ký tự';
  }
  if (creating || input.content !== undefined) {
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 8000) return 'Nội dung bắt buộc, tối đa 8000 ký tự';
  }
  if (input.zaloAccountId != null && typeof input.zaloAccountId !== 'string') return 'Nick Zalo không hợp lệ';
  if (input.keywords !== undefined && (!Array.isArray(input.keywords) || input.keywords.some((k) => typeof k !== 'string'))) return 'Từ khoá phải là mảng chuỗi';
  if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 100)) return 'Ưu tiên phải từ 0 đến 100';
  if (input.category != null && (typeof input.category !== 'string' || input.category.length > 100)) return 'Nhóm tối đa 100 ký tự';
  return null;
}

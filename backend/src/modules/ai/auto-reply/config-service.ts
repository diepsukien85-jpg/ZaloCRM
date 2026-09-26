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

/** Trần độ dài hướng dẫn (skill) — đủ cho một file SKILL.md dài, vẫn giữ prompt vừa phải. */
export const GUIDE_MAX_CHARS = 20000;

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
  verifyGrounding: boolean;
  /** Vòng tự học: rút bài học từ kết quả trả lời + phản hồi của chủ shop. */
  learningEnabled: boolean;
  lastLearnedAt: string | null;
};
export type ProfileInput = Partial<Omit<AutoReplyProfile, 'zaloAccountId' | 'lastLearnedAt'>>;

const CACHE_MS = 30_000;
/** zaloAccountId → profile (null = nick chưa cấu hình). */
const cache = new Map<string, { at: number; value: AutoReplyProfile | null }>();

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
    learningEnabled: row.learningEnabled,
    lastLearnedAt: row.lastLearnedAt ? row.lastLearnedAt.toISOString() : null,
    verifyGrounding: row.verifyGrounding,
  };
}

/** Giá trị mặc định cho nick chưa có cấu hình (hiện ở form "Thêm nick"). */
export function defaultProfile(zaloAccountId: string): AutoReplyProfile {
  return {
    zaloAccountId, enabled: false, mode: 'dry_run', triggerTags: [], hourStart: 7, hourEnd: 22,
    debounceSeconds: 20, maxRepliesPerDay: 300, maxRepliesPerConvPerDay: 15, skipIfStaffRepliedWithinMin: 10,
    blockedKeywords: [...DEFAULT_BLOCKED_KEYWORDS], persona: null, extraInstruction: null, guideFileName: null, verifyGrounding: true,
    learningEnabled: true, lastLearnedAt: null,
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
  if (input.verifyGrounding !== undefined && typeof input.verifyGrounding !== 'boolean') return 'verifyGrounding phải là true/false';
  if (input.learningEnabled !== undefined && typeof input.learningEnabled !== 'boolean') return 'learningEnabled phải là true/false';
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
    verifyGrounding: input.verifyGrounding,
    learningEnabled: input.learningEnabled,
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

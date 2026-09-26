/**
 * config-service.ts — cấu hình AI tự trả lời + kho kịch bản (bộ khung trả lời).
 *
 * Mặc định TẮT. Cấu hình được đọc trên mọi tin đến → cache 30 giây, xoá cache
 * ngay khi lưu.
 */
import { prisma } from '../../../shared/database/prisma-client.js';

/* Khách nhắn trúng những từ này thì AI không trả lời, để người thật xử lý. */
export const DEFAULT_BLOCKED_KEYWORDS = [
  'hoàn tiền', 'trả hàng', 'đổi trả', 'khiếu nại', 'lừa đảo', 'kiện tụng', 'khởi kiện', 'luật sư',
  'công an', 'báo chí', 'tố cáo', 'bồi thường', 'bóc phốt', 'huỷ đơn', 'hủy đơn',
];

export type AutoReplyMode = 'auto' | 'dry_run';

export type AutoReplyConfig = {
  enabled: boolean;
  mode: AutoReplyMode;
  triggerTags: string[];
  accountIds: string[];
  hourStart: number;
  hourEnd: number;
  debounceSeconds: number;
  maxRepliesPerDay: number;
  maxRepliesPerConvPerDay: number;
  skipIfStaffRepliedWithinMin: number;
  blockedKeywords: string[];
  persona: string | null;
  extraInstruction: string | null;
  verifyGrounding: boolean;
};

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: AutoReplyConfig }>();

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

type Row = Awaited<ReturnType<typeof prisma.aiAutoReplyConfig.create>>;

function normalize(row: Row): AutoReplyConfig {
  return {
    enabled: row.enabled,
    mode: row.mode === 'dry_run' ? 'dry_run' : 'auto',
    triggerTags: strArr(row.triggerTags),
    accountIds: strArr(row.accountIds),
    hourStart: row.hourStart,
    hourEnd: row.hourEnd,
    debounceSeconds: row.debounceSeconds,
    maxRepliesPerDay: row.maxRepliesPerDay,
    maxRepliesPerConvPerDay: row.maxRepliesPerConvPerDay,
    skipIfStaffRepliedWithinMin: row.skipIfStaffRepliedWithinMin,
    blockedKeywords: strArr(row.blockedKeywords),
    persona: row.persona,
    extraInstruction: row.extraInstruction,
    verifyGrounding: row.verifyGrounding,
  };
}

export async function getAutoReplyConfig(orgId: string, opts: { fresh?: boolean } = {}): Promise<AutoReplyConfig> {
  const hit = cache.get(orgId);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const row = await prisma.aiAutoReplyConfig.findUnique({ where: { orgId } })
    ?? await prisma.aiAutoReplyConfig.create({ data: { orgId, blockedKeywords: DEFAULT_BLOCKED_KEYWORDS } });
  const value = normalize(row);
  cache.set(orgId, { at: Date.now(), value });
  return value;
}

export function validateConfigInput(input: Partial<AutoReplyConfig>): string | null {
  const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return 'Công tắc bật/tắt không hợp lệ';
  if (input.mode !== undefined && input.mode !== 'auto' && input.mode !== 'dry_run') return 'Chế độ phải là auto hoặc dry_run';
  if (input.hourStart !== undefined || input.hourEnd !== undefined) {
    const s = input.hourStart ?? 0;
    const e = input.hourEnd ?? 24;
    if (!int(s, 0, 23) || !int(e, 1, 24) || s >= e) return 'Khung giờ: giờ bắt đầu 0-23, giờ kết thúc 1-24 và phải lớn hơn giờ bắt đầu';
  }
  if (input.debounceSeconds !== undefined && !int(input.debounceSeconds, 3, 300)) return 'Thời gian gom tin phải từ 3 đến 300 giây';
  if (input.maxRepliesPerDay !== undefined && !int(input.maxRepliesPerDay, 1, 5000)) return 'Số tin AI mỗi ngày phải từ 1 đến 5000';
  if (input.maxRepliesPerConvPerDay !== undefined && !int(input.maxRepliesPerConvPerDay, 1, 200)) return 'Số tin mỗi khách mỗi ngày phải từ 1 đến 200';
  if (input.skipIfStaffRepliedWithinMin !== undefined && !int(input.skipIfStaffRepliedWithinMin, 0, 1440)) return 'Thời gian nhường nhân viên phải từ 0 đến 1440 phút';
  for (const key of ['triggerTags', 'accountIds', 'blockedKeywords'] as const) {
    const v = input[key];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) return `${key} phải là mảng chuỗi`;
  }
  if (input.triggerTags && input.triggerTags.length > 50) return 'Tối đa 50 thẻ kích hoạt';
  if (input.persona != null && input.persona.length > 1000) return 'Vai trò / xưng hô tối đa 1000 ký tự';
  if (input.extraInstruction != null && input.extraInstruction.length > 4000) return 'Lời dặn riêng tối đa 4000 ký tự';
  if (input.verifyGrounding !== undefined && typeof input.verifyGrounding !== 'boolean') return 'verifyGrounding phải là true/false';
  return null;
}

export async function updateAutoReplyConfig(orgId: string, input: Partial<AutoReplyConfig>): Promise<AutoReplyConfig> {
  await getAutoReplyConfig(orgId, { fresh: true });
  const row = await prisma.aiAutoReplyConfig.update({
    where: { orgId },
    data: {
      enabled: input.enabled,
      mode: input.mode,
      triggerTags: input.triggerTags?.map((t) => t.trim()).filter(Boolean),
      accountIds: input.accountIds,
      hourStart: input.hourStart,
      hourEnd: input.hourEnd,
      debounceSeconds: input.debounceSeconds,
      maxRepliesPerDay: input.maxRepliesPerDay,
      maxRepliesPerConvPerDay: input.maxRepliesPerConvPerDay,
      skipIfStaffRepliedWithinMin: input.skipIfStaffRepliedWithinMin,
      blockedKeywords: input.blockedKeywords?.map((t) => t.trim()).filter(Boolean),
      persona: input.persona === undefined ? undefined : (input.persona?.trim() || null),
      extraInstruction: input.extraInstruction === undefined ? undefined : (input.extraInstruction?.trim() || null),
      verifyGrounding: input.verifyGrounding,
    },
  });
  const value = normalize(row);
  cache.set(orgId, { at: Date.now(), value });
  return value;
}

/** Chỉ cho test. */
export function _clearAutoReplyConfigCache(): void {
  cache.clear();
}

// ── Kho kịch bản ──────────────────────────────────────────────────────────

export type PlaybookInput = {
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
  if (input.keywords !== undefined && (!Array.isArray(input.keywords) || input.keywords.some((k) => typeof k !== 'string'))) return 'Từ khoá phải là mảng chuỗi';
  if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 100)) return 'Ưu tiên phải từ 0 đến 100';
  if (input.category != null && (typeof input.category !== 'string' || input.category.length > 100)) return 'Nhóm tối đa 100 ký tự';
  return null;
}

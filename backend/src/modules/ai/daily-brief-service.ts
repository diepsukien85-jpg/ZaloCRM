/**
 * daily-brief-service.ts — "Hỏi AI về tình trạng khách hàng hôm nay".
 *
 * Luồng:
 *   1. collectDailySnapshot() gom số liệu trong ngày (theo org timezone) từ DB:
 *      KH mới, tin nhắn vào/ra, hội thoại chưa trả lời, KH đang tương tác,
 *      lịch hẹn, ghi chú, KH đình trệ, pipeline.
 *   2. askDailyBrief() ghép snapshot + câu hỏi + lịch sử hội thoại ngắn thành
 *      prompt → gọi provider AI đang cấu hình của org. Nếu AI tắt / chưa có
 *      key / lỗi → trả câu trả lời rule-based (source='fallback') để popup vẫn
 *      dùng được.
 *
 * Phân quyền: owner/admin thấy toàn org. member chỉ thấy KH được gán cho mình
 * hoặc KH có hội thoại trên nick Zalo mình được cấp quyền (cùng quy tắc với
 * inbox chat).
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { getAiConfig, getProviderApiKey, generateText } from './ai-service.js';

export type DailyBriefUser = { id: string; orgId: string; role: string };

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export interface DailySnapshot {
  date: string;                 // YYYY-MM-DD theo org timezone
  timezone: string;             // "+07:00"
  generatedAt: string;          // ISO
  scope: 'org' | 'mine';
  kpi: {
    newContacts: number;
    inboundMessages: number;
    outboundMessages: number;
    activeCustomers: number;    // KH có tin nhắn đến trong ngày
    unrepliedConversations: number;
    unreadConversations: number;
    appointmentsToday: number;
    appointmentsCompleted: number;
    stuckLeads: number;
    notesToday: number;
  };
  pipeline: Array<{ status: string; count: number }>;
  unreplied: Array<{ contactName: string; zaloAccount: string; lastMessageAt: string | null; waitingMinutes: number | null; preview: string | null }>;
  activeCustomers: Array<{ name: string; status: string | null; leadScore: number; lastInboundAt: string | null; preview: string | null; tags: string[] }>;
  newContacts: Array<{ name: string; source: string | null; status: string | null; createdAt: string }>;
  appointments: Array<{ time: string | null; title: string | null; contactName: string; status: string; type: string | null; assignee: string | null }>;
  notes: Array<{ contactName: string; author: string; body: string; createdAt: string }>;
}

const STATUS_LABEL: Record<string, string> = {
  new: 'Mới',
  contacted: 'Đã liên hệ',
  interested: 'Quan tâm',
  converted: 'Chuyển đổi',
  lost: 'Mất',
};

const APPOINTMENT_STATUS_LABEL: Record<string, string> = {
  scheduled: 'đã lên lịch',
  completed: 'hoàn thành',
  cancelled: 'đã huỷ',
  no_show: 'khách không đến',
};

/** Parse "+07:00" → số phút lệch UTC. Sai format → 0. */
export function parseOffsetMinutes(tz: string | null | undefined): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tz || '');
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

/** Khoảng [start, end) của ngày hôm nay theo offset cố định của org. */
export function todayRangeForTimezone(tz: string | null | undefined, now = new Date()) {
  const offsetMs = parseOffsetMinutes(tz) * 60_000;
  const shifted = new Date(now.getTime() + offsetMs);
  const dayStartShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const start = new Date(dayStartShifted - offsetMs);
  const end = new Date(start.getTime() + 86_400_000);
  const date = new Date(dayStartShifted).toISOString().slice(0, 10);
  return { start, end, date };
}

const WEEKDAY_VI = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

/**
 * orgDayRange — cùng mốc ngày với todayRangeForTimezone nhưng theo chữ ký mà
 * module auto-reply đang import (thứ tự tham số now-trước-tz, kèm dateKey và
 * dateLabel tiếng Việt).
 *
 * Giữ riêng thay vì đổi todayRangeForTimezone để không phá các chỗ đang gọi.
 * tz rỗng/sai định dạng → mặc định +07:00, vì auto-reply truyền thẳng
 * `org?.timezone` và có thể là undefined.
 */
export function orgDayRange(now: Date, tz: string | null | undefined) {
  const safeTz = /^[+-]\d{2}:\d{2}$/.test(tz || '') ? (tz as string) : '+07:00';
  const { start, end, date } = todayRangeForTimezone(safeTz, now);
  const shifted = new Date(start.getTime() + parseOffsetMinutes(safeTz) * 60_000);
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dateLabel = `${WEEKDAY_VI[shifted.getUTCDay()]}, ${dd}/${mm}/${shifted.getUTCFullYear()}`;
  return { start, end, dateKey: date, dateLabel };
}

function contactDisplayName(c: { crmName?: string | null; fullName?: string | null; phone?: string | null } | null | undefined): string {
  if (!c) return 'Khách chưa xác định';
  return c.crmName || c.fullName || (c.phone ? `SĐT ${c.phone.slice(-4).padStart(c.phone.length, '*')}` : 'Khách chưa đặt tên');
}

function statusLabel(status: string | null | undefined, statusRefName?: string | null): string | null {
  if (statusRefName) return statusRefName;
  if (!status) return null;
  return STATUS_LABEL[status] || status;
}

function shorten(text: string | null | undefined, max = 140): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function toIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function formatTimeInTz(d: Date | null | undefined, tz: string): string | null {
  if (!d) return null;
  const shifted = new Date(d.getTime() + parseOffsetMinutes(tz) * 60_000);
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Thu thập snapshot
 * ───────────────────────────────────────────────────────────────────────── */
export async function collectDailySnapshot(user: DailyBriefUser, now = new Date()): Promise<DailySnapshot> {
  const { orgId } = user;
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
  const timezone = org?.timezone || '+07:00';
  const { start, end, date } = todayRangeForTimezone(timezone, now);
  const isMember = !['owner', 'admin'].includes(user.role);

  // Member: chỉ các nick Zalo được cấp quyền (cùng quy tắc với inbox chat).
  let accessibleAccountIds: string[] | null = null;
  if (isMember) {
    const access = await prisma.zaloAccountAccess.findMany({ where: { userId: user.id }, select: { zaloAccountId: true } });
    accessibleAccountIds = access.map((a) => a.zaloAccountId);
  }

  const convWhere: Record<string, unknown> = { orgId, zaloAccount: { archivedAt: null } };
  if (accessibleAccountIds) convWhere.zaloAccountId = { in: accessibleAccountIds };

  const contactWhere: Record<string, unknown> = { orgId, mergedInto: null };
  if (accessibleAccountIds) {
    contactWhere.OR = [
      { assignedUserId: user.id },
      { conversations: { some: { zaloAccountId: { in: accessibleAccountIds } } } },
    ];
  }

  const appointmentWhere: Record<string, unknown> = { orgId, appointmentDate: { gte: start, lt: end } };
  if (accessibleAccountIds) {
    appointmentWhere.OR = [{ assignedUserId: user.id }, { contact: contactWhere }];
  }

  const noteWhere: Record<string, unknown> = { orgId, createdAt: { gte: start, lt: end }, parentNoteId: null };
  if (accessibleAccountIds) noteWhere.OR = [{ authorUserId: user.id }, { contact: contactWhere }];

  const [
    newContactsCount,
    newContacts,
    inboundMessages,
    outboundMessages,
    activeCount,
    activeCustomers,
    unrepliedCount,
    unreplied,
    unreadCount,
    appointments,
    stuckLeads,
    notesCount,
    notes,
    pipelineRows,
  ] = await Promise.all([
    prisma.contact.count({ where: { ...contactWhere, createdAt: { gte: start, lt: end } } }),
    prisma.contact.findMany({
      where: { ...contactWhere, createdAt: { gte: start, lt: end } },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { fullName: true, crmName: true, phone: true, source: true, status: true, createdAt: true, statusRef: { select: { name: true } } },
    }),
    prisma.message.count({ where: { conversation: convWhere, sentAt: { gte: start, lt: end }, senderType: 'contact', isDeleted: false } }),
    prisma.message.count({ where: { conversation: convWhere, sentAt: { gte: start, lt: end }, senderType: 'self', isDeleted: false } }),
    prisma.contact.count({ where: { ...contactWhere, lastInboundAt: { gte: start, lt: end } } }),
    prisma.contact.findMany({
      where: { ...contactWhere, lastInboundAt: { gte: start, lt: end } },
      orderBy: { lastInboundAt: 'desc' },
      take: 15,
      select: { fullName: true, crmName: true, phone: true, status: true, leadScore: true, lastInboundAt: true, lastInboundPreview: true, tags: true, statusRef: { select: { name: true } } },
    }),
    prisma.conversation.count({ where: { ...convWhere, isReplied: false } }),
    prisma.conversation.findMany({
      where: { ...convWhere, isReplied: false },
      orderBy: { lastMessageAt: 'asc' },
      take: 10,
      select: {
        lastMessageAt: true,
        groupName: true,
        threadType: true,
        contact: { select: { fullName: true, crmName: true, phone: true, lastInboundPreview: true } },
        zaloAccount: { select: { displayName: true } },
      },
    }),
    prisma.conversation.count({ where: { ...convWhere, unreadCount: { gt: 0 } } }),
    prisma.appointment.findMany({
      where: appointmentWhere,
      orderBy: [{ appointmentTime: 'asc' }, { createdAt: 'asc' }],
      take: 20,
      select: {
        appointmentTime: true, title: true, status: true, type: true,
        contact: { select: { fullName: true, crmName: true, phone: true } },
        assignedUser: { select: { fullName: true } },
      },
    }),
    prisma.contact.count({ where: { ...contactWhere, stuckSinceAggregate: { not: null } } }),
    prisma.note.count({ where: noteWhere }),
    prisma.note.findMany({
      where: noteWhere,
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { body: true, createdAt: true, contact: { select: { fullName: true, crmName: true, phone: true } }, author: { select: { fullName: true } } },
    }),
    prisma.contact.groupBy({ by: ['status'], where: { ...contactWhere, status: { not: null } }, _count: true }),
  ]);

  const appointmentsCompleted = appointments.filter((a) => a.status === 'completed').length;

  return {
    date,
    timezone,
    generatedAt: now.toISOString(),
    scope: isMember ? 'mine' : 'org',
    kpi: {
      newContacts: newContactsCount,
      inboundMessages,
      outboundMessages,
      activeCustomers: activeCount,
      unrepliedConversations: unrepliedCount,
      unreadConversations: unreadCount,
      appointmentsToday: appointments.length,
      appointmentsCompleted,
      stuckLeads,
      notesToday: notesCount,
    },
    pipeline: pipelineRows
      .map((p) => ({ status: statusLabel(p.status) || 'Khác', count: typeof p._count === 'number' ? p._count : 0 }))
      .sort((a, b) => b.count - a.count),
    unreplied: unreplied.map((c) => ({
      contactName: c.threadType === 'group' ? `Nhóm ${c.groupName || ''}`.trim() : contactDisplayName(c.contact),
      zaloAccount: c.zaloAccount?.displayName || 'Zalo',
      lastMessageAt: toIso(c.lastMessageAt),
      waitingMinutes: c.lastMessageAt ? Math.max(0, Math.round((now.getTime() - c.lastMessageAt.getTime()) / 60_000)) : null,
      preview: shorten(c.contact?.lastInboundPreview, 100),
    })),
    activeCustomers: activeCustomers.map((c) => ({
      name: contactDisplayName(c),
      status: statusLabel(c.status, c.statusRef?.name),
      leadScore: c.leadScore,
      lastInboundAt: toIso(c.lastInboundAt),
      preview: shorten(c.lastInboundPreview, 100),
      tags: Array.isArray(c.tags) ? (c.tags as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 5) : [],
    })),
    newContacts: newContacts.map((c) => ({
      name: contactDisplayName(c),
      source: c.source,
      status: statusLabel(c.status, c.statusRef?.name),
      createdAt: c.createdAt.toISOString(),
    })),
    appointments: appointments.map((a) => ({
      time: a.appointmentTime,
      title: a.title,
      contactName: contactDisplayName(a.contact),
      status: APPOINTMENT_STATUS_LABEL[a.status] || a.status,
      type: a.type,
      assignee: a.assignedUser?.fullName || null,
    })),
    notes: notes.map((n) => ({
      contactName: contactDisplayName(n.contact),
      author: n.author?.fullName || 'Nhân viên',
      body: shorten(n.body, 160) || '',
      createdAt: n.createdAt.toISOString(),
    })),
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Câu trả lời rule-based (khi AI tắt / thiếu key / lỗi)
 * ───────────────────────────────────────────────────────────────────────── */
export function buildFallbackAnswer(s: DailySnapshot): string {
  const k = s.kpi;
  const lines: string[] = [];
  lines.push(`📊 Tình hình khách hàng hôm nay (${s.date}${s.scope === 'mine' ? ', phạm vi của bạn' : ''}):`);
  lines.push(`• Khách mới: ${k.newContacts} · Khách đang tương tác: ${k.activeCustomers}`);
  lines.push(`• Tin nhắn: ${k.inboundMessages} đến / ${k.outboundMessages} đi`);
  lines.push(`• Chưa trả lời: ${k.unrepliedConversations} hội thoại · Chưa đọc: ${k.unreadConversations}`);
  lines.push(`• Lịch hẹn: ${k.appointmentsToday} (hoàn thành ${k.appointmentsCompleted}) · Ghi chú mới: ${k.notesToday}`);
  if (k.stuckLeads > 0) lines.push(`• ⚠️ Khách đình trệ cần xử lý: ${k.stuckLeads}`);

  if (s.unreplied.length) {
    lines.push('');
    lines.push('⏳ Đang chờ trả lời lâu nhất:');
    for (const u of s.unreplied.slice(0, 5)) {
      const wait = u.waitingMinutes == null ? '' : u.waitingMinutes >= 60 ? ` (~${Math.round(u.waitingMinutes / 60)} giờ)` : ` (${u.waitingMinutes} phút)`;
      lines.push(`  - ${u.contactName} qua ${u.zaloAccount}${wait}${u.preview ? `: "${u.preview}"` : ''}`);
    }
  }
  if (s.appointments.length) {
    lines.push('');
    lines.push('📅 Lịch hẹn hôm nay:');
    for (const a of s.appointments.slice(0, 5)) {
      lines.push(`  - ${a.time || '--:--'} ${a.title || 'Lịch hẹn'} với ${a.contactName} (${a.status})`);
    }
  }
  if (s.activeCustomers.length) {
    lines.push('');
    lines.push('🔥 Khách vừa nhắn tin:');
    for (const c of s.activeCustomers.slice(0, 5)) {
      lines.push(`  - ${c.name}${c.status ? ` · ${c.status}` : ''} · điểm ${c.leadScore}${c.preview ? `: "${c.preview}"` : ''}`);
    }
  }
  if (!s.unreplied.length && !s.appointments.length && !s.activeCustomers.length && k.newContacts === 0) {
    lines.push('');
    lines.push('Hôm nay chưa có hoạt động khách hàng nào được ghi nhận.');
  }
  lines.push('');
  lines.push('ℹ️ AI chưa được bật hoặc chưa có API key nên đây là tóm tắt tự động. Vào Cài đặt → AI để bật trợ lý thông minh.');
  return lines.join('\n');
}

/* ─────────────────────────────────────────────────────────────────────────
 * Prompt cho AI
 * ───────────────────────────────────────────────────────────────────────── */
export const DAILY_BRIEF_SYSTEM_PROMPT = [
  'Bạn là trợ lý CRM cho đội sale dùng Zalo. Người dùng hỏi về tình trạng khách hàng trong ngày hôm nay.',
  'Dữ liệu thật của CRM nằm trong thẻ <crm_snapshot> (JSON). CHỈ trả lời dựa trên dữ liệu đó, KHÔNG bịa số liệu hay tên khách.',
  'Nếu dữ liệu không đủ để trả lời, nói rõ là chưa có dữ liệu và gợi ý người dùng nên làm gì.',
  'Trả lời bằng tiếng Việt, ngắn gọn, ưu tiên gạch đầu dòng, nêu tên khách cụ thể khi có. Không dùng markdown heading; dùng emoji vừa phải.',
  'Kết thúc bằng 1-2 việc nên làm tiếp (ví dụ: trả lời khách đang chờ lâu, chuẩn bị lịch hẹn sắp tới).',
  'Tối đa khoảng 250 từ. Không nhắc lại toàn bộ JSON.',
].join('\n');

function escapeBoundary(text: string): string {
  return text.replace(/<\/?(crm_snapshot|history|question)>/gi, '');
}

export function buildDailyBriefPrompt(snapshot: DailySnapshot, question: string, history: ChatTurn[] = []): string {
  const parts: string[] = [];
  parts.push('<crm_snapshot>');
  parts.push(JSON.stringify(snapshot));
  parts.push('</crm_snapshot>');
  if (history.length) {
    parts.push('<history>');
    for (const turn of history) {
      parts.push(`${turn.role === 'user' ? 'Người dùng' : 'Trợ lý'}: ${escapeBoundary(turn.content)}`);
    }
    parts.push('</history>');
  }
  parts.push('<question>');
  parts.push(escapeBoundary(question));
  parts.push('</question>');
  return parts.join('\n');
}

/** Chuẩn hoá lịch sử từ client: tối đa 8 lượt gần nhất, mỗi lượt ≤ 2000 ký tự. */
export function sanitizeHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: ChatTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim()) continue;
    turns.push({ role, content: content.trim().slice(0, 2000) });
  }
  return turns.slice(-8);
}

export interface DailyBriefAnswer {
  answer: string;
  source: 'ai' | 'fallback';
  snapshot: DailySnapshot;
}

export async function askDailyBrief(input: { user: DailyBriefUser; question: string; history?: ChatTurn[] }): Promise<DailyBriefAnswer> {
  const snapshot = await collectDailySnapshot(input.user);
  const fallback = () => ({ answer: buildFallbackAnswer(snapshot), source: 'fallback' as const, snapshot });

  const aiConfig = await getAiConfig(input.user.orgId);
  if (!aiConfig.enabled) return fallback();

  const apiKey = await getProviderApiKey(input.user.orgId, aiConfig.provider);
  if (!apiKey) return fallback();

  // Quota theo ngày dùng chung counter với các tác vụ AI khác.
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const usedToday = await prisma.aiSuggestion.count({ where: { orgId: input.user.orgId, createdAt: { gte: startOfDay } } });
  if (usedToday >= aiConfig.maxDaily) throw new Error('AI daily quota exceeded');

  const prompt = buildDailyBriefPrompt(snapshot, input.question, input.history || []);
  try {
    const raw = await generateText(aiConfig.provider, apiKey, aiConfig.model, DAILY_BRIEF_SYSTEM_PROMPT, prompt, 900);
    const answer = raw.trim();
    if (!answer) return fallback();
    return { answer, source: 'ai', snapshot };
  } catch (err) {
    // Provider lỗi (429/timeout/network) → vẫn trả tóm tắt rule-based để popup không trống.
    logger.warn('[ai-daily-brief] AI call failed, using fallback:', err);
    return fallback();
  }
}

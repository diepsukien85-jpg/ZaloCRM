/**
 * response-report.ts — chỉ số NHÂN VIÊN PHẢN HỒI KHÁCH trên Zalo, tính THEO NICK (kèm người phụ trách).
 *
 * Vì sao theo nick: phần lớn tin nhân viên gửi bằng điện thoại, CRM chỉ biết tin đi từ nick nào.
 * Chỉ chat 1-1 với KHÁCH: bỏ nhóm, bỏ người mang thẻ Người Thân / Nhân Viên, và ở nick bật AI tự phân
 * loại thì bỏ cả thẻ anh xếp "không trả lời" (vd Nguồn Hàng).
 *
 * "Lượt hỏi" = tin khách đầu tiên sau tin shop (hoặc tin đầu hội thoại). Thời gian phản hồi = tới tin shop
 * kế tiếp (người hoặc AI), tính trong 24 giờ. Chậm = chờ quá `slowMinutes` (mặc định 30).
 * Dùng cho: báo cáo Tiểu Mỹ 21:00, lệnh `node dist/cli/bao-cao-phan-hoi.js`, API /analytics/response-report.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { listProfiles } from '../ai/auto-reply/config-service.js';
import { coreGroupOfLabel } from '../ai/auto-reply/contact-classifier.js';
import { normalizeTagName } from '../ai/auto-reply/guardrails.js';

export type Turn = {
  zaloAccountId: string;
  conversationId: string;
  threadId: string;
  customerName: string | null;
  start: Date;
  replyAt: Date | null;
  replyVia: string | null;
};

export type NickReport = {
  zaloAccountId: string;
  nick: string;
  staff: string[];
  customers: number;
  turns: number;
  answered: number;
  answeredByAi: number;
  within5: number;
  within15: number;
  withinSlow: number;
  slow: number;
  avgMinutes: number | null;
  medianMinutes: number | null;
  waiting: Array<{ name: string; minutes: number; conversationId: string }>;
};

export type ResponseReport = {
  from: Date;
  to: Date;
  slowMinutes: number;
  nicks: NickReport[];
  total: Omit<NickReport, 'zaloAccountId' | 'nick' | 'staff' | 'waiting'> & { waiting: number };
};

const DAY_MS = 86_400_000;

/** Hàm thuần: gom lượt hỏi của 1 nick thành chỉ số. */
export function summarizeTurns(turns: Turn[], now: Date, slowMinutes: number): Omit<NickReport, 'zaloAccountId' | 'nick' | 'staff'> {
  const mins: number[] = [];
  let answeredByAi = 0; let within5 = 0; let within15 = 0; let withinSlow = 0; let slow = 0;
  const waiting: NickReport['waiting'] = [];
  for (const t of turns) {
    const replied = t.replyAt && t.replyAt.getTime() <= now.getTime() && t.replyAt.getTime() - t.start.getTime() <= DAY_MS;
    if (replied) {
      const m = (t.replyAt!.getTime() - t.start.getTime()) / 60_000;
      mins.push(m);
      if (t.replyVia === 'automation') answeredByAi++;
      if (m <= 5) within5++;
      if (m <= 15) within15++;
      if (m <= slowMinutes) withinSlow++; else slow++;
    } else {
      const waited = (now.getTime() - t.start.getTime()) / 60_000;
      if (waited > slowMinutes) {
        slow++;
        if (!t.replyAt) waiting.push({ name: t.customerName || 'Không tên', minutes: Math.round(waited), conversationId: t.conversationId });
      }
    }
  }
  const sorted = [...mins].sort((a, b) => a - b);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
  // Mỗi khách chỉ tính lần chờ lâu nhất.
  const byConv = new Map<string, NickReport['waiting'][number]>();
  for (const w of waiting) if ((byConv.get(w.conversationId)?.minutes ?? -1) < w.minutes) byConv.set(w.conversationId, w);
  return {
    customers: new Set(turns.map((t) => t.conversationId)).size,
    turns: turns.length,
    answered: mins.length,
    answeredByAi,
    within5, within15, withinSlow, slow,
    avgMinutes: mins.length ? Math.round((mins.reduce((a, b) => a + b, 0) / mins.length) * 10) / 10 : null,
    medianMinutes: median == null ? null : Math.round(median * 10) / 10,
    waiting: [...byConv.values()].sort((a, b) => b.minutes - a.minutes),
  };
}

/** Hội thoại KHÔNG phải khách của từng nick (người thân, nhân viên, thẻ "không trả lời") — theo thẻ Zalo. */
async function excludedThreads(orgId: string): Promise<Map<string, Set<string>>> {
  const profiles = new Map((await listProfiles(orgId)).map((p) => [p.zaloAccountId, p]));
  const labels = await prisma.zaloLabel.findMany({ where: { orgId }, select: { zaloAccountId: true, text: true, conversations: true } });
  const out = new Map<string, Set<string>>();
  for (const l of labels) {
    const cfg = profiles.get(l.zaloAccountId);
    const core = coreGroupOfLabel(l.text);
    let exclude = core === 'family' || core === 'staff';
    if (!core && cfg?.enabled && cfg.classifyContacts) {
      const g = Object.entries(cfg.labelGroups ?? {}).find(([k]) => normalizeTagName(k) === normalizeTagName(l.text))?.[1];
      exclude = g !== 'customer' && !(cfg.triggerTags ?? []).some((t) => normalizeTagName(t) === normalizeTagName(l.text));
    }
    if (!exclude) continue;
    const set = out.get(l.zaloAccountId) ?? new Set<string>();
    for (const t of Array.isArray(l.conversations) ? (l.conversations as unknown[]) : []) set.add(String(t));
    out.set(l.zaloAccountId, set);
  }
  return out;
}

async function loadTurns(orgId: string, from: Date, to: Date): Promise<Turn[]> {
  const rows = await prisma.$queryRaw<Array<{
    zalo_account_id: string; conversation_id: string; thread_id: string; name: string | null; start: Date; reply_at: Date | null; reply_via: string | null;
  }>>`
    WITH seq AS (
      SELECT c.zalo_account_id, m.conversation_id, c.external_thread_id, c.contact_id, m.sender_type, m.sent_at,
             LAG(m.sender_type) OVER (PARTITION BY m.conversation_id ORDER BY m.sent_at) AS prev
        FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.org_id = ${orgId} AND c."threadType" = 'user' AND m.is_deleted = false
         AND m.sent_at >= ${new Date(from.getTime() - DAY_MS)} AND m.sent_at < ${to}
    )
    SELECT s.zalo_account_id, s.conversation_id, s.external_thread_id AS thread_id,
           COALESCE(ct.crm_name, ct.full_name) AS name, s.sent_at AS start, r.sent_at AS reply_at, r.sent_via AS reply_via
      FROM seq s
      LEFT JOIN contacts ct ON ct.id = s.contact_id
      LEFT JOIN LATERAL (
        SELECT m2.sent_at, m2.sent_via FROM messages m2
         WHERE m2.conversation_id = s.conversation_id AND m2.sender_type = 'self' AND m2.is_deleted = false AND m2.sent_at > s.sent_at
         ORDER BY m2.sent_at LIMIT 1
      ) r ON true
     WHERE s.sender_type = 'contact' AND (s.prev IS NULL OR s.prev = 'self')
       AND s.sent_at >= ${from} AND s.sent_at < ${to}
  `;
  return rows.map((r) => ({
    zaloAccountId: r.zalo_account_id, conversationId: r.conversation_id, threadId: r.thread_id, customerName: r.name,
    start: r.start, replyAt: r.reply_at, replyVia: r.reply_via,
  }));
}

export async function computeResponseReport(p: { orgId: string; from: Date; to: Date; slowMinutes?: number; now?: Date; nickFilter?: string }): Promise<ResponseReport> {
  const now = p.now ?? new Date();
  const slowMinutes = p.slowMinutes ?? 30;
  const [turns, excluded, accounts] = await Promise.all([
    loadTurns(p.orgId, p.from, p.to),
    excludedThreads(p.orgId),
    prisma.zaloAccount.findMany({
      where: { orgId: p.orgId, purged: false },
      select: {
        id: true, displayName: true, phone: true,
        owner: { select: { fullName: true } },
        access: { where: { permission: { in: ['chat', 'admin'] } }, select: { user: { select: { fullName: true } } } },
      },
    }),
  ]);
  // Nick nội bộ nhắn qua lại (vd "Kim Mỹ Kho Sỉ Long Xuyên" nhắn "Kim Mỹ Kho Sỉ") không phải khách.
  const ownNames = new Set(accounts.map((a) => normalizeTagName(a.displayName || '')).filter(Boolean));
  const byNick = new Map<string, Turn[]>();
  for (const t of turns) {
    if (excluded.get(t.zaloAccountId)?.has(t.threadId)) continue;
    if (t.customerName && ownNames.has(normalizeTagName(t.customerName))) continue;
    const list = byNick.get(t.zaloAccountId) ?? [];
    list.push(t);
    byNick.set(t.zaloAccountId, list);
  }
  const filter = p.nickFilter ? normalizeTagName(p.nickFilter) : null;
  const nicks: NickReport[] = accounts
    .filter((a) => byNick.has(a.id))
    .filter((a) => !filter || normalizeTagName(a.displayName || '').includes(filter))
    .map((a) => ({
      zaloAccountId: a.id,
      nick: a.displayName || a.phone || a.id.slice(0, 8),
      staff: [...new Set([a.owner?.fullName, ...a.access.map((x) => x.user.fullName)].filter((x): x is string => !!x))],
      ...summarizeTurns(byNick.get(a.id)!, now, slowMinutes),
    }))
    .sort((x, y) => y.customers - x.customers);
  const all = summarizeTurns(nicks.flatMap((n) => byNick.get(n.zaloAccountId)!), now, slowMinutes);
  return { from: p.from, to: p.to, slowMinutes, nicks, total: { ...all, waiting: all.waiting.length } };
}

// ── Trình bày ──────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
export const fmtMin = (m: number | null) => {
  if (m == null) return '—';
  if (m < 60) return `${Math.round(m)}p`;
  if (m < 1440) return `${Math.floor(m / 60)}g${String(Math.round(m % 60)).padStart(2, '0')}`;
  const d = Math.floor(m / 1440); const h = Math.floor((m % 1440) / 60);
  return `${d} ngày${h ? ` ${h}g` : ''}`;
};

/** Hàm thuần: báo cáo dạng tin Telegram (HTML). */
export function formatResponseReport(r: ResponseReport, title: string, appUrl?: string): string {
  const t = r.total;
  const lines = [
    `📞 <b>${esc(title)}</b>`,
    t.turns
      ? `Tổng: <b>${t.customers}</b> khách · ${t.turns} lượt hỏi · trả lời <b>${pct(t.answered, t.turns)}</b> · TB ${fmtMin(t.avgMinutes)} (trung vị ${fmtMin(t.medianMinutes)}) · trong ${r.slowMinutes}p ${pct(t.withinSlow, t.turns)} · 🐢 chậm ${t.slow}${t.answeredByAi ? ` · 🤖 AI ${t.answeredByAi}` : ''}`
      : 'Không có khách nhắn riêng trong khoảng này.',
  ];
  for (const n of r.nicks) {
    lines.push(
      `• <b>${esc(n.nick)}</b>${n.staff.length ? ` (${esc(n.staff.join(', '))})` : ''}: ${n.customers} khách · trả lời ${pct(n.answered, n.turns)} · TB ${fmtMin(n.avgMinutes)} · ≤5p ${pct(n.within5, n.turns)} · 🐢 ${n.slow}${n.answeredByAi ? ` · 🤖 ${n.answeredByAi}` : ''}${n.waiting.length ? ` · ⏳ đang chờ ${n.waiting.length}` : ''}`,
    );
  }
  const waiting = r.nicks.flatMap((n) => n.waiting.map((w) => ({ ...w, nick: n.nick }))).sort((a, b) => b.minutes - a.minutes).slice(0, 5);
  if (waiting.length) {
    lines.push('', `⏳ <b>Khách đang chờ lâu nhất</b> (chưa ai trả lời, quá ${r.slowMinutes}p):`);
    for (const w of waiting) {
      lines.push(`– ${esc(w.name)} · ${esc(w.nick)} · chờ ${fmtMin(w.minutes)}${appUrl ? ` · ${appUrl.replace(/\/$/, '')}/chat/${w.conversationId}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** Mốc đầu ngày giờ VN (UTC) cách hôm nay `daysAgo` ngày. */
export function vnDayStart(now: Date, daysAgo = 0): Date {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate() - daysAgo) - 7 * 3_600_000);
}

import type { PoolClient } from 'pg';
import { one, q, tx } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { audit } from '../audit';
import { roleAtLeast, type Role } from '../auth';
import { findDuplicate, fingerprint } from '../similarity';
import type { IdeaBatchT } from '../ai/schemas';

export const STATUSES = ['idea', 'researching', 'writing', 'draft', 'pending_review', 'changes_requested', 'approved', 'in_production', 'ready_to_publish', 'scheduled', 'published', 'failed', 'archived'] as const;
export type ContentStatus = (typeof STATUSES)[number];

/** Chuyển trạng thái hợp lệ. Mục "approved/scheduled/published" chỉ đi qua transition() để có phê duyệt + audit. */
const NEXT: Record<ContentStatus, ContentStatus[]> = {
  idea: ['researching', 'writing', 'draft', 'archived'],
  researching: ['writing', 'draft', 'archived'],
  writing: ['draft', 'archived'],
  draft: ['pending_review', 'archived'],
  pending_review: ['approved', 'changes_requested', 'draft', 'archived'],
  changes_requested: ['draft', 'pending_review', 'archived'],
  approved: ['in_production', 'ready_to_publish', 'scheduled', 'draft', 'archived'],
  in_production: ['ready_to_publish', 'scheduled', 'draft', 'archived'],
  ready_to_publish: ['scheduled', 'published', 'draft', 'archived'],
  scheduled: ['published', 'failed', 'ready_to_publish', 'archived'],
  published: ['archived'],
  failed: ['ready_to_publish', 'scheduled', 'draft', 'archived'],
  archived: ['draft'],
};
export const canTransition = (from: ContentStatus, to: ContentStatus) => NEXT[from]?.includes(to) ?? false;

export type NewContent = {
  brand_id?: string | null; channel_id?: string | null; campaign_id?: string | null; idea_id?: string | null; story_id?: string | null; parent_content_id?: string | null;
  title: string; content_type?: string; format?: string; platform?: string; pillar?: string; status?: ContentStatus;
  body?: string; hooks?: string[]; caption?: string; hashtags?: string[]; cta?: string; keyword_ids?: string[]; references_text?: string;
  privacy?: string; ai_generated?: boolean; is_demo?: boolean; workflow_run_id?: string | null; metadata?: Record<string, unknown>;
};

export async function createContent(workspaceId: string, userId: string | null, d: NewContent, c?: PoolClient) {
  const run = async (cl: PoolClient) => {
    const r = (await cl.query(
      `INSERT INTO contents(workspace_id, brand_id, channel_id, campaign_id, idea_id, story_id, parent_content_id, title, content_type, format, platform, pillar, status, body, hooks, caption, hashtags, cta, keyword_ids, references_text, privacy, ai_generated, is_demo, workflow_run_id, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *`,
      [workspaceId, d.brand_id ?? null, d.channel_id ?? null, d.campaign_id ?? null, d.idea_id ?? null, d.story_id ?? null, d.parent_content_id ?? null, d.title, d.content_type ?? 'post', d.format ?? 'text', d.platform ?? 'facebook_profile', d.pillar ?? '', d.status ?? 'draft', d.body ?? '', d.hooks ?? [], d.caption ?? '', d.hashtags ?? [], d.cta ?? '', d.keyword_ids ?? [], d.references_text ?? '', d.privacy ?? 'internal', d.ai_generated ?? false, d.is_demo ?? false, d.workflow_run_id ?? null, JSON.stringify(d.metadata ?? {}), userId])).rows[0];
    await cl.query(`INSERT INTO content_versions(workspace_id, content_id, version, title, body, hooks, caption, change_note, source, created_by) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9)`,
      [workspaceId, r.id, r.title, r.body, r.hooks, r.caption, d.ai_generated ? 'Bản AI tạo' : 'Bản đầu tiên', d.ai_generated ? 'ai_generate' : 'manual', userId]);
    return r;
  };
  return c ? run(c) : tx(run);
}

export type EditContent = { title?: string; body?: string; hooks?: string[]; caption?: string; hashtags?: string[]; cta?: string; pillar?: string; platform?: string; channel_id?: string | null; campaign_id?: string | null; keyword_ids?: string[]; references_text?: string; assignee_id?: string | null; privacy?: string };

/** Lưu nội dung; tạo version mới khi title/body/hooks/caption đổi (autosave gộp vào version 'autosave' gần nhất của cùng người trong 10 phút). */
export async function editContent(workspaceId: string, userId: string, id: string, d: EditContent, opts: { source?: 'manual' | 'autosave' | 'ai_rewrite' | 'restore'; note?: string } = {}) {
  return tx(async (c) => {
    const cur = (await c.query('SELECT * FROM contents WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [id, workspaceId])).rows[0];
    if (!cur) throw notFound();
    if (['published', 'archived'].includes(cur.status) && (d.body !== undefined || d.title !== undefined)) throw conflict('Nội dung đã đăng/lưu trữ — chuyển về bản nháp trước khi sửa');
    const next = { ...cur, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) };
    const textChanged = ['title', 'body', 'caption'].some((k) => (d as Record<string, unknown>)[k] !== undefined && (d as Record<string, unknown>)[k] !== cur[k]) ||
      (d.hooks !== undefined && JSON.stringify(d.hooks) !== JSON.stringify(cur.hooks));
    let version = cur.current_version;
    if (textChanged) {
      const source = opts.source ?? 'manual';
      const last = (await c.query('SELECT * FROM content_versions WHERE content_id=$1 ORDER BY version DESC LIMIT 1', [id])).rows[0];
      const mergeAuto = source === 'autosave' && last?.source === 'autosave' && last.created_by === userId && Date.now() - new Date(last.created_at).getTime() < 10 * 60_000;
      if (mergeAuto) {
        await c.query('UPDATE content_versions SET title=$2, body=$3, hooks=$4, caption=$5 WHERE id=$1', [last.id, next.title, next.body, next.hooks, next.caption]);
        version = last.version;
      } else {
        version = (last?.version ?? 0) + 1;
        await c.query('INSERT INTO content_versions(workspace_id, content_id, version, title, body, hooks, caption, change_note, source, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [workspaceId, id, version, next.title, next.body, next.hooks, next.caption, opts.note ?? '', source, userId]);
      }
    }
    const status = textChanged && ['approved', 'ready_to_publish'].includes(cur.status) ? 'draft' : cur.status; // sửa sau khi duyệt → phải duyệt lại
    const r = (await c.query(
      `UPDATE contents SET title=$3, body=$4, hooks=$5, caption=$6, hashtags=$7, cta=$8, pillar=$9, platform=$10, channel_id=$11, campaign_id=$12, keyword_ids=$13, references_text=$14, assignee_id=$15, privacy=$16, current_version=$17, status=$18
       WHERE id=$1 AND workspace_id=$2 RETURNING *`,
      [id, workspaceId, next.title, next.body, next.hooks, next.caption, next.hashtags, next.cta, next.pillar, next.platform, next.channel_id, next.campaign_id, next.keyword_ids, next.references_text, next.assignee_id, next.privacy, version, status])).rows[0];
    if (status !== cur.status) await c.query("INSERT INTO content_approvals(workspace_id, content_id, action, actor_id, note) VALUES ($1,$2,'request_changes',$3,'Tự động: sửa nội dung sau khi duyệt → cần duyệt lại')", [workspaceId, id, userId]);
    return r;
  });
}

export async function restoreVersion(workspaceId: string, userId: string, id: string, version: number) {
  const v = await one<{ title: string; body: string; hooks: string[]; caption: string }>('SELECT title, body, hooks, caption FROM content_versions WHERE content_id=$1 AND workspace_id=$2 AND version=$3', [id, workspaceId, version]);
  if (!v) throw notFound('Không có phiên bản này');
  return editContent(workspaceId, userId, id, v, { source: 'restore', note: `Khôi phục từ phiên bản ${version}` });
}

export type TransitionInput = { to: ContentStatus; note?: string; scheduled_at?: string | null; channel_id?: string | null; confirm?: boolean; external_url?: string | null };

/** Điểm duy nhất thay đổi trạng thái có ý nghĩa: kiểm tra quy tắc phê duyệt, ghi content_approvals + audit_logs. */
export async function transition(workspaceId: string, userId: string, role: Role, id: string, t: TransitionInput) {
  return tx(async (c) => {
    const cur = (await c.query('SELECT * FROM contents WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [id, workspaceId])).rows[0];
    if (!cur) throw notFound();
    const from = cur.status as ContentStatus;
    if (from === t.to) return cur;
    if (!canTransition(from, t.to)) throw badRequest(`Không thể chuyển từ "${from}" sang "${t.to}"`);
    if (['approved', 'changes_requested'].includes(t.to) && from === 'pending_review' && !roleAtLeast(role, 'admin')) throw forbidden('Chỉ quản trị viên/chủ sở hữu được duyệt hoặc yêu cầu sửa');
    if (t.to === 'changes_requested' && !t.note?.trim()) throw badRequest('Cần ghi chú yêu cầu sửa');
    if (t.to === 'pending_review' && !cur.body.trim()) throw badRequest('Nội dung đang trống');
    let scheduledAt: string | null = cur.scheduled_at;
    let action: string | null = null;
    if (t.to === 'pending_review') action = 'request_review';
    if (t.to === 'approved') action = 'approve';
    if (t.to === 'changes_requested') action = 'request_changes';
    if (t.to === 'scheduled') {
      if (!['approved', 'in_production', 'ready_to_publish', 'failed', 'scheduled'].includes(from)) throw badRequest('Chỉ lên lịch nội dung đã duyệt');
      if (!t.scheduled_at) throw badRequest('Cần chọn thời điểm đăng');
      if (!t.confirm) throw badRequest('Cần xác nhận lên lịch (confirm=true)');
      scheduledAt = new Date(t.scheduled_at).toISOString();
      action = 'reschedule_confirm';
    }
    if (t.to === 'published') {
      if (!t.confirm) throw badRequest('Đăng công khai cần xác nhận của người dùng (confirm=true)');
      action = 'publish_confirm';
    }
    if (t.to === 'ready_to_publish' || t.to === 'in_production') {
      if (!['approved', 'in_production', 'failed', 'scheduled'].includes(from)) throw badRequest('Chỉ chuyển sang bước này sau khi nội dung được duyệt');
    }
    const r = (await c.query(
      `UPDATE contents SET status=$3, scheduled_at=$4, published_at = CASE WHEN $3='published' THEN now() ELSE published_at END WHERE id=$1 AND workspace_id=$2 RETURNING *`,
      [id, workspaceId, t.to, t.to === 'draft' || t.to === 'archived' ? (t.to === 'archived' ? cur.scheduled_at : null) : scheduledAt])).rows[0];
    if (action) await c.query('INSERT INTO content_approvals(workspace_id, content_id, action, actor_id, note) VALUES ($1,$2,$3,$4,$5)', [workspaceId, id, action, userId, t.note ?? '']);
    if (t.to === 'scheduled') {
      await c.query(`UPDATE schedules SET status='cancelled' WHERE content_id=$1 AND workspace_id=$2 AND status IN ('planned','confirmed')`, [id, workspaceId]);
      await c.query(`INSERT INTO schedules(workspace_id, content_id, channel_id, platform, scheduled_at, status, confirmed_by) VALUES ($1,$2,$3,$4,$5,'confirmed',$6)`, [workspaceId, id, t.channel_id ?? cur.channel_id, cur.platform, scheduledAt, userId]);
    }
    if (t.to === 'published') {
      await c.query(`UPDATE schedules SET status='done' WHERE content_id=$1 AND workspace_id=$2 AND status IN ('planned','confirmed')`, [id, workspaceId]);
      const job = (await c.query(`INSERT INTO publication_jobs(workspace_id, content_id, channel_id, mode, status, approved_by, external_url, idempotency_key) VALUES ($1,$2,$3,'manual','published_manual',$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`, [workspaceId, id, cur.channel_id, userId, t.external_url ?? null, `manual:${id}`])).rows[0];
      if (job) await c.query("INSERT INTO publication_logs(workspace_id, job_id, level, message) VALUES ($1,$2,'info','Người dùng xác nhận đã đăng thủ công trên nền tảng')", [workspaceId, job.id]);
    }
    await audit(workspaceId, userId, `content.${t.to}`, 'content', id, { from, note: t.note ?? null, scheduled_at: scheduledAt }, c);
    return r;
  });
}

// ---------- Ý tưởng ----------
export async function saveIdeas(workspaceId: string, batch: IdeaBatchT, o: { brandId?: string | null; source: string; workflowRunId?: string | null; isDemo: boolean; aiEstimate?: boolean }) {
  const existing = await q<{ id: string; title: string }>("SELECT id, title FROM ideas WHERE workspace_id=$1 AND status <> 'archived' ORDER BY created_at DESC LIMIT 500", [workspaceId]);
  const kwRows = await q<{ id: string; keyword: string }>('SELECT id, keyword FROM keywords WHERE workspace_id=$1', [workspaceId]);
  const saved: { id: string; title: string; total: number }[] = [];
  const duplicates: { title: string; of: string; similarity: number }[] = [];
  const pool = [...existing];
  for (const i of batch.ideas) {
    const dup = findDuplicate(i.title, pool);
    if (dup) { duplicates.push({ title: i.title, of: dup.title, similarity: Math.round(dup.score * 100) / 100 }); continue; }
    const s = i.scores;
    const total = s.attraction + s.brand_fit + s.retention + s.conversion + s.feasibility;
    const kw = i.keyword ? kwRows.find((k) => k.keyword.toLowerCase() === i.keyword!.toLowerCase()) : null;
    const row = await tx(async (c) => {
      const r = (await c.query(
        `INSERT INTO ideas(workspace_id, brand_id, keyword_id, title, summary, pillar, format, platform, hook, total_score, fingerprint, source, workflow_run_id, is_demo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [workspaceId, o.brandId ?? null, kw?.id ?? null, i.title, i.summary, i.pillar, i.format, i.platform, i.hook, total, fingerprint(i.title), o.source, o.workflowRunId ?? null, o.isDemo])).rows[0];
      await c.query('INSERT INTO idea_scores(workspace_id, idea_id, attraction, brand_fit, retention, conversion, feasibility, total, rationale, is_ai_estimate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [workspaceId, r.id, s.attraction, s.brand_fit, s.retention, s.conversion, s.feasibility, total, i.rationale, o.aiEstimate ?? true]);
      return r;
    });
    pool.push({ id: row.id, title: i.title });
    saved.push({ id: row.id, title: i.title, total });
  }
  return { saved, duplicates };
}

/** Chọn n ý tưởng: ưu tiên điểm cao nhưng tôn trọng tỷ trọng trụ cột (mỗi trụ cột tối đa ceil(weight% × n) + 1). */
export function selectIdeas<T extends { total: number; pillar: string }>(ideas: T[], n: number, pillars: { name: string; weight: number }[]): T[] {
  const total = pillars.reduce((s, p) => s + p.weight, 0) || 1;
  const cap = (name: string) => { const p = pillars.find((x) => x.name === name); return p ? Math.max(1, Math.ceil((p.weight / total) * n) + 1) : n; };
  const used: Record<string, number> = {};
  const out: T[] = [];
  for (const i of [...ideas].sort((a, b) => b.total - a.total)) {
    if (out.length >= n) break;
    if ((used[i.pillar] ?? 0) >= cap(i.pillar)) continue;
    used[i.pillar] = (used[i.pillar] ?? 0) + 1;
    out.push(i);
  }
  for (const i of [...ideas].sort((a, b) => b.total - a.total)) { if (out.length >= n) break; if (!out.includes(i)) out.push(i); }
  return out;
}

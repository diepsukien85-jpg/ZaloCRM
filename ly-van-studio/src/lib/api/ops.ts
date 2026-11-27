import { z } from 'zod';
import fs from 'node:fs';
import { one, q } from '../db';
import { audit } from '../audit';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { toCsv, parseCsvObjects } from '../csv';
import { groupBy, productionCounts, topContent, totals, defaultRange } from '../services/analytics';
import { budgetStatus } from '../ai/budget';
import { getSetting, setSetting } from '../ai/settings';
import { DEFAULT_KPI } from '../services/bootstrap';
import { ALLOWED, assetPath, saveFile, signAsset, validateUpload, verifyAssetSig } from '../services/media';
import { executeRun, cancelRun, startWorkflow, type WorkflowKey } from '../services/workflows';
import { after } from 'next/server';
import type { RouteDef } from '../router';

const SnapshotIn = z.object({
  content_id: z.string().uuid().nullish(), channel_id: z.string().uuid().nullish(), platform: z.string().max(40).default('other'), snapshot_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  views: z.number().int().min(0).default(0), reach: z.number().int().min(0).default(0), watch_time_sec: z.number().int().min(0).default(0), avg_view_duration_sec: z.number().min(0).default(0),
  completion_rate: z.number().min(0).max(100).default(0), likes: z.number().int().min(0).default(0), comments: z.number().int().min(0).default(0), shares: z.number().int().min(0).default(0), saves: z.number().int().min(0).default(0),
  followers_gained: z.number().int().default(0), leads: z.number().int().min(0).default(0), quotes: z.number().int().min(0).default(0), orders: z.number().int().min(0).default(0),
  revenue: z.number().min(0).default(0), gross_profit: z.number().default(0), ad_spend: z.number().min(0).default(0), attribution_method: z.string().max(100).default('manual'), notes: z.string().max(1000).default(''),
});
type Snap = z.infer<typeof SnapshotIn>;

async function insertSnapshot(ws: string, s: Snap, source: 'manual' | 'csv') {
  return one(`INSERT INTO analytics_snapshots(workspace_id, content_id, channel_id, platform, snapshot_date, views, reach, watch_time_sec, avg_view_duration_sec, completion_rate, likes, comments, shares, saves, followers_gained, leads, quotes, orders, revenue, gross_profit, ad_spend, data_source, attribution_method, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
    [ws, s.content_id ?? null, s.channel_id ?? null, s.platform, s.snapshot_date, s.views, s.reach, s.watch_time_sec, s.avg_view_duration_sec, s.completion_rate, s.likes, s.comments, s.shares, s.saves, s.followers_gained, s.leads, s.quotes, s.orders, s.revenue, s.gross_profit, s.ad_spend, source, s.attribution_method, s.notes]);
}

const rangeOf = (qs: URLSearchParams) => {
  const d = defaultRange(30);
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const from = qs.get('from') ?? d.from, to = qs.get('to') ?? d.to;
  if (!re.test(from) || !re.test(to)) throw badRequest('from/to phải là YYYY-MM-DD');
  return { from, to, platform: qs.get('platform'), channel_id: qs.get('channel_id'), brand_id: qs.get('brand_id'), pillar: qs.get('pillar'), content_type: qs.get('content_type') };
};

const LeadIn = z.object({
  name: z.string().min(1).max(200), contact: z.string().max(200).default(''), contact_consent: z.boolean().default(false), source: z.string().max(100).default('manual'), platform: z.string().max(40).nullish(),
  channel_id: z.string().uuid().nullish(), content_id: z.string().uuid().nullish(), need: z.string().max(2000).default(''), product_interest: z.string().max(300).default(''), budget: z.number().min(0).nullish(),
  status: z.enum(['new', 'contacted', 'qualified', 'quoted', 'negotiating', 'won', 'lost']).default('new'), assignee_id: z.string().uuid().nullish(), quote_amount: z.number().min(0).nullish(),
  order_count: z.number().int().min(0).default(0), revenue: z.number().min(0).default(0), gross_profit: z.number().default(0), notes: z.string().max(3000).default(''), external_ref: z.string().max(100).nullish(),
});

export const opsRoutes: RouteDef[] = [
  // ---------- Dashboard ----------
  {
    method: 'GET', path: '/dashboard',
    handler: async (c) => {
      const f = rangeOf(c.query);
      const [tot, prod, top, pillars, trend, kpi, budgets] = await Promise.all([
        totals(c.workspaceId, f), productionCounts(c.workspaceId, f), topContent(c.workspaceId, f, 5), groupBy(c.workspaceId, f, 'pillar'), groupBy(c.workspaceId, f, 'date'),
        getSetting<typeof DEFAULT_KPI>(c.workspaceId, 'kpi'), budgetStatus(c.workspaceId),
      ]);
      const leads = await one<{ n: number }>("SELECT count(*) AS n FROM leads WHERE workspace_id=$1 AND (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date", [c.workspaceId, f.from, f.to]);
      const videosMade = await one<{ n: number }>("SELECT count(*) AS n FROM video_projects WHERE workspace_id=$1 AND (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date", [c.workspaceId, f.from, f.to]);
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      const todayCounts = await productionCounts(c.workspaceId, { from: today, to: today });
      const last = await one('SELECT id, workflow_key, status, started_at, finished_at, is_demo FROM workflow_runs WHERE workspace_id=$1 AND workflow_key=\'daily\' ORDER BY created_at DESC LIMIT 1', [c.workspaceId]);
      return { range: f, production: prod, today: todayCounts, videos_made: videosMade?.n ?? 0, leads_in_range: leads?.n ?? 0, ...tot, top, pillars, trend, kpi: kpi ?? DEFAULT_KPI, budgets, last_daily_run: last };
    },
  },
  // ---------- Analytics ----------
  { method: 'GET', path: '/analytics/summary', handler: async (c) => totals(c.workspaceId, rangeOf(c.query)) },
  {
    method: 'GET', path: '/analytics/groups',
    handler: async (c) => {
      const dim = c.query.get('dim') ?? 'pillar';
      if (!['pillar', 'platform', 'content_type', 'channel', 'hook', 'date'].includes(dim)) throw badRequest('dim không hợp lệ');
      return { items: await groupBy(c.workspaceId, rangeOf(c.query), dim as 'pillar') };
    },
  },
  { method: 'GET', path: '/analytics/top', handler: async (c) => ({ items: await topContent(c.workspaceId, rangeOf(c.query), 20) }) },
  {
    method: 'GET', path: '/analytics/snapshots',
    handler: async (c) => ({ items: await q('SELECT a.*, ct.title AS content_title, ch.name AS channel_name FROM analytics_snapshots a LEFT JOIN contents ct ON ct.id=a.content_id LEFT JOIN channels ch ON ch.id=a.channel_id WHERE a.workspace_id=$1 ORDER BY a.snapshot_date DESC, a.created_at DESC LIMIT 300', [c.workspaceId]) }),
  },
  { method: 'POST', path: '/analytics/snapshots', schema: SnapshotIn, handler: async (c) => insertSnapshot(c.workspaceId, c.body as Snap, 'manual') },
  { method: 'DELETE', path: '/analytics/snapshots/:id', handler: async (c) => { await q('DELETE FROM analytics_snapshots WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]); return { ok: true }; } },
  {
    // Import CSV: cột tiếng Anh theo tên trường. Từng dòng được validate, lỗi trả về theo số dòng.
    method: 'POST', path: '/analytics/import', schema: z.object({ csv: z.string().min(10).max(2_000_000) }),
    handler: async (c) => {
      const rows = parseCsvObjects((c.body as { csv: string }).csv);
      const errors: { line: number; error: string }[] = []; let imported = 0;
      const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
      for (const [i, r] of rows.entries()) {
        const raw: Record<string, unknown> = { ...r };
        for (const k of Object.keys(SnapshotIn.shape)) if (!['platform', 'snapshot_date', 'content_id', 'channel_id', 'attribution_method', 'notes'].includes(k)) raw[k] = num(r[k]);
        raw.content_id = r.content_id || null; raw.channel_id = r.channel_id || null;
        const p = SnapshotIn.safeParse(raw);
        if (!p.success) { errors.push({ line: i + 2, error: p.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') }); continue; }
        try { await insertSnapshot(c.workspaceId, p.data, 'csv'); imported++; } catch (e) { errors.push({ line: i + 2, error: (e as Error).message }); }
      }
      await audit(c.workspaceId, c.user.id, 'analytics.import', 'analytics', undefined, { imported, errors: errors.length });
      return { imported, errors: errors.slice(0, 50) };
    },
  },
  {
    method: 'GET', path: '/analytics/export.csv',
    handler: async (c) => new Response(toCsv(await q('SELECT snapshot_date, platform, content_id, channel_id, views, reach, watch_time_sec, avg_view_duration_sec, completion_rate, likes, comments, shares, saves, followers_gained, leads, quotes, orders, revenue, gross_profit, ad_spend, data_source, attribution_method, notes FROM analytics_snapshots WHERE workspace_id=$1 ORDER BY snapshot_date DESC', [c.workspaceId])), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="analytics.csv"' } }),
  },

  // ---------- KPI & lịch ----------
  { method: 'GET', path: '/kpi', handler: async (c) => (await getSetting(c.workspaceId, 'kpi')) ?? DEFAULT_KPI },
  { method: 'PUT', path: '/kpi', min: 'admin', schema: z.object({ posts_per_day: z.number().min(0).max(50), short_videos_per_day: z.number().min(0).max(50), originals_per_30_days: z.number().min(0).max(5000) }), handler: async (c) => { await setSetting(c.workspaceId, 'kpi', c.body); return c.body; } },
  {
    method: 'GET', path: '/calendar',
    handler: async (c) => {
      const from = c.query.get('from'), to = c.query.get('to');
      if (!from || !to) throw badRequest('Cần from & to');
      return { items: await q(`SELECT c.id, c.title, c.platform, c.content_type, c.status, c.scheduled_at, c.assignee_id, u.name AS assignee_name, ch.name AS channel_name, c.is_demo
        FROM contents c LEFT JOIN users u ON u.id=c.assignee_id LEFT JOIN channels ch ON ch.id=c.channel_id
        WHERE c.workspace_id=$1 AND c.parent_content_id IS NULL AND c.scheduled_at IS NOT NULL AND c.scheduled_at >= $2::timestamptz AND c.scheduled_at < $3::timestamptz ORDER BY c.scheduled_at`, [c.workspaceId, from, to]) };
    },
  },
  {
    // Kéo thả: đổi giờ. Nếu lịch đã XÁC NHẬN → bắt buộc confirm (phê duyệt thay đổi lịch đã xác nhận).
    method: 'PATCH', path: '/calendar/:id/move', schema: z.object({ scheduled_at: z.string().min(10), confirm: z.boolean().default(false) }),
    handler: async (c) => {
      const b = c.body as { scheduled_at: string; confirm: boolean };
      const cur = await one<{ status: string }>('SELECT status FROM contents WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!cur) throw notFound();
      if (cur.status === 'published') throw conflict('Nội dung đã đăng, không thể đổi lịch');
      if (cur.status === 'scheduled' && !b.confirm) throw conflict('Thay đổi lịch đã xác nhận cần được bạn xác nhận lại');
      const when = new Date(b.scheduled_at);
      if (Number.isNaN(when.getTime())) throw badRequest('Thời điểm không hợp lệ');
      await q('UPDATE contents SET scheduled_at=$3 WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId, when.toISOString()]);
      await q("UPDATE schedules SET scheduled_at=$3 WHERE content_id=$1 AND workspace_id=$2 AND status IN ('planned','confirmed')", [c.params.id, c.workspaceId, when.toISOString()]);
      if (cur.status === 'scheduled') {
        await q("INSERT INTO content_approvals(workspace_id, content_id, action, actor_id, note) VALUES ($1,$2,'reschedule_confirm',$3,$4)", [c.workspaceId, c.params.id, c.user.id, `Dời lịch sang ${when.toISOString()}`]);
        await audit(c.workspaceId, c.user.id, 'content.reschedule', 'content', c.params.id, { to: when.toISOString() });
      }
      return { ok: true };
    },
  },

  // ---------- Leads ----------
  {
    method: 'GET', path: '/leads',
    handler: async (c) => {
      const p: unknown[] = [c.workspaceId]; let w = 'l.workspace_id=$1';
      if (c.query.get('status')) { p.push(c.query.get('status')); w += ` AND l.status=$${p.length}`; }
      const s = c.query.get('q'); if (s) { p.push(`%${s}%`); w += ` AND (l.name ILIKE $${p.length} OR l.need ILIKE $${p.length})`; }
      return { items: await q(`SELECT l.*, ct.title AS content_title, ch.name AS channel_name, u.name AS assignee_name FROM leads l LEFT JOIN contents ct ON ct.id=l.content_id LEFT JOIN channels ch ON ch.id=l.channel_id LEFT JOIN users u ON u.id=l.assignee_id WHERE ${w} ORDER BY l.created_at DESC LIMIT 500`, p) };
    },
  },
  {
    method: 'POST', path: '/leads', schema: LeadIn,
    handler: async (c) => {
      const b = c.body as z.infer<typeof LeadIn>;
      const r = await one<{ id: string }>('INSERT INTO leads(workspace_id, name, contact, contact_consent, source, platform, channel_id, content_id, need, product_interest, budget, status, assignee_id, quote_amount, order_count, revenue, gross_profit, notes, external_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *',
        [c.workspaceId, b.name, b.contact, b.contact_consent, b.source, b.platform ?? null, b.channel_id ?? null, b.content_id ?? null, b.need, b.product_interest, b.budget ?? null, b.status, b.assignee_id ?? null, b.quote_amount ?? null, b.order_count, b.revenue, b.gross_profit, b.notes, b.external_ref ?? null]);
      return r;
    },
  },
  {
    method: 'PATCH', path: '/leads/:id', schema: LeadIn.partial(),
    handler: async (c) => {
      const b = c.body as Record<string, unknown>;
      const allowed = ['name', 'contact', 'contact_consent', 'source', 'platform', 'channel_id', 'content_id', 'need', 'product_interest', 'budget', 'status', 'assignee_id', 'quote_amount', 'order_count', 'revenue', 'gross_profit', 'notes', 'external_ref'];
      const cols = Object.keys(b).filter((k) => allowed.includes(k) && b[k] !== undefined);
      if (!cols.length) throw badRequest('Không có gì để cập nhật');
      const r = await one(`UPDATE leads SET ${cols.map((k, i) => `${k}=$${i + 3}`).join(',')} WHERE id=$1 AND workspace_id=$2 RETURNING *`, [c.params.id, c.workspaceId, ...cols.map((k) => b[k])]);
      if (!r) throw notFound();
      return r;
    },
  },
  { method: 'DELETE', path: '/leads/:id', min: 'admin', handler: async (c) => { await q('DELETE FROM leads WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]); await audit(c.workspaceId, c.user.id, 'lead.delete', 'lead', c.params.id); return { ok: true }; } },
  {
    method: 'POST', path: '/leads/import', schema: z.object({ csv: z.string().min(5).max(2_000_000), consent_confirmed: z.boolean() }),
    handler: async (c) => {
      const b = c.body as { csv: string; consent_confirmed: boolean };
      if (!b.consent_confirmed) throw badRequest('Cần xác nhận dữ liệu liên hệ được thu thập hợp lệ (có sự đồng ý) trước khi import');
      const rows = parseCsvObjects(b.csv); const errors: { line: number; error: string }[] = []; let imported = 0;
      for (const [i, r] of rows.entries()) {
        const p = LeadIn.safeParse({ name: r.name, contact: r.contact ?? '', contact_consent: true, source: r.source || 'csv', platform: r.platform || null, need: r.need ?? '', product_interest: r.product_interest ?? '', budget: r.budget ? Number(r.budget) : null, status: r.status || 'new', notes: r.notes ?? '', external_ref: r.external_ref || null });
        if (!p.success) { errors.push({ line: i + 2, error: p.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') }); continue; }
        const d = p.data;
        try {
          await q('INSERT INTO leads(workspace_id, name, contact, contact_consent, source, platform, need, product_interest, budget, status, notes, external_ref) VALUES ($1,$2,$3,true,$4,$5,$6,$7,$8,$9,$10,$11)', [c.workspaceId, d.name, d.contact, d.source, d.platform ?? null, d.need, d.product_interest, d.budget ?? null, d.status, d.notes, d.external_ref ?? null]);
          imported++;
        } catch (e) { errors.push({ line: i + 2, error: (e as { code?: string }).code === '23505' ? 'Trùng external_ref' : (e as Error).message }); }
      }
      return { imported, errors: errors.slice(0, 50) };
    },
  },
  {
    method: 'GET', path: '/leads/export.csv',
    handler: async (c) => new Response(toCsv(await q('SELECT name, contact, source, platform, need, product_interest, budget, status, quote_amount, order_count, revenue, gross_profit, notes, created_at FROM leads WHERE workspace_id=$1 ORDER BY created_at DESC', [c.workspaceId])), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="leads.csv"' } }),
  },
  {
    method: 'POST', path: '/leads/:id/attribute', schema: z.object({ content_id: z.string().uuid(), method: z.enum(['manual', 'first_touch', 'last_touch']).default('manual'), revenue: z.number().min(0), gross_profit: z.number(), note: z.string().max(500).default('') }),
    handler: async (c) => {
      const b = c.body as { content_id: string; method: string; revenue: number; gross_profit: number; note: string };
      if (!(await one('SELECT 1 FROM leads WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]))) throw notFound();
      if (!(await one('SELECT 1 FROM contents WHERE id=$1 AND workspace_id=$2', [b.content_id, c.workspaceId]))) throw badRequest('Nội dung không thuộc workspace');
      return one('INSERT INTO sales_attributions(workspace_id, lead_id, content_id, method, revenue, gross_profit, note) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [c.workspaceId, c.params.id, b.content_id, b.method, b.revenue, b.gross_profit, b.note]);
    },
  },

  // ---------- Workflow & tự động hoá ----------
  {
    method: 'GET', path: '/workflows',
    handler: async (c) => {
      const defs = await q('SELECT d.key, d.name, d.description, d.steps, d.implemented, s.enabled, s.hour, s.minute, s.weekday, s.day_of_month, s.timezone, s.budget_limit_usd, s.last_run_at, s.next_run_at, s.confirmed_at FROM workflow_definitions d LEFT JOIN automation_schedules s ON s.workspace_id=d.workspace_id AND s.workflow_key=d.key WHERE d.workspace_id=$1 ORDER BY d.key', [c.workspaceId]);
      const runs = await q('SELECT id, workflow_key, status, trigger, attempt, error, is_demo, started_at, finished_at, created_at FROM workflow_runs WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 30', [c.workspaceId]);
      return { items: defs, runs };
    },
  },
  {
    method: 'POST', path: '/workflows/:key/run', schema: z.object({ idempotency_key: z.string().max(100).optional(), budget_usd: z.number().min(0).max(1000).nullish() }), rate: { key: 'wf', max: 10 },
    handler: async (c) => {
      const key = c.params.key as WorkflowKey;
      if (!['daily', 'weekly', 'monthly'].includes(key)) throw notFound('Workflow không tồn tại');
      const b = c.body as { idempotency_key?: string; budget_usd?: number | null };
      const id = await startWorkflow(c.workspaceId, c.user.id, key, { idempotencyKey: b.idempotency_key, budgetUsd: b.budget_usd });
      // Chạy nền sau khi trả response (self-hosted Node); trạng thái được lưu trong DB để UI theo dõi.
      after(() => executeRun(id).catch((e) => console.error('[workflow]', e)));
      return { run_id: id };
    },
  },
  {
    method: 'GET', path: '/workflow-runs/:id',
    handler: async (c) => {
      const run = await one('SELECT * FROM workflow_runs WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!run) throw notFound();
      const [steps, usage] = await Promise.all([
        q('SELECT step_no, name, status, output_summary, error, started_at, finished_at, duration_ms FROM workflow_steps WHERE run_id=$1 ORDER BY step_no', [c.params.id]),
        one<{ usd: number; tokens: number }>('SELECT COALESCE(SUM(est_cost_usd),0) AS usd, COALESCE(SUM(input_tokens+output_tokens),0) AS tokens FROM ai_usage_logs WHERE workflow_run_id=$1', [c.params.id]),
      ]);
      return { run, steps, usage };
    },
  },
  { method: 'POST', path: '/workflow-runs/:id/cancel', handler: async (c) => { await cancelRun(c.workspaceId, c.params.id); return { ok: true }; } },
  {
    method: 'POST', path: '/workflow-runs/:id/retry',
    handler: async (c) => {
      const r = await one<{ workflow_key: WorkflowKey; status: string; attempt: number }>('SELECT workflow_key, status, attempt FROM workflow_runs WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!r) throw notFound();
      if (!['failed', 'cancelled'].includes(r.status)) throw conflict('Chỉ chạy lại lần chạy thất bại/đã huỷ');
      const id = await startWorkflow(c.workspaceId, c.user.id, r.workflow_key, { attempt: r.attempt + 1 });
      after(() => executeRun(id).catch((e) => console.error('[workflow]', e)));
      return { run_id: id };
    },
  },
  {
    // Bật/tắt lịch tự động. Bật = người dùng xác nhận rõ ràng (confirm) → ghi người xác nhận & audit.
    method: 'PUT', path: '/automations/:key', min: 'admin',
    schema: z.object({ enabled: z.boolean(), confirm: z.boolean().optional(), hour: z.number().int().min(0).max(23).optional(), minute: z.number().int().min(0).max(59).optional(), budget_limit_usd: z.number().min(0).nullish() }),
    handler: async (c) => {
      const b = c.body as { enabled: boolean; confirm?: boolean; hour?: number; minute?: number; budget_limit_usd?: number | null };
      if (b.enabled && !b.confirm) throw badRequest('Cần xác nhận để bật chạy tự động theo lịch (confirm=true)');
      const r = await one('UPDATE automation_schedules SET enabled=$3, hour=COALESCE($4,hour), minute=COALESCE($5,minute), budget_limit_usd=COALESCE($6,budget_limit_usd), confirmed_by=CASE WHEN $3 THEN $7::uuid ELSE confirmed_by END, confirmed_at=CASE WHEN $3 THEN now() ELSE confirmed_at END, next_run_at=NULL WHERE workspace_id=$1 AND workflow_key=$2 RETURNING *',
        [c.workspaceId, c.params.key, b.enabled, b.hour ?? null, b.minute ?? null, b.budget_limit_usd ?? null, c.user.id]);
      if (!r) throw notFound();
      await audit(c.workspaceId, c.user.id, b.enabled ? 'automation.enable' : 'automation.disable', 'workflow', c.params.key);
      return r;
    },
  },

  // ---------- Media ----------
  {
    method: 'GET', path: '/media',
    handler: async (c) => {
      const items = await q<{ id: string }>('SELECT id, kind, filename, mime, size_bytes, privacy, tags, transcript IS NOT NULL AS has_transcript, created_at FROM media_assets WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 300', [c.workspaceId]);
      return { items: items.map((i) => ({ ...i, url: signAsset(i.id) })), allowed: Object.keys(ALLOWED) };
    },
  },
  {
    method: 'POST', path: '/media', rate: { key: 'upload', max: 40 },
    handler: async (c) => {
      const form = await c.req.formData();
      const f = form.get('file');
      if (!(f instanceof File)) throw badRequest('Thiếu file');
      const buf = Buffer.from(await f.arrayBuffer());
      const kind = validateUpload(f.name, f.type, buf.length, buf.subarray(0, 16));
      const ext = f.name.split('.').pop()!.toLowerCase();
      const rel = saveFile(c.workspaceId, ext, buf);
      const privacy = ['private', 'internal', 'public'].includes(String(form.get('privacy'))) ? String(form.get('privacy')) : 'internal';
      const row = await one<{ id: string }>('INSERT INTO media_assets(workspace_id, kind, filename, mime, size_bytes, storage_path, privacy, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, kind, filename, mime, size_bytes, privacy, created_at',
        [c.workspaceId, kind, f.name.replace(/[^\w.\- ()À-ỹ]+/g, '_').slice(0, 150), f.type, buf.length, rel, privacy, c.user.id]);
      await audit(c.workspaceId, c.user.id, 'media.upload', 'media', row!.id, { mime: f.type, size: buf.length });
      return { ...row, url: signAsset(row!.id) };
    },
  },
  { method: 'GET', path: '/media/:id/url', handler: async (c) => { if (!(await one('SELECT 1 FROM media_assets WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]))) throw notFound(); return { url: signAsset(c.params.id) }; } },
  {
    // Tải bằng signed URL (dùng cho thẻ <img>/<audio>). Không cần cookie nhưng chữ ký phải hợp lệ & còn hạn.
    method: 'GET', path: '/media/:id/file', public: true,
    handler: async ({ params, query }) => {
      if (!verifyAssetSig(params.id, query.get('exp'), query.get('sig'))) throw forbidden('Liên kết không hợp lệ hoặc đã hết hạn');
      const a = await one<{ storage_path: string; mime: string; filename: string }>('SELECT storage_path, mime, filename FROM media_assets WHERE id=$1', [params.id]);
      if (!a) throw notFound();
      const file = assetPath(a.storage_path);
      if (!fs.existsSync(file)) throw notFound('File không còn trên máy chủ');
      return new Response(new Uint8Array(fs.readFileSync(file)), { headers: { 'content-type': a.mime, 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(a.filename)}`, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, max-age=300' } });
    },
  },
  {
    method: 'PATCH', path: '/media/:id', schema: z.object({ privacy: z.enum(['private', 'internal', 'public']).optional(), tags: z.array(z.string().max(40)).max(20).optional(), transcript: z.string().max(100000).optional() }),
    handler: async (c) => { const b = c.body as Record<string, unknown>; const r = await one('UPDATE media_assets SET privacy=COALESCE($3,privacy), tags=COALESCE($4,tags), transcript=COALESCE($5,transcript) WHERE id=$1 AND workspace_id=$2 RETURNING id, privacy, tags', [c.params.id, c.workspaceId, b.privacy ?? null, b.tags ?? null, b.transcript ?? null]); if (!r) throw notFound(); return r; },
  },
  {
    method: 'DELETE', path: '/media/:id', min: 'editor',
    handler: async (c) => {
      const a = await one<{ storage_path: string }>('DELETE FROM media_assets WHERE id=$1 AND workspace_id=$2 RETURNING storage_path', [c.params.id, c.workspaceId]);
      if (!a) throw notFound();
      try { fs.unlinkSync(assetPath(a.storage_path)); } catch { /* file đã mất */ }
      await audit(c.workspaceId, c.user.id, 'media.delete', 'media', c.params.id);
      return { ok: true };
    },
  },
];

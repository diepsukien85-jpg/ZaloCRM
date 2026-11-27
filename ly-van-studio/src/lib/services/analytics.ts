import { q, one } from '../db';
import { getPricing } from '../ai/pricing';
import { summarize, type Totals } from '../metrics';

export type Filters = { from: string; to: string; platform?: string | null; channel_id?: string | null; brand_id?: string | null; pillar?: string | null; content_type?: string | null };

export function defaultRange(days = 30): { from: string; to: string } {
  const to = new Date(); const from = new Date(Date.now() - (days - 1) * 86400000);
  const f = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  return { from: f(from), to: f(to) };
}

function where(w: string, f: Filters, start = 2) {
  const p: unknown[] = [f.from, f.to]; let i = start + 1;
  let sql = `${w} AND a.snapshot_date BETWEEN $${start - 1}::date AND $${start}::date`;
  if (f.platform) { sql += ` AND a.platform = $${i++}`; p.push(f.platform); }
  if (f.channel_id) { sql += ` AND a.channel_id = $${i++}`; p.push(f.channel_id); }
  if (f.brand_id) { sql += ` AND c.brand_id = $${i++}`; p.push(f.brand_id); }
  if (f.pillar) { sql += ` AND c.pillar = $${i++}`; p.push(f.pillar); }
  if (f.content_type) { sql += ` AND c.content_type = $${i++}`; p.push(f.content_type); }
  return { sql, p };
}

const SUMS = `COALESCE(SUM(a.views),0) AS views, COALESCE(SUM(a.reach),0) AS reach, COALESCE(SUM(a.likes),0) AS likes, COALESCE(SUM(a.comments),0) AS comments,
  COALESCE(SUM(a.shares),0) AS shares, COALESCE(SUM(a.saves),0) AS saves, COALESCE(SUM(a.leads),0) AS leads, COALESCE(SUM(a.orders),0) AS orders,
  COALESCE(SUM(a.revenue),0) AS revenue, COALESCE(SUM(a.gross_profit),0) AS gross_profit, COALESCE(SUM(a.ad_spend),0) AS ad_spend,
  COALESCE(SUM(a.followers_gained),0) AS followers, COUNT(*) AS snapshots`;

export async function totals(workspaceId: string, f: Filters) {
  const w = where('WHERE a.workspace_id = $1', f, 3);
  // $1 = workspace; dịch tham số: from=$2,to=$3
  const sql = `SELECT ${SUMS} FROM analytics_snapshots a LEFT JOIN contents c ON c.id = a.content_id ${w.sql.replace('$2::date AND a.snapshot_date', '$2::date AND a.snapshot_date')}`;
  const row = (await q<Record<string, number>>(sql, [workspaceId, ...w.p]))[0];
  const usage = await one<{ usd: number; n: number }>(
    `SELECT COALESCE(SUM(est_cost_usd),0) AS usd, COUNT(*) AS n FROM ai_usage_logs WHERE workspace_id=$1 AND (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date`, [workspaceId, f.from, f.to]);
  const pricing = await getPricing(workspaceId);
  const ai_cost = (usage?.usd ?? 0) * pricing.usd_to_vnd;
  const t: Totals = { views: row.views, reach: row.reach, likes: row.likes, comments: row.comments, shares: row.shares, saves: row.saves, leads: row.leads, orders: row.orders, revenue: row.revenue, gross_profit: row.gross_profit, ad_spend: row.ad_spend, ai_cost };
  return { totals: t, followers: row.followers, snapshots: row.snapshots, ai_cost_usd: usage?.usd ?? 0, usd_to_vnd: pricing.usd_to_vnd, metrics: summarize(t), pricing_verified: pricing.verified };
}

export async function groupBy(workspaceId: string, f: Filters, dim: 'pillar' | 'platform' | 'content_type' | 'channel' | 'hook' | 'date') {
  const col = { pillar: "COALESCE(NULLIF(c.pillar,''),'(chưa gán)')", platform: 'a.platform', content_type: "COALESCE(c.content_type,'(không gắn nội dung)')", channel: "COALESCE(ch.name,'(không gắn kênh)')", hook: "COALESCE(NULLIF(c.hooks[1],''),'(không có hook)')", date: "to_char(a.snapshot_date,'YYYY-MM-DD')" }[dim];
  const w = where('WHERE a.workspace_id = $1', f, 3);
  const rows = await q<Record<string, number | string>>(
    `SELECT ${col} AS label, ${SUMS} FROM analytics_snapshots a LEFT JOIN contents c ON c.id=a.content_id LEFT JOIN channels ch ON ch.id=a.channel_id ${w.sql} GROUP BY 1 ORDER BY ${dim === 'date' ? '1' : 'views DESC'} LIMIT 200`, [workspaceId, ...w.p]);
  return rows.map((r) => ({ ...r, engagement_rate: summarize({ views: +r.views, reach: +r.reach, likes: +r.likes, comments: +r.comments, shares: +r.shares, saves: +r.saves, leads: +r.leads, orders: +r.orders, revenue: +r.revenue, gross_profit: +r.gross_profit, ad_spend: +r.ad_spend, ai_cost: 0 }).engagement_rate }));
}

export async function topContent(workspaceId: string, f: Filters, limit = 10) {
  const w = where('WHERE a.workspace_id = $1 AND a.content_id IS NOT NULL', f, 3);
  return q(`SELECT c.id, c.title, c.platform, c.pillar, ${SUMS}, CASE WHEN SUM(a.views) > 0 THEN (SUM(a.likes+a.comments+a.shares+a.saves)::float / SUM(a.views)) * 100 END AS engagement_rate
            FROM analytics_snapshots a JOIN contents c ON c.id=a.content_id ${w.sql} GROUP BY c.id ORDER BY views DESC LIMIT ${Math.min(limit, 100)}`, [workspaceId, ...w.p]);
}

/** Số lượng nội dung GỐC (không đếm biến thể phân phối) để KPI không bị đếm trùng. */
export async function productionCounts(workspaceId: string, f: Pick<Filters, 'from' | 'to'>) {
  const r = await one<Record<string, number>>(
    `SELECT COUNT(*) FILTER (WHERE parent_content_id IS NULL AND status <> 'archived') AS originals,
            COUNT(*) FILTER (WHERE parent_content_id IS NULL AND content_type IN ('post','carousel','infographic') AND status <> 'archived') AS posts,
            COUNT(*) FILTER (WHERE parent_content_id IS NULL AND content_type='video_script' AND status <> 'archived') AS videos,
            COUNT(*) FILTER (WHERE parent_content_id IS NULL AND status='pending_review') AS pending,
            COUNT(*) FILTER (WHERE parent_content_id IS NULL AND status='scheduled') AS scheduled,
            COUNT(*) FILTER (WHERE parent_content_id IS NULL AND status='published') AS published
     FROM contents WHERE workspace_id=$1 AND (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date`, [workspaceId, f.from, f.to]);
  return r!;
}

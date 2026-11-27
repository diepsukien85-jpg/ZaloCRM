import { z } from 'zod';
import { one, q, tx } from '../db';
import { audit } from '../audit';
import { badRequest, notFound } from '../errors';
import { toCsv } from '../csv';
import { redactPII } from '../ai/safety';
import { willUseExternal } from '../ai/client';
import * as A from '../ai/agents';
import { saveIdeas } from '../services/content';
import type { KeywordExpansionT } from '../ai/schemas';
import type { RouteDef } from '../router';

const AI_RATE = { key: 'ai', max: 30 };

export async function saveKeywords(workspaceId: string, brandId: string | null, items: KeywordExpansionT['keywords'], source: string, isDemo: boolean) {
  let added = 0, skipped = 0;
  const ids = new Map<string, string>();
  // Lưu theo tầng để từ khoá cha có trước
  for (const k of [...items].sort((a, b) => a.tier - b.tier)) {
    const parent = k.parent ? (ids.get(k.parent.toLowerCase()) ?? (await one<{ id: string }>('SELECT id FROM keywords WHERE workspace_id=$1 AND lower(keyword)=lower($2) ORDER BY tier LIMIT 1', [workspaceId, k.parent]))?.id ?? null) : null;
    const r = await one<{ id: string }>(
      `INSERT INTO keywords(workspace_id, brand_id, keyword, parent_keyword_id, language, category, search_intent, audience, funnel_stage, tier, relevance_score, content_potential_score, source, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING RETURNING id`,
      [workspaceId, brandId, k.keyword.trim(), parent, k.language, k.category, k.search_intent, k.audience, k.funnel_stage, k.tier, k.relevance_score, k.content_potential_score, source, isDemo]);
    if (r) { added++; ids.set(k.keyword.toLowerCase(), r.id); } else skipped++;
  }
  return { added, skipped };
}

const KwIn = z.object({
  keyword: z.string().min(1).max(200), parent_keyword_id: z.string().uuid().nullish(), language: z.enum(['vi', 'en', 'zh']).default('vi'), category: z.string().max(100).default(''),
  search_intent: z.enum(['informational', 'navigational', 'commercial', 'transactional']).default('informational'), audience: z.string().max(200).default(''),
  funnel_stage: z.enum(['awareness', 'consideration', 'decision', 'retention']).default('awareness'), tier: z.number().int().min(1).max(5).default(1),
});
const KwPatch = z.object({
  favorite: z.boolean().optional(), labels: z.array(z.string().max(40)).max(20).optional(), category: z.string().max(100).optional(),
  // Lượng tìm kiếm chỉ được nhập kèm nguồn xác thực — không bao giờ tự bịa
  search_volume: z.number().int().min(0).nullish(), search_volume_source: z.string().min(2).max(200).nullish(),
}).refine((v) => v.search_volume == null || !!v.search_volume_source, { message: 'Phải ghi rõ nguồn khi nhập lượng tìm kiếm' });

const TrendIn = z.object({
  title: z.string().min(1).max(300), platform: z.string().max(40).default('other'), url: z.string().url().max(500).nullish(), country: z.string().max(10).nullish(), language: z.string().max(10).nullish(),
  published_at: z.string().nullish(), keywords: z.array(z.string().max(100)).max(20).default([]), reason: z.string().max(2000).default(''),
  metrics: z.record(z.string(), z.union([z.number(), z.string()])).default({}), reliability: z.string().max(100).default('unverified'),
  verification_status: z.enum(['unverified', 'verified', 'rejected']).default('unverified'),
});

export const researchRoutes: RouteDef[] = [
  {
    method: 'GET', path: '/keywords',
    handler: async (c) => {
      const w = ['workspace_id=$1']; const p: unknown[] = [c.workspaceId];
      const add = (cond: string, v: unknown) => { p.push(v); w.push(cond.replace('?', `$${p.length}`)); };
      const qs = c.query;
      if (qs.get('q')) add('keyword ILIKE ?', `%${qs.get('q')}%`);
      if (qs.get('tier')) add('tier = ?', Number(qs.get('tier')));
      if (qs.get('language')) add('language = ?', qs.get('language'));
      if (qs.get('funnel_stage')) add('funnel_stage = ?', qs.get('funnel_stage'));
      if (qs.get('label')) add('? = ANY(labels)', qs.get('label'));
      if (qs.get('favorite') === 'true') w.push('favorite');
      return { items: await q(`SELECT * FROM keywords WHERE ${w.join(' AND ')} ORDER BY favorite DESC, tier, content_potential_score DESC NULLS LAST, keyword LIMIT 1000`, p) };
    },
  },
  {
    method: 'POST', path: '/keywords', schema: KwIn,
    handler: async (c) => {
      const k = c.body as z.infer<typeof KwIn>;
      const brand = await one<{ id: string }>("SELECT id FROM brands WHERE workspace_id=$1 ORDER BY (kind='personal') DESC LIMIT 1", [c.workspaceId]);
      return one(`INSERT INTO keywords(workspace_id, brand_id, keyword, parent_keyword_id, language, category, search_intent, audience, funnel_stage, tier, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual') RETURNING *`,
        [c.workspaceId, brand?.id ?? null, k.keyword.trim(), k.parent_keyword_id ?? null, k.language, k.category, k.search_intent, k.audience, k.funnel_stage, k.tier]);
    },
  },
  {
    method: 'PATCH', path: '/keywords/:id', schema: KwPatch,
    handler: async (c) => {
      const b = c.body as z.infer<typeof KwPatch>;
      const r = await one(`UPDATE keywords SET favorite=COALESCE($3,favorite), labels=COALESCE($4,labels), category=COALESCE($5,category),
        search_volume = CASE WHEN $6::boolean THEN $7 ELSE search_volume END, search_volume_source = CASE WHEN $6::boolean THEN $8 ELSE search_volume_source END
        WHERE id=$1 AND workspace_id=$2 RETURNING *`, [c.params.id, c.workspaceId, b.favorite ?? null, b.labels ?? null, b.category ?? null, b.search_volume !== undefined, b.search_volume ?? null, b.search_volume ?? null ? b.search_volume_source : null]);
      if (!r) throw notFound();
      return r;
    },
  },
  {
    method: 'DELETE', path: '/keywords/:id',
    handler: async (c) => { await q('DELETE FROM keywords WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]); return { ok: true }; },
  },
  {
    method: 'POST', path: '/keywords/expand', rate: AI_RATE,
    schema: z.object({ roots: z.array(z.string().min(1).max(100)).min(1).max(10), count: z.union([z.literal(20), z.literal(50), z.literal(100)]).default(20), languages: z.array(z.enum(['vi', 'en', 'zh'])).optional() }),
    handler: async (c) => {
      const b = c.body as { roots: string[]; count: 20 | 50 | 100; languages?: string[] };
      const brand = await one<{ id: string }>("SELECT id FROM brands WHERE workspace_id=$1 ORDER BY (kind='personal') DESC LIMIT 1", [c.workspaceId]);
      const r = await A.expandKeywords({ workspaceId: c.workspaceId, userId: c.user.id, brandId: brand?.id }, b);
      const kws = r.data.keywords.filter((k) => !b.languages || b.languages.includes(k.language));
      const saved = await saveKeywords(c.workspaceId, brand?.id ?? null, kws, r.meta.demo ? 'demo' : 'ai', r.meta.demo);
      return { ...saved, total: kws.length, meta: r.meta };
    },
  },
  {
    method: 'GET', path: '/keywords/export.csv',
    handler: async (c) => {
      const rows = await q('SELECT keyword, language, tier, category, search_intent, audience, funnel_stage, relevance_score, content_potential_score, search_volume, search_volume_source, source, favorite, labels, updated_at FROM keywords WHERE workspace_id=$1 ORDER BY tier, keyword', [c.workspaceId]);
      return new Response(toCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="keywords.csv"' } });
    },
  },
  {
    // Từ khoá → ý tưởng / series 5 tập / kế hoạch 30 ngày (tạo ý tưởng, KHÔNG tự đăng)
    method: 'POST', path: '/keywords/:id/plan', rate: AI_RATE, schema: z.object({ kind: z.enum(['idea', 'series', 'plan30']) }),
    handler: async (c) => {
      const k = await one<{ keyword: string; brand_id: string | null }>('SELECT keyword, brand_id FROM keywords WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!k) throw notFound();
      const kind = (c.body as { kind: 'idea' | 'series' | 'plan30' }).kind;
      const count = kind === 'idea' ? 3 : kind === 'series' ? 5 : 30;
      const exclude = (await q<{ title: string }>('SELECT title FROM ideas WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [c.workspaceId])).map((r) => r.title);
      const r = await A.generateIdeas({ workspaceId: c.workspaceId, userId: c.user.id, brandId: k.brand_id }, { count, keywords: [k.keyword], exclude });
      const tagged = { ideas: r.data.ideas.map((i, n) => ({ ...i, summary: kind === 'plan30' ? `Ngày ${n + 1}: ${i.summary}` : kind === 'series' ? `Tập ${n + 1}: ${i.summary}` : i.summary, keyword: k.keyword })) };
      const s = await saveIdeas(c.workspaceId, tagged, { brandId: k.brand_id, source: `keyword_${kind}`, isDemo: r.meta.demo });
      return { ...s, meta: r.meta };
    },
  },

  // ---- Trend Radar (nhập thủ công; không tự cào dữ liệu) ----
  {
    method: 'GET', path: '/trends',
    handler: async (c) => {
      const w = ['workspace_id=$1']; const p: unknown[] = [c.workspaceId];
      for (const f of ['platform', 'status', 'verification_status', 'language', 'country']) { const v = c.query.get(f); if (v) { p.push(v); w.push(`${f}=$${p.length}`); } }
      const q2 = c.query.get('q'); if (q2) { p.push(`%${q2}%`); w.push(`title ILIKE $${p.length}`); }
      return { items: await q(`SELECT * FROM trends WHERE ${w.join(' AND ')} ORDER BY collected_at DESC LIMIT 300`, p), sources: await q('SELECT * FROM trend_sources WHERE workspace_id=$1', [c.workspaceId]) };
    },
  },
  {
    method: 'POST', path: '/trends', schema: TrendIn,
    handler: async (c) => {
      const t = c.body as z.infer<typeof TrendIn>;
      const src = await one<{ id: string }>("SELECT id FROM trend_sources WHERE workspace_id=$1 AND kind='manual' LIMIT 1", [c.workspaceId]);
      return one(`INSERT INTO trends(workspace_id, source_id, title, platform, url, country, language, published_at, keywords, reason, metrics, reliability, verification_status)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [c.workspaceId, src?.id ?? null, t.title, t.platform, t.url ?? null, t.country ?? null, t.language ?? null, t.published_at || null, t.keywords, t.reason, JSON.stringify(t.metrics), t.reliability, t.verification_status]);
    },
  },
  {
    method: 'PATCH', path: '/trends/:id', schema: z.object({ status: z.enum(['new', 'saved', 'ignored']).optional(), verification_status: z.enum(['unverified', 'verified', 'rejected']).optional() }),
    handler: async (c) => {
      const b = c.body as { status?: string; verification_status?: string };
      const r = await one('UPDATE trends SET status=COALESCE($3,status), verification_status=COALESCE($4,verification_status) WHERE id=$1 AND workspace_id=$2 RETURNING *', [c.params.id, c.workspaceId, b.status ?? null, b.verification_status ?? null]);
      if (!r) throw notFound();
      return r;
    },
  },
  { method: 'DELETE', path: '/trends/:id', handler: async (c) => { await q('DELETE FROM trends WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]); return { ok: true }; } },
  {
    method: 'POST', path: '/trends/:id/analyze', rate: AI_RATE,
    handler: async (c) => {
      const t = await one<{ title: string; platform: string; reason: string }>('SELECT title, platform, reason FROM trends WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!t) throw notFound();
      const r = await A.analyzeTrend({ workspaceId: c.workspaceId, userId: c.user.id }, { title: t.title, platform: t.platform, notes: t.reason });
      await q('UPDATE trends SET analysis=$3, application_hint=$4, relevance_score=$5, is_demo=$6 WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId, r.data.analysis, r.data.application_hint, r.data.relevance_score, r.meta.demo]);
      return { ...r.data, meta: r.meta };
    },
  },
  {
    method: 'POST', path: '/trends/:id/idea', rate: AI_RATE,
    handler: async (c) => {
      const t = await one<{ id: string; title: string; keywords: string[] }>('SELECT id, title, keywords FROM trends WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!t) throw notFound();
      const exclude = (await q<{ title: string }>('SELECT title FROM ideas WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [c.workspaceId])).map((r) => r.title);
      const r = await A.generateIdeas({ workspaceId: c.workspaceId, userId: c.user.id }, { count: 3, trends: [t.title], keywords: t.keywords, exclude });
      const s = await saveIdeas(c.workspaceId, r.data, { source: 'trend', isDemo: r.meta.demo });
      if (s.saved.length) await q('UPDATE ideas SET trend_id=$2 WHERE id = ANY($1)', [s.saved.map((x) => x.id), t.id]);
      return { ...s, meta: r.meta };
    },
  },

  // ---- Viral Decoder (văn bản/transcript người dùng cung cấp; không tự tải video) ----
  {
    method: 'GET', path: '/viral-decodes',
    handler: async (c) => ({ items: await q('SELECT id, title, source_type, source_url, observed_visuals, is_demo, created_at FROM viral_decodes WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [c.workspaceId]) }),
  },
  {
    method: 'GET', path: '/viral-decodes/:id',
    handler: async (c) => { const r = await one('SELECT * FROM viral_decodes WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]); if (!r) throw notFound(); return r; },
  },
  {
    method: 'POST', path: '/viral-decodes', rate: AI_RATE,
    schema: z.object({ title: z.string().min(1).max(200), source_type: z.enum(['url', 'transcript', 'post_text', 'screenshot_note']), source_url: z.string().url().max(500).nullish(), input_text: z.string().min(20, 'Cần dán transcript/nội dung (tối thiểu 20 ký tự)').max(30000), observed_visuals: z.boolean().default(false), confirm_external: z.boolean().default(false) }),
    handler: async (c) => {
      const b = c.body as { title: string; source_type: string; source_url?: string | null; input_text: string; observed_visuals: boolean; confirm_external: boolean };
      const r = await A.decodeViral({ workspaceId: c.workspaceId, userId: c.user.id }, { text: redactPII(b.input_text), sourceType: b.source_type, url: b.source_url ?? undefined, observedVisuals: b.observed_visuals });
      return one('INSERT INTO viral_decodes(workspace_id, title, source_type, source_url, input_text, observed_visuals, result, is_demo, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [c.workspaceId, b.title, b.source_type, b.source_url ?? null, b.input_text, b.observed_visuals, JSON.stringify({ ...r.data, meta: r.meta }), r.meta.demo, c.user.id]);
    },
  },
  {
    method: 'POST', path: '/viral-decodes/:id/ideas',
    handler: async (c) => {
      const d = await one<{ result: { ideas: { title: string; summary: string }[] }; is_demo: boolean }>('SELECT result, is_demo FROM viral_decodes WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!d) throw notFound();
      const batch = { ideas: d.result.ideas.map((i) => ({ title: i.title, summary: i.summary, pillar: '', format: 'post' as const, platform: 'facebook_profile' as const, hook: '', keyword: null, scores: { attraction: 15, brand_fit: 15, retention: 10, conversion: 8, feasibility: 6 }, rationale: 'Điểm mặc định — hãy chấm lại thủ công hoặc dùng AI' })) };
      return saveIdeas(c.workspaceId, batch, { source: 'viral_decode', isDemo: d.is_demo, aiEstimate: false });
    },
  },
];

export { tx, willUseExternal, audit, badRequest };

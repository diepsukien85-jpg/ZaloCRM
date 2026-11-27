import { z } from 'zod';
import { one, q, tx } from '../db';
import { audit } from '../audit';
import { badRequest, conflict, notFound } from '../errors';
import { toCsv } from '../csv';
import { redactPII } from '../ai/safety';
import { willUseExternal } from '../ai/client';
import * as A from '../ai/agents';
import { STATUSES, createContent, editContent, restoreVersion, saveIdeas, transition } from '../services/content';
import { buildAllFlowPrompts } from '../services/flow';
import { contentDisposition } from '../http';
import type { RouteDef } from '../router';

const AI_RATE = { key: 'ai', max: 30 };
const Privacy = z.enum(['private', 'internal', 'public']);

async function defaultBrandId(ws: string) {
  return (await one<{ id: string }>("SELECT id FROM brands WHERE workspace_id=$1 AND is_active ORDER BY (kind='personal') DESC, created_at LIMIT 1", [ws]))?.id ?? null;
}

const JournalIn = z.object({
  title: z.string().max(200).default(''), body: z.string().min(1, 'Nội dung nhật ký đang trống').max(30000), entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source_type: z.enum(['text', 'audio', 'video', 'image', 'chat', 'lesson', 'customer_case']).default('text'), privacy: Privacy.default('private'), tags: z.array(z.string().max(40)).max(20).default([]), media_asset_id: z.string().uuid().nullish(),
});
const IdeaIn = z.object({
  title: z.string().min(3).max(200), summary: z.string().max(1000).default(''), pillar: z.string().max(100).default(''), format: z.enum(['post', 'short_video', 'long_video', 'carousel', 'infographic']).default('post'),
  platform: z.string().max(40).default('facebook_profile'), hook: z.string().max(400).default(''), keyword_id: z.string().uuid().nullish(),
  scores: z.object({ attraction: z.number().min(0).max(25), brand_fit: z.number().min(0).max(25), retention: z.number().min(0).max(20), conversion: z.number().min(0).max(20), feasibility: z.number().min(0).max(10) }).optional(),
});
const ContentIn = z.object({
  title: z.string().min(1).max(300), content_type: z.enum(['post', 'video_script', 'carousel', 'infographic', 'youtube_description']).default('post'), platform: z.string().max(40).default('facebook_profile'),
  pillar: z.string().max(100).default(''), body: z.string().max(60000).default(''), hooks: z.array(z.string().max(500)).max(10).default([]), caption: z.string().max(5000).default(''),
  hashtags: z.array(z.string().max(60)).max(30).default([]), cta: z.string().max(500).default(''), channel_id: z.string().uuid().nullish(), campaign_id: z.string().uuid().nullish(), idea_id: z.string().uuid().nullish(),
  keyword_ids: z.array(z.string().uuid()).max(30).default([]), references_text: z.string().max(5000).default(''), privacy: Privacy.default('internal'),
});
const ContentEdit = ContentIn.partial().extend({ assignee_id: z.string().uuid().nullish(), autosave: z.boolean().optional(), note: z.string().max(300).optional() });

function total(s: { attraction: number; brand_fit: number; retention: number; conversion: number; feasibility: number }) {
  return Math.round(s.attraction + s.brand_fit + s.retention + s.conversion + s.feasibility);
}

export const contentRoutes: RouteDef[] = [
  // ---------- Nhật ký / câu chuyện ----------
  {
    method: 'GET', path: '/journals',
    handler: async (c) => {
      const p: unknown[] = [c.workspaceId]; let w = 'workspace_id=$1';
      const s = c.query.get('q');
      if (s) { p.push(s); w += ` AND (to_tsvector('simple', coalesce(title,'') || ' ' || body) @@ plainto_tsquery('simple', $${p.length}) OR body ILIKE '%' || $${p.length} || '%' OR title ILIKE '%' || $${p.length} || '%')`; }
      if (c.query.get('privacy')) { p.push(c.query.get('privacy')); w += ` AND privacy=$${p.length}`; }
      return { items: await q(`SELECT j.*, (SELECT count(*) FROM stories s WHERE s.journal_id=j.id) AS story_count FROM daily_journals j WHERE ${w} ORDER BY entry_date DESC, created_at DESC LIMIT 200`, p) };
    },
  },
  {
    method: 'POST', path: '/journals', schema: JournalIn,
    handler: async (c) => {
      const b = c.body as z.infer<typeof JournalIn>;
      return one('INSERT INTO daily_journals(workspace_id, brand_id, entry_date, title, body, source_type, privacy, tags, media_asset_id, created_by) VALUES ($1,$2,COALESCE($3::date, current_date),$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [c.workspaceId, await defaultBrandId(c.workspaceId), b.entry_date ?? null, b.title, b.body, b.source_type, b.privacy, b.tags, b.media_asset_id ?? null, c.user.id]);
    },
  },
  {
    method: 'PATCH', path: '/journals/:id', schema: JournalIn.partial(),
    handler: async (c) => {
      const b = c.body as Partial<z.infer<typeof JournalIn>>;
      const r = await one('UPDATE daily_journals SET title=COALESCE($3,title), body=COALESCE($4,body), privacy=COALESCE($5,privacy), tags=COALESCE($6,tags) WHERE id=$1 AND workspace_id=$2 RETURNING *', [c.params.id, c.workspaceId, b.title ?? null, b.body ?? null, b.privacy ?? null, b.tags ?? null]);
      if (!r) throw notFound();
      return r;
    },
  },
  { method: 'DELETE', path: '/journals/:id', handler: async (c) => { await q('DELETE FROM daily_journals WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]); await audit(c.workspaceId, c.user.id, 'journal.delete', 'journal', c.params.id); return { ok: true }; } },
  {
    // Storytelling Agent. Nhật ký "private" chỉ được gửi ra dịch vụ AI ngoài khi người dùng xác nhận.
    method: 'POST', path: '/journals/:id/extract', rate: AI_RATE, schema: z.object({ confirm_external: z.boolean().default(false) }),
    handler: async (c) => {
      const j = await one<{ id: string; title: string; body: string; privacy: string; brand_id: string | null }>('SELECT id, title, body, privacy, brand_id FROM daily_journals WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!j) throw notFound();
      if (j.privacy === 'private' && !(c.body as { confirm_external: boolean }).confirm_external && (await willUseExternal(c.workspaceId))) {
        throw conflict('Nhật ký này đánh dấu RIÊNG TƯ. Cần xác nhận trước khi gửi (đã ẩn SĐT/email) tới dịch vụ AI bên ngoài.');
      }
      const r = await A.extractStory({ workspaceId: c.workspaceId, userId: c.user.id, brandId: j.brand_id }, { text: `${j.title}\n${j.body}` });
      const d = r.data;
      const story = await one('INSERT INTO stories(workspace_id, journal_id, brand_id, title, extracted, lessons, suggestions, privacy, is_demo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [c.workspaceId, j.id, j.brand_id, d.title, JSON.stringify({ characters: d.characters, setting: d.setting, problem: d.problem, conflict: d.conflict, decision: d.decision, action: d.action, result: d.result, lesson: d.lesson, emotion: d.emotion, viewer_value: d.viewer_value, not_stated: d.not_stated }), d.lessons,
          JSON.stringify({ broad_keywords: d.broad_keywords, ideas: d.ideas, hooks: d.hooks, facebook_post: d.facebook_post, short_video_idea: d.short_video_idea }), j.privacy, r.meta.demo]);
      return { story, meta: r.meta };
    },
  },
  {
    method: 'GET', path: '/stories',
    handler: async (c) => ({ items: await q('SELECT * FROM stories WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 200', [c.workspaceId]) }),
  },
  { method: 'DELETE', path: '/stories/:id', handler: async (c) => { await q('DELETE FROM stories WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]); return { ok: true }; } },
  {
    // Lưu 5 ý tưởng gợi ý từ câu chuyện vào Ngân hàng ý tưởng
    method: 'POST', path: '/stories/:id/ideas',
    handler: async (c) => {
      const s = await one<{ suggestions: { ideas: { title: string; summary: string }[]; hooks: string[] }; brand_id: string | null; is_demo: boolean }>('SELECT suggestions, brand_id, is_demo FROM stories WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!s) throw notFound();
      const batch = { ideas: s.suggestions.ideas.map((i) => ({ title: i.title, summary: i.summary, pillar: '', format: 'post' as const, platform: 'facebook_profile' as const, hook: s.suggestions.hooks[0] ?? '', keyword: null, scores: { attraction: 15, brand_fit: 15, retention: 10, conversion: 8, feasibility: 7 }, rationale: 'Điểm mặc định — hãy chấm lại' })) };
      const r = await saveIdeas(c.workspaceId, batch, { brandId: s.brand_id, source: 'story', isDemo: s.is_demo, aiEstimate: false });
      if (r.saved.length) await q('UPDATE ideas SET story_id=$2 WHERE id = ANY($1)', [r.saved.map((x) => x.id), c.params.id]);
      return r;
    },
  },

  // ---------- Ngân hàng ý tưởng ----------
  {
    method: 'GET', path: '/ideas',
    handler: async (c) => {
      const p: unknown[] = [c.workspaceId]; let w = 'i.workspace_id=$1';
      for (const f of ['status', 'pillar', 'format']) { const v = c.query.get(f); if (v) { p.push(v); w += ` AND i.${f}=$${p.length}`; } }
      const s = c.query.get('q'); if (s) { p.push(`%${s}%`); w += ` AND i.title ILIKE $${p.length}`; }
      return { items: await q(`SELECT i.*, s.attraction, s.brand_fit, s.retention, s.conversion, s.feasibility, s.rationale, s.is_ai_estimate FROM ideas i LEFT JOIN idea_scores s ON s.idea_id=i.id WHERE ${w} ORDER BY i.created_at DESC, i.total_score DESC NULLS LAST LIMIT 300`, p) };
    },
  },
  {
    method: 'POST', path: '/ideas', schema: IdeaIn,
    handler: async (c) => {
      const b = c.body as z.infer<typeof IdeaIn>;
      const res = await saveIdeas(c.workspaceId, { ideas: [{ title: b.title, summary: b.summary, pillar: b.pillar, format: b.format, platform: b.platform as 'facebook_profile', hook: b.hook, keyword: null, scores: b.scores ?? { attraction: 0, brand_fit: 0, retention: 0, conversion: 0, feasibility: 0 }, rationale: b.scores ? 'Chấm thủ công' : 'Chưa chấm điểm' }] }, { brandId: await defaultBrandId(c.workspaceId), source: 'manual', isDemo: false, aiEstimate: false });
      if (!res.saved.length) throw conflict(`Ý tưởng trùng với "${res.duplicates[0]?.of}" (độ giống ${Math.round((res.duplicates[0]?.similarity ?? 0) * 100)}%)`);
      return res.saved[0];
    },
  },
  {
    method: 'PATCH', path: '/ideas/:id', schema: z.object({ status: z.enum(['new', 'selected', 'in_production', 'rejected', 'archived']).optional(), title: z.string().min(3).max(200).optional(), summary: z.string().max(1000).optional(), pillar: z.string().max(100).optional(), hook: z.string().max(400).optional() }),
    handler: async (c) => {
      const b = c.body as Record<string, string | undefined>;
      const r = await one('UPDATE ideas SET status=COALESCE($3,status), title=COALESCE($4,title), summary=COALESCE($5,summary), pillar=COALESCE($6,pillar), hook=COALESCE($7,hook) WHERE id=$1 AND workspace_id=$2 RETURNING *', [c.params.id, c.workspaceId, b.status ?? null, b.title ?? null, b.summary ?? null, b.pillar ?? null, b.hook ?? null]);
      if (!r) throw notFound();
      return r;
    },
  },
  {
    method: 'PUT', path: '/ideas/:id/score',
    schema: z.object({ attraction: z.number().min(0).max(25), brand_fit: z.number().min(0).max(25), retention: z.number().min(0).max(20), conversion: z.number().min(0).max(20), feasibility: z.number().min(0).max(10), rationale: z.string().max(800).default('') }),
    handler: async (c) => {
      const s = c.body as { attraction: number; brand_fit: number; retention: number; conversion: number; feasibility: number; rationale: string };
      const t = total(s);
      await tx(async (cl) => {
        if (!(await cl.query('SELECT 1 FROM ideas WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId])).rowCount) throw notFound();
        await cl.query(`INSERT INTO idea_scores(workspace_id, idea_id, attraction, brand_fit, retention, conversion, feasibility, total, rationale, is_ai_estimate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false)
          ON CONFLICT (idea_id) DO UPDATE SET attraction=EXCLUDED.attraction, brand_fit=EXCLUDED.brand_fit, retention=EXCLUDED.retention, conversion=EXCLUDED.conversion, feasibility=EXCLUDED.feasibility, total=EXCLUDED.total, rationale=EXCLUDED.rationale, is_ai_estimate=false`,
          [c.workspaceId, c.params.id, Math.round(s.attraction), Math.round(s.brand_fit), Math.round(s.retention), Math.round(s.conversion), Math.round(s.feasibility), t, s.rationale]);
        await cl.query('UPDATE ideas SET total_score=$3 WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId, t]);
      });
      return { total: t };
    },
  },
  { method: 'DELETE', path: '/ideas/:id', handler: async (c) => { await q('DELETE FROM ideas WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]); return { ok: true }; } },
  {
    method: 'POST', path: '/ideas/generate', rate: AI_RATE, schema: z.object({ count: z.number().int().min(1).max(30).default(10) }),
    handler: async (c) => {
      const brandId = await defaultBrandId(c.workspaceId);
      const exclude = (await q<{ title: string }>('SELECT title FROM ideas WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [c.workspaceId])).map((r) => r.title);
      const kws = (await q<{ keyword: string }>('SELECT keyword FROM keywords WHERE workspace_id=$1 ORDER BY favorite DESC, content_potential_score DESC NULLS LAST LIMIT 30', [c.workspaceId])).map((k) => k.keyword);
      const jr = (await q<{ title: string; body: string }>("SELECT title, body FROM daily_journals WHERE workspace_id=$1 AND privacy <> 'private' ORDER BY entry_date DESC LIMIT 5", [c.workspaceId])).map((j) => `${j.title}: ${j.body}`);
      const r = await A.generateIdeas({ workspaceId: c.workspaceId, userId: c.user.id, brandId }, { count: (c.body as { count: number }).count, keywords: kws, journals: jr, exclude });
      const s = await saveIdeas(c.workspaceId, r.data, { brandId, source: r.meta.demo ? 'demo' : 'ai', isDemo: r.meta.demo });
      return { ...s, meta: r.meta };
    },
  },
  {
    // Biến ý tưởng thành bài viết hoặc kịch bản video (AI)
    method: 'POST', path: '/ideas/:id/produce', rate: AI_RATE, schema: z.object({ type: z.enum(['post', 'video']), duration_sec: z.number().int().min(15).max(1800).default(30) }),
    handler: async (c) => {
      const b = c.body as { type: 'post' | 'video'; duration_sec: number };
      const idea = await one<{ id: string; title: string; summary: string; pillar: string; platform: string; hook: string; brand_id: string | null; story_id: string | null }>('SELECT * FROM ideas WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!idea) throw notFound();
      const story = idea.story_id ? await one<{ extracted: Record<string, string> }>('SELECT extracted FROM stories WHERE id=$1 AND workspace_id=$2', [idea.story_id, c.workspaceId]) : null;
      const ctx = { workspaceId: c.workspaceId, userId: c.user.id, brandId: idea.brand_id };
      const storyContext = story ? Object.entries(story.extracted).filter(([, v]) => typeof v === 'string' && v).map(([k, v]) => `${k}: ${v}`).join('\n') : undefined;
      let content;
      if (b.type === 'post') {
        const r = await A.writePost(ctx, { title: idea.title, summary: idea.summary, pillar: idea.pillar, platform: idea.platform, hook: idea.hook, storyContext });
        content = await createContent(c.workspaceId, c.user.id, { brand_id: idea.brand_id, idea_id: idea.id, story_id: idea.story_id, title: r.data.title, platform: idea.platform, pillar: idea.pillar, body: r.data.body, hooks: r.data.hooks, caption: r.data.caption, hashtags: r.data.hashtags, cta: r.data.cta, ai_generated: true, is_demo: r.meta.demo });
      } else {
        const r = await A.writeScript(ctx, { title: idea.title, summary: idea.summary, pillar: idea.pillar, durationSec: b.duration_sec, storyContext });
        content = await createVideoFromScript(c.workspaceId, c.user.id, idea, r.data, r.meta.demo, b.duration_sec);
      }
      await q("UPDATE ideas SET status='in_production' WHERE id=$1", [idea.id]);
      return content;
    },
  },

  // ---------- Content Factory ----------
  {
    method: 'GET', path: '/contents',
    handler: async (c) => {
      const p: unknown[] = [c.workspaceId]; const w = ['c.workspace_id=$1'];
      for (const f of ['status', 'platform', 'content_type', 'pillar', 'channel_id', 'brand_id']) { const v = c.query.get(f); if (v) { p.push(v); w.push(`c.${f}=$${p.length}`); } }
      if (c.query.get('originals') === 'true') w.push('c.parent_content_id IS NULL');
      const s = c.query.get('q'); if (s) { p.push(`%${s}%`); w.push(`(c.title ILIKE $${p.length} OR c.body ILIKE $${p.length})`); }
      return { items: await q(`SELECT c.id, c.title, c.content_type, c.platform, c.pillar, c.status, c.scheduled_at, c.published_at, c.channel_id, ch.name AS channel_name, c.assignee_id, u.name AS assignee_name, c.is_demo, c.ai_generated, c.parent_content_id, c.updated_at, c.created_at, c.current_version,
        (SELECT count(*) FROM content_variants v WHERE v.content_id=c.id) AS variant_count
        FROM contents c LEFT JOIN channels ch ON ch.id=c.channel_id LEFT JOIN users u ON u.id=c.assignee_id WHERE ${w.join(' AND ')} ORDER BY c.updated_at DESC LIMIT 500`, p) };
    },
  },
  {
    method: 'POST', path: '/contents', schema: ContentIn,
    handler: async (c) => createContent(c.workspaceId, c.user.id, { ...(c.body as z.infer<typeof ContentIn>), brand_id: await defaultBrandId(c.workspaceId), status: 'draft' }),
  },
  {
    method: 'GET', path: '/contents/export.csv',
    handler: async (c) => {
      const rows = await q(`SELECT c.title, c.content_type, c.platform, c.pillar, c.status, c.scheduled_at, c.published_at, array_to_string(c.hooks, ' | ') AS hooks, c.caption, array_to_string(c.hashtags,' ') AS hashtags, c.cta, c.body FROM contents c WHERE c.workspace_id=$1 AND c.parent_content_id IS NULL ORDER BY c.created_at DESC`, [c.workspaceId]);
      return new Response(toCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="contents.csv"' } });
    },
  },
  {
    method: 'GET', path: '/contents/:id',
    handler: async (c) => {
      const content = await one('SELECT c.*, ch.name AS channel_name FROM contents c LEFT JOIN channels ch ON ch.id=c.channel_id WHERE c.id=$1 AND c.workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!content) throw notFound();
      return {
        content,
        versions: await q('SELECT v.version, v.title, v.body, v.hooks, v.caption, v.change_note, v.source, v.created_at, u.name AS author FROM content_versions v LEFT JOIN users u ON u.id=v.created_by WHERE v.content_id=$1 AND v.workspace_id=$2 ORDER BY v.version DESC', [c.params.id, c.workspaceId]),
        variants: await q('SELECT * FROM content_variants WHERE content_id=$1 AND workspace_id=$2 ORDER BY platform', [c.params.id, c.workspaceId]),
        approvals: await q('SELECT a.action, a.note, a.created_at, u.name AS actor FROM content_approvals a LEFT JOIN users u ON u.id=a.actor_id WHERE a.content_id=$1 AND a.workspace_id=$2 ORDER BY a.created_at DESC', [c.params.id, c.workspaceId]),
        video_project: await one('SELECT id, title FROM video_projects WHERE content_id=$1 AND workspace_id=$2 LIMIT 1', [c.params.id, c.workspaceId]),
        statuses: STATUSES,
      };
    },
  },
  {
    method: 'PATCH', path: '/contents/:id', schema: ContentEdit,
    handler: async (c) => {
      const { autosave, note, ...rest } = c.body as z.infer<typeof ContentEdit>;
      return editContent(c.workspaceId, c.user.id, c.params.id, rest, { source: autosave ? 'autosave' : 'manual', note });
    },
  },
  {
    method: 'POST', path: '/contents/:id/transition',
    schema: z.object({ to: z.enum(STATUSES), note: z.string().max(1000).optional(), scheduled_at: z.string().nullish(), channel_id: z.string().uuid().nullish(), confirm: z.boolean().optional(), external_url: z.string().url().nullish() }),
    handler: async (c) => transition(c.workspaceId, c.user.id, c.role, c.params.id, c.body as Parameters<typeof transition>[4]),
  },
  { method: 'POST', path: '/contents/:id/restore', schema: z.object({ version: z.number().int().min(1) }), handler: async (c) => restoreVersion(c.workspaceId, c.user.id, c.params.id, (c.body as { version: number }).version) },
  {
    method: 'DELETE', path: '/contents/:id', min: 'admin', schema: undefined,
    handler: async (c) => {
      const r = await one<{ status: string }>('SELECT status FROM contents WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!r) throw notFound();
      if (r.status !== 'archived' && r.status !== 'draft') throw badRequest('Chỉ xoá nội dung ở trạng thái Bản nháp hoặc Lưu trữ');
      await q('DELETE FROM contents WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      await audit(c.workspaceId, c.user.id, 'content.delete', 'content', c.params.id);
      return { ok: true };
    },
  },
  {
    // AI rewrite: rút gọn / mở rộng / đổi hook / đổi giọng / thêm CTA. Chỉ trả đề xuất — người dùng bấm áp dụng.
    method: 'POST', path: '/contents/:id/rewrite', rate: AI_RATE, schema: z.object({ instruction: z.string().min(2).max(500), text: z.string().max(60000).optional() }),
    handler: async (c) => {
      const b = c.body as { instruction: string; text?: string };
      const cur = await one<{ body: string; brand_id: string | null }>('SELECT body, brand_id FROM contents WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!cur) throw notFound();
      const r = await A.rewriteText({ workspaceId: c.workspaceId, userId: c.user.id, brandId: cur.brand_id }, { instruction: b.instruction, text: b.text ?? cur.body });
      return { ...r.data, meta: r.meta };
    },
  },
  {
    method: 'POST', path: '/contents/:id/variants', rate: AI_RATE, schema: z.object({ platforms: z.array(z.enum(['facebook_profile', 'facebook_page', 'facebook_reels', 'tiktok', 'youtube_shorts', 'youtube_long'])).min(1).max(6) }),
    handler: async (c) => {
      const cur = await one<{ title: string; body: string; hooks: string[]; hashtags: string[]; cta: string; brand_id: string | null }>('SELECT title, body, hooks, hashtags, cta, brand_id FROM contents WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!cur) throw notFound();
      const r = await A.makeVariants({ workspaceId: c.workspaceId, userId: c.user.id, brandId: cur.brand_id }, { title: cur.title, body: cur.body, hook: cur.hooks[0] ?? '', hashtags: cur.hashtags, cta: cur.cta, platforms: (c.body as { platforms: string[] }).platforms });
      for (const v of r.data.variants) {
        await q(`INSERT INTO content_variants(workspace_id, content_id, platform, title, hook, caption, hashtags, aspect_ratio, duration_sec, cta, body, is_demo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (content_id, platform) DO UPDATE SET title=EXCLUDED.title, hook=EXCLUDED.hook, caption=EXCLUDED.caption, hashtags=EXCLUDED.hashtags, aspect_ratio=EXCLUDED.aspect_ratio, duration_sec=EXCLUDED.duration_sec, cta=EXCLUDED.cta, body=EXCLUDED.body, is_demo=EXCLUDED.is_demo`,
          [c.workspaceId, c.params.id, v.platform, v.title, v.hook, v.caption, v.hashtags, v.aspect_ratio, v.duration_sec ?? null, v.cta, v.body, r.meta.demo]);
      }
      return { count: r.data.variants.length, meta: r.meta };
    },
  },
  {
    method: 'PATCH', path: '/contents/:id/variants/:platform',
    schema: z.object({ title: z.string().max(300).optional(), hook: z.string().max(500).optional(), caption: z.string().max(5000).optional(), hashtags: z.array(z.string().max(60)).max(30).optional(), cta: z.string().max(500).optional(), body: z.string().max(60000).optional() }),
    handler: async (c) => {
      const b = c.body as Record<string, unknown>;
      const r = await one('UPDATE content_variants SET title=COALESCE($4,title), hook=COALESCE($5,hook), caption=COALESCE($6,caption), hashtags=COALESCE($7,hashtags), cta=COALESCE($8,cta), body=COALESCE($9,body) WHERE content_id=$1 AND platform=$2 AND workspace_id=$3 RETURNING *',
        [c.params.id, c.params.platform, c.workspaceId, b.title ?? null, b.hook ?? null, b.caption ?? null, b.hashtags ?? null, b.cta ?? null, b.body ?? null]);
      if (!r) throw notFound();
      return r;
    },
  },
  {
    // Chuyển bài viết → kịch bản video; video → bài viết; bài viết → carousel (nội dung mới có parent để không đếm KPI trùng nếu là biến thể)
    method: 'POST', path: '/contents/:id/convert', rate: AI_RATE, schema: z.object({ to: z.enum(['video', 'post', 'carousel']), duration_sec: z.number().int().min(15).max(1800).default(30) }),
    handler: async (c) => {
      const b = c.body as { to: 'video' | 'post' | 'carousel'; duration_sec: number };
      const src = await one<{ id: string; title: string; body: string; pillar: string; platform: string; brand_id: string | null; idea_id: string | null; story_id: string | null; hooks: string[] }>('SELECT * FROM contents WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!src) throw notFound();
      const ctx = { workspaceId: c.workspaceId, userId: c.user.id, brandId: src.brand_id };
      if (b.to === 'video') {
        const r = await A.writeScript(ctx, { title: src.title, summary: src.body.slice(0, 1500), pillar: src.pillar, durationSec: b.duration_sec });
        return createVideoFromScript(c.workspaceId, c.user.id, { id: src.idea_id ?? '', title: src.title, pillar: src.pillar, brand_id: src.brand_id, story_id: src.story_id }, r.data, r.meta.demo, b.duration_sec, src.id);
      }
      const r = await A.writePost(ctx, { title: src.title, summary: src.body.slice(0, 2500), pillar: src.pillar, platform: src.platform, style: b.to === 'carousel' ? 'carousel: mỗi slide 1 ý, đánh số slide' : 'bài viết từ video' });
      return createContent(c.workspaceId, c.user.id, { brand_id: src.brand_id, idea_id: src.idea_id, parent_content_id: null, title: r.data.title, content_type: b.to === 'carousel' ? 'carousel' : 'post', platform: src.platform, pillar: src.pillar, body: r.data.body, hooks: r.data.hooks, caption: r.data.caption, hashtags: r.data.hashtags, cta: r.data.cta, ai_generated: true, is_demo: r.meta.demo, metadata: { converted_from: src.id } });
    },
  },
  {
    method: 'GET', path: '/contents/:id/export.md',
    handler: async (c) => {
      const x = await one<{ title: string; body: string; hooks: string[]; caption: string; hashtags: string[]; cta: string; platform: string; status: string }>('SELECT * FROM contents WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!x) throw notFound();
      const md = `# ${x.title}\n\n*Nền tảng: ${x.platform} · Trạng thái: ${x.status}*\n\n## Hook\n${x.hooks.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n\n## Nội dung\n${x.body}\n\n## Caption\n${x.caption}\n\n## Hashtag\n${x.hashtags.join(' ')}\n\n## CTA\n${x.cta}\n`;
      return new Response(md, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': contentDisposition(`noi-dung-${x.title.slice(0, 30).replace(/[^\p{L}\p{N}]+/gu, '-')}.md`) } });
    },
  },
];

type IdeaLike = { id: string; title: string; pillar: string; brand_id: string | null; story_id: string | null };
export async function createVideoFromScript(ws: string, userId: string, idea: IdeaLike, sc: import('../ai/schemas').VideoScriptT, demo: boolean, dur: number, parent?: string) {
  const body = `HOOK: ${sc.hooks[0]}\n\n` + sc.scenes.map((x) => `Cảnh ${x.scene_no} (${x.duration_sec}s): ${x.shot_description}\nThoại: ${x.dialogue}`).join('\n\n') + `\n\nCTA: ${sc.cta}`;
  const content = await createContent(ws, userId, { brand_id: idea.brand_id, idea_id: idea.id || null, story_id: idea.story_id, parent_content_id: null, title: sc.title, content_type: 'video_script', format: `video_${dur}s`, platform: dur > 120 ? 'youtube_long' : 'facebook_reels', pillar: idea.pillar, body, hooks: sc.hooks, caption: sc.caption, hashtags: sc.hashtags, cta: sc.cta, ai_generated: true, is_demo: demo, metadata: { duration_sec: dur, ...(parent ? { converted_from: parent } : {}), youtube: sc.youtube ?? null } });
  const proj = await one<{ id: string }>("INSERT INTO video_projects(workspace_id, brand_id, content_id, title, duration_sec, aspect_ratio, status, script, is_demo) VALUES ($1,$2,$3,$4,$5,$6,'scripted',$7,$8) RETURNING id", [ws, idea.brand_id, content.id, sc.title, dur, dur > 120 ? '16:9' : '9:16', JSON.stringify(sc), demo]);
  const prompts = buildAllFlowPrompts(sc.scenes, { character: null, aspectRatio: dur > 120 ? '16:9' : '9:16', projectTitle: sc.title });
  for (const s of sc.scenes) {
    await q(`INSERT INTO video_scenes(workspace_id, project_id, scene_no, duration_sec, shot_description, dialogue, voiceover, camera, lighting, audio, on_screen_text, environment, outfit, prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [ws, proj!.id, s.scene_no, s.duration_sec, s.shot_description, s.dialogue, s.voiceover, s.camera, s.lighting, s.audio, s.on_screen_text, s.environment, s.outfit, prompts.find((p) => p.scene_no === s.scene_no)?.prompt ?? '']);
  }
  return { ...content, video_project_id: proj!.id };
}

export { redactPII };

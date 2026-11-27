import { one, q } from '../db';
import { HttpError, conflict, notFound } from '../errors';
import { audit } from '../audit';
import { loadBrandCtx } from '../ai/context';
import * as A from '../ai/agents';
import { buildAllFlowPrompts } from './flow';
import { createContent, saveIdeas, selectIdeas } from './content';
import { totals, groupBy, topContent, defaultRange } from './analytics';
import type { AgentCtx } from '../ai/agents';

export type WorkflowKey = 'daily' | 'weekly' | 'monthly';
type StepDef = { key: string; name: string };
type State = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const vnToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

export async function startWorkflow(workspaceId: string, userId: string | null, key: WorkflowKey, o: { trigger?: 'manual' | 'schedule'; idempotencyKey?: string | null; budgetUsd?: number | null; input?: Record<string, unknown>; attempt?: number } = {}) {
  const def = await one<{ steps: string[]; implemented: boolean }>('SELECT steps, implemented FROM workflow_definitions WHERE workspace_id=$1 AND key=$2', [workspaceId, key]);
  if (!def) throw notFound('Workflow không tồn tại');
  if (!def.implemented) throw new HttpError(501, 'Workflow chưa được triển khai', 'not_implemented');
  const running = await one("SELECT id FROM workflow_runs WHERE workspace_id=$1 AND workflow_key=$2 AND status IN ('queued','running') AND created_at > now() - interval '30 minutes'", [workspaceId, key]);
  if (running) throw conflict('Workflow này đang chạy — hãy chờ hoặc huỷ lần chạy hiện tại');
  const sched = await one<{ budget_limit_usd: number | null }>('SELECT budget_limit_usd FROM automation_schedules WHERE workspace_id=$1 AND workflow_key=$2', [workspaceId, key]);
  let run;
  try {
    run = await one<{ id: string }>(
      `INSERT INTO workflow_runs(workspace_id, workflow_key, trigger, idempotency_key, input, budget_limit_usd, triggered_by, attempt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [workspaceId, key, o.trigger ?? 'manual', o.idempotencyKey ?? null, JSON.stringify(o.input ?? {}), o.budgetUsd ?? sched?.budget_limit_usd ?? null, userId, o.attempt ?? 1]);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw conflict('Lần chạy với khoá idempotency này đã tồn tại');
    throw e;
  }
  const steps = def.steps.map((name, i) => ({ key: `s${i + 1}`, name }));
  for (const [i, s] of steps.entries()) await q('INSERT INTO workflow_steps(workspace_id, run_id, step_no, key, name) VALUES ($1,$2,$3,$4,$5)', [workspaceId, run!.id, i + 1, s.key, s.name]);
  await audit(workspaceId, userId, 'workflow.start', 'workflow_run', run!.id, { key, trigger: o.trigger ?? 'manual' });
  return run!.id;
}

class Cancelled extends Error {}

export async function executeRun(runId: string) {
  const run = await one<{ id: string; workspace_id: string; workflow_key: WorkflowKey; triggered_by: string | null; budget_limit_usd: number | null; input: Record<string, unknown> }>('SELECT * FROM workflow_runs WHERE id=$1', [runId]);
  if (!run) return;
  const ws = run.workspace_id;
  await q("UPDATE workflow_runs SET status='running', started_at=now() WHERE id=$1 AND status='queued'", [runId]);
  const ctx: AgentCtx = {
    workspaceId: ws, userId: run.triggered_by, workflowRunId: runId, runLimitUsd: run.budget_limit_usd,
    signal: async () => { const r = await one<{ c: boolean }>('SELECT cancel_requested AS c FROM workflow_runs WHERE id=$1', [runId]); if (r?.c) throw new Cancelled(); },
  };
  const impl = run.workflow_key === 'daily' ? dailySteps : reviewSteps(run.workflow_key as 'weekly' | 'monthly');
  const state: State = { input: run.input };
  const steps = await q<{ id: string; step_no: number; name: string }>('SELECT id, step_no, name FROM workflow_steps WHERE run_id=$1 ORDER BY step_no', [runId]);
  let failed: string | null = null, cancelled = false;
  for (const st of steps) {
    const fn = impl[st.step_no - 1];
    if (failed || cancelled) { await q("UPDATE workflow_steps SET status='skipped' WHERE id=$1", [st.id]); continue; }
    const t0 = Date.now();
    await q("UPDATE workflow_steps SET status='running', started_at=now() WHERE id=$1", [st.id]);
    try {
      await ctx.signal!();
      const out = await fn(ctx, state);
      await q("UPDATE workflow_steps SET status='succeeded', finished_at=now(), duration_ms=$2, output_summary=$3 WHERE id=$1", [st.id, Date.now() - t0, JSON.stringify(out ?? {})]);
    } catch (e) {
      if (e instanceof Cancelled) { cancelled = true; await q("UPDATE workflow_steps SET status='skipped', finished_at=now() WHERE id=$1", [st.id]); continue; }
      failed = (e as Error).message;
      await q("UPDATE workflow_steps SET status='failed', finished_at=now(), duration_ms=$2, error=$3 WHERE id=$1", [st.id, Date.now() - t0, failed]);
    }
  }
  const status = cancelled ? 'cancelled' : failed ? 'failed' : 'succeeded';
  await q('UPDATE workflow_runs SET status=$2, finished_at=now(), error=$3, result=$4, is_demo=$5 WHERE id=$1', [runId, status, failed, JSON.stringify(state.result ?? {}), !!state.demo]);
  if (status !== 'cancelled') {
    await q('INSERT INTO notifications(workspace_id, user_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5,$6)', [ws, run.triggered_by, status === 'succeeded' ? 'workflow_done' : 'workflow_failed',
      status === 'succeeded' ? `Workflow ${run.workflow_key} hoàn tất${state.demo ? ' (DEMO)' : ''}` : `Workflow ${run.workflow_key} thất bại`, failed ?? (state.summary ?? ''), status === 'succeeded' && run.workflow_key === 'daily' ? '/content' : '/agents']);
  }
}

export async function cancelRun(workspaceId: string, runId: string) {
  const r = await one<{ status: string }>('SELECT status FROM workflow_runs WHERE id=$1 AND workspace_id=$2', [runId, workspaceId]);
  if (!r) throw notFound();
  if (!['queued', 'running'].includes(r.status)) throw conflict('Lần chạy đã kết thúc');
  await q('UPDATE workflow_runs SET cancel_requested=true WHERE id=$1', [runId]);
  if (r.status === 'queued') await q("UPDATE workflow_runs SET status='cancelled', finished_at=now() WHERE id=$1", [runId]);
}

type StepFn = (ctx: AgentCtx, s: State) => Promise<Record<string, unknown> | void>;

const POST_FORMATS = ['post', 'carousel', 'infographic'];

const dailySteps: StepFn[] = [
  // 1. Đọc DNA
  async (ctx, s) => {
    const brand = await loadBrandCtx(ctx.workspaceId, null);
    if (!brand) throw new Error('Chưa có thương hiệu/DNA — hãy tạo ở "DNA thương hiệu"');
    s.brand = brand; ctx.brandId = brand.id;
    return { brand: brand.name, pillars: brand.pillars.length };
  },
  // 2. Lịch sử nội dung
  async (ctx, s) => {
    s.exclude = (await q<{ title: string }>('SELECT title FROM ideas WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [ctx.workspaceId])).map((r) => r.title)
      .concat((await q<{ title: string }>("SELECT title FROM contents WHERE workspace_id=$1 AND parent_content_id IS NULL ORDER BY created_at DESC LIMIT 100", [ctx.workspaceId])).map((r) => r.title));
    return { previous_titles: s.exclude.length };
  },
  // 3. Nhật ký (bỏ mục "private": không gửi dữ liệu riêng tư ra ngoài khi chưa được cho phép)
  async (ctx, s) => {
    const rows = await q<{ title: string; body: string }>("SELECT title, body FROM daily_journals WHERE workspace_id=$1 AND privacy <> 'private' AND entry_date > current_date - 7 ORDER BY entry_date DESC LIMIT 10", [ctx.workspaceId]);
    s.journals = rows.map((r) => `${r.title}: ${r.body}`);
    return { journals_used: rows.length, note: 'Nhật ký đánh dấu riêng tư được loại khỏi ngữ cảnh AI' };
  },
  // 4. Xu hướng đã lưu (nguồn được phép / nhập thủ công)
  async (ctx, s) => {
    const rows = await q<{ title: string; reason: string }>("SELECT title, reason FROM trends WHERE workspace_id=$1 AND status='saved' ORDER BY collected_at DESC LIMIT 10", [ctx.workspaceId]);
    s.trends = rows.map((r) => `${r.title}${r.reason ? ' – ' + r.reason : ''}`);
    return { saved_trends: rows.length, auto_crawl: 'Không tự thu thập: chỉ dùng xu hướng người dùng đã lưu' };
  },
  // 5. Mở rộng từ khoá
  async (ctx, s) => {
    const roots = await q<{ keyword: string }>("SELECT keyword FROM keywords WHERE workspace_id=$1 AND tier=1 AND parent_keyword_id IS NULL ORDER BY favorite DESC, updated_at ASC LIMIT 3", [ctx.workspaceId]);
    const r = await A.expandKeywords(ctx, { roots: roots.map((x) => x.keyword), count: 20 });
    let added = 0;
    const idByKw = new Map<string, string>();
    for (const k of r.data.keywords) {
      const parent = k.parent ? (await one<{ id: string }>('SELECT id FROM keywords WHERE workspace_id=$1 AND lower(keyword)=lower($2) LIMIT 1', [ctx.workspaceId, k.parent])) : null;
      const ins = await one<{ id: string }>(
        `INSERT INTO keywords(workspace_id, brand_id, keyword, parent_keyword_id, language, category, search_intent, audience, funnel_stage, tier, relevance_score, content_potential_score, source, is_demo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING RETURNING id`,
        [ctx.workspaceId, ctx.brandId, k.keyword, parent?.id ?? idByKw.get((k.parent ?? '').toLowerCase()) ?? null, k.language, k.category, k.search_intent, k.audience, k.funnel_stage, k.tier, k.relevance_score, k.content_potential_score, r.meta.demo ? 'demo' : 'ai', r.meta.demo]);
      if (ins) { added++; idByKw.set(k.keyword.toLowerCase(), ins.id); }
    }
    s.keywords = r.data.keywords.map((k) => k.keyword);
    if (r.meta.demo) s.demo = true;
    return { roots: roots.map((x) => x.keyword), new_keywords: added, provider: r.meta.provider };
  },
  // 6. Tạo 10 ý tưởng
  async (ctx, s) => {
    const r = await A.generateIdeas(ctx, { count: 10, keywords: s.keywords, journals: s.journals, trends: s.trends, exclude: s.exclude });
    s.ideaBatch = r.data; s.demo = s.demo || r.meta.demo; s.ideaMeta = r.meta;
    return { generated: r.data.ideas.length, provider: r.meta.provider, cache_hit: r.meta.cacheHit };
  },
  // 7. Chấm điểm & chống trùng (điểm là ƯỚC TÍNH của AI)
  async (ctx, s) => {
    const r = await saveIdeas(ctx.workspaceId, s.ideaBatch, { brandId: ctx.brandId, source: s.demo ? 'demo' : 'ai', workflowRunId: ctx.workflowRunId, isDemo: !!s.demo });
    s.savedIdeas = r.saved;
    const rows = await q<{ id: string; title: string; total_score: number; pillar: string; format: string; summary: string; hook: string; platform: string }>('SELECT id, title, total_score, pillar, format, summary, hook, platform FROM ideas WHERE id = ANY($1)', [r.saved.map((x) => x.id)]);
    s.ideas = rows.map((x) => ({ ...x, total: x.total_score }));
    return { saved: r.saved.length, duplicates_skipped: r.duplicates, note: 'Điểm là đánh giá dự kiến của AI, không phải cam kết lượt xem' };
  },
  // 8. Chọn 5 ý tưởng: 3 bài + 2 video
  async (ctx, s) => {
    const pillars = s.brand.pillars;
    const posts = s.ideas.filter((i: { format: string }) => POST_FORMATS.includes(i.format));
    const vids = s.ideas.filter((i: { format: string }) => !POST_FORMATS.includes(i.format));
    type IdeaRow = { id: string; total: number; pillar: string; title: string; summary: string; hook: string; platform: string; format: string };
    let selPosts: IdeaRow[] = selectIdeas<IdeaRow>(posts, 3, pillars), selVids: IdeaRow[] = selectIdeas<IdeaRow>(vids, 2, pillars);
    const rest = s.ideas.filter((i: unknown) => !selPosts.includes(i as never) && !selVids.includes(i as never)).sort((a: { total: number }, b: { total: number }) => b.total - a.total);
    while (selPosts.length < 3 && rest.length) selPosts = [...selPosts, rest.shift()];
    while (selVids.length < 2 && rest.length) selVids = [...selVids, rest.shift()];
    s.selPosts = selPosts; s.selVids = selVids;
    const ids = [...selPosts, ...selVids].map((i) => i.id);
    await q("UPDATE ideas SET status='selected' WHERE id = ANY($1) AND workspace_id=$2", [ids, ctx.workspaceId]);
    return { selected: ids.length, posts: selPosts.length, videos: selVids.length };
  },
  // 9. Viết 3 bài
  async (ctx, s) => {
    s.contents = [];
    for (const idea of s.selPosts) {
      const r = await A.writePost(ctx, { title: idea.title, summary: idea.summary, pillar: idea.pillar, platform: idea.platform, hook: idea.hook, storyContext: s.journals?.[0] });
      const c = await createContent(ctx.workspaceId, ctx.userId ?? null, { brand_id: ctx.brandId, idea_id: idea.id, title: r.data.title, content_type: idea.format === 'carousel' ? 'carousel' : 'post', format: 'text', platform: idea.platform, pillar: idea.pillar, body: r.data.body, hooks: r.data.hooks, caption: r.data.caption, hashtags: r.data.hashtags, cta: r.data.cta, ai_generated: true, is_demo: r.meta.demo, workflow_run_id: ctx.workflowRunId, status: 'draft' });
      s.contents.push({ id: c.id, kind: 'post', title: c.title, body: c.body, hook: r.data.hooks[0], hashtags: r.data.hashtags, cta: r.data.cta });
      await q("UPDATE ideas SET status='in_production' WHERE id=$1", [idea.id]);
      if (r.meta.demo) s.demo = true;
    }
    return { posts_created: s.selPosts.length };
  },
  // 10. Viết 2 kịch bản (kèm project + cảnh + prompt Google Flow)
  async (ctx, s) => {
    let n = 0;
    for (const [i, idea] of s.selVids.entries()) {
      const dur = i === 0 ? 30 : 60;
      const r = await A.writeScript(ctx, { title: idea.title, summary: idea.summary, pillar: idea.pillar, durationSec: dur, storyContext: s.journals?.[0] });
      const sc = r.data;
      const body = `HOOK: ${sc.hooks[0]}\n\n` + sc.scenes.map((x) => `Cảnh ${x.scene_no} (${x.duration_sec}s): ${x.shot_description}\nThoại: ${x.dialogue}`).join('\n\n') + `\n\nCTA: ${sc.cta}`;
      const c = await createContent(ctx.workspaceId, ctx.userId ?? null, { brand_id: ctx.brandId, idea_id: idea.id, title: sc.title, content_type: 'video_script', format: `video_${dur}s`, platform: 'facebook_reels', pillar: idea.pillar, body, hooks: sc.hooks, caption: sc.caption, hashtags: sc.hashtags, cta: sc.cta, ai_generated: true, is_demo: r.meta.demo, workflow_run_id: ctx.workflowRunId, status: 'draft', metadata: { duration_sec: dur } });
      const proj = await one<{ id: string }>("INSERT INTO video_projects(workspace_id, brand_id, content_id, title, duration_sec, status, script, is_demo) VALUES ($1,$2,$3,$4,$5,'scripted',$6,$7) RETURNING id", [ctx.workspaceId, ctx.brandId, c.id, sc.title, dur, JSON.stringify(sc), r.meta.demo]);
      const prompts = buildAllFlowPrompts(sc.scenes, { character: null, aspectRatio: '9:16', projectTitle: sc.title });
      for (const sceneRow of sc.scenes) {
        await q(`INSERT INTO video_scenes(workspace_id, project_id, scene_no, duration_sec, shot_description, dialogue, voiceover, camera, lighting, audio, on_screen_text, environment, outfit, prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [ctx.workspaceId, proj!.id, sceneRow.scene_no, sceneRow.duration_sec, sceneRow.shot_description, sceneRow.dialogue, sceneRow.voiceover, sceneRow.camera, sceneRow.lighting, sceneRow.audio, sceneRow.on_screen_text, sceneRow.environment, sceneRow.outfit, prompts.find((p) => p.scene_no === sceneRow.scene_no)?.prompt ?? '']);
      }
      s.contents.push({ id: c.id, kind: 'video', title: c.title, body, hook: sc.hooks[0], hashtags: sc.hashtags, cta: sc.cta });
      await q("UPDATE ideas SET status='in_production' WHERE id=$1", [idea.id]);
      if (r.meta.demo) s.demo = true;
      n++;
    }
    return { scripts_created: n };
  },
  // 11. Biến thể đa nền tảng (bản con, không tính vào KPI nội dung gốc)
  async (ctx, s) => {
    let n = 0;
    for (const c of s.contents) {
      const platforms = c.kind === 'post' ? ['facebook_profile', 'facebook_page'] : ['facebook_reels', 'tiktok', 'youtube_shorts'];
      const r = await A.makeVariants(ctx, { title: c.title, body: c.body, hook: c.hook, hashtags: c.hashtags, cta: c.cta, platforms });
      for (const v of r.data.variants) {
        await q(`INSERT INTO content_variants(workspace_id, content_id, platform, title, hook, caption, hashtags, aspect_ratio, duration_sec, cta, body, is_demo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                 ON CONFLICT (content_id, platform) DO UPDATE SET title=EXCLUDED.title, hook=EXCLUDED.hook, caption=EXCLUDED.caption, hashtags=EXCLUDED.hashtags, body=EXCLUDED.body`,
          [ctx.workspaceId, c.id, v.platform, v.title, v.hook, v.caption, v.hashtags, v.aspect_ratio, v.duration_sec ?? null, v.cta, v.body, r.meta.demo]);
        n++;
      }
    }
    return { variants_created: n };
  },
  // 12. Lưu & thông báo
  async (ctx, s) => {
    s.result = { contents: s.contents.map((c: { id: string; title: string; kind: string }) => ({ id: c.id, title: c.title, kind: c.kind })), ideas_saved: s.savedIdeas.length, demo: !!s.demo };
    s.summary = `${s.contents.length} bản nháp đã sẵn sàng chờ duyệt${s.demo ? ' (DỮ LIỆU DEMO – chưa cấu hình AI)' : ''}`;
    return { drafts: s.contents.length, summary: s.summary };
  },
];

function reviewSteps(kind: 'weekly' | 'monthly'): StepFn[] {
  return [
    async (ctx, s) => {
      const days = kind === 'weekly' ? 7 : 30;
      s.range = defaultRange(days);
      s.tot = await totals(ctx.workspaceId, s.range);
      return { range: s.range, snapshots: s.tot.snapshots };
    },
    async (ctx, s) => {
      s.top = await topContent(ctx.workspaceId, s.range, 5);
      s.byPillar = await groupBy(ctx.workspaceId, s.range, 'pillar');
      s.byPlatform = await groupBy(ctx.workspaceId, s.range, 'platform');
      return { top: s.top.length, pillars: s.byPillar.length };
    },
    async (ctx, s) => {
      const r = await A.reviewPerformance(ctx, { period: `${kind} ${s.range.from} → ${s.range.to}`, table: { totals: s.tot.totals, metrics: s.tot.metrics, top: s.top, by_pillar: s.byPillar, by_platform: s.byPlatform, note: s.tot.snapshots === 0 ? 'KHÔNG có số liệu trong kỳ' : '' } });
      s.review = r.data; if (r.meta.demo) s.demo = true;
      return { provider: r.meta.provider };
    },
    async (ctx, s) => {
      const rep = await one<{ id: string }>('INSERT INTO research_reports(workspace_id, title, kind, body, is_demo) VALUES ($1,$2,$3,$4,$5) RETURNING id', [ctx.workspaceId, `Báo cáo ${kind === 'weekly' ? 'tuần' : 'tháng'} ${s.range.from} → ${s.range.to}`, kind, JSON.stringify({ range: s.range, totals: s.tot, review: s.review, top: s.top }), !!s.demo]);
      s.result = { report_id: rep!.id }; s.summary = 'Đã lưu báo cáo';
      return { report_id: rep!.id };
    },
  ];
}

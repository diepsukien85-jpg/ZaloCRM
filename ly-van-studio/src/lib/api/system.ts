import { z } from 'zod';
import { after } from 'next/server';
import { one, q } from '../db';
import { audit } from '../audit';
import { badRequest, forbidden, notFound } from '../errors';
import { env } from '../env';
import { maskSecret } from '../crypto';
import { budgetStatus } from '../ai/budget';
import { DEFAULT_PRICING, getPricing, type PricingTable } from '../ai/pricing';
import { testProvider } from '../ai/providers';
import { ENV_KEYS, PROVIDERS, encryptKey, getAiSettings, publicAiSettings, resolveKey, setSetting, getSetting, type ProviderId } from '../ai/settings';
import { DEFAULT_PROMPTS } from '../ai/prompts';
import { willUseExternal } from '../ai/client';
import * as A from '../ai/agents';
import { AGENTS } from '../services/bootstrap';
import { totals, defaultRange } from '../services/analytics';
import { dueKey, nextRun } from '../services/schedule';
import { executeRun, startWorkflow, type WorkflowKey } from '../services/workflows';
import { saveKeywords } from './research';
import { buildAllFlowPrompts } from '../services/flow';
import type { RouteDef } from '../router';

const ProviderId = z.enum(['anthropic', 'openai', 'gemini']);

/** Danh mục tích hợp & trạng thái THẬT. Không có mục nào được ghi "đã kết nối" khi chưa kiểm thử với API thật. */
export const INTEGRATIONS = [
  { key: 'anthropic', name: 'Anthropic (Claude)', kind: 'ai', status_hint: 'needs_api_key', note: 'Adapter đã viết theo tài liệu công khai; cần khoá API và chưa kiểm thử với khoá thật.' },
  { key: 'openai', name: 'OpenAI', kind: 'ai', status_hint: 'needs_api_key', note: 'Adapter Chat Completions; cần khoá API, chưa kiểm thử với khoá thật.' },
  { key: 'gemini', name: 'Google Gemini', kind: 'ai', status_hint: 'needs_api_key', note: 'Adapter generateContent; cần khoá API, chưa kiểm thử với khoá thật.' },
  { key: 'transcription', name: 'Chuyển giọng nói thành văn bản', kind: 'ai', status_hint: 'not_implemented', note: 'Chưa triển khai. Hiện dán transcript thủ công.' },
  { key: 'meta', name: 'Meta Graph API (Facebook Page/Reels)', kind: 'social', status_hint: 'needs_oauth', note: 'Chưa triển khai. Facebook Page cần OAuth + duyệt quyền; Facebook cá nhân KHÔNG hỗ trợ đăng qua API → dùng xuất & đăng thủ công.' },
  { key: 'tiktok', name: 'TikTok API', kind: 'social', status_hint: 'needs_oauth', note: 'Chưa triển khai; cần đăng ký app & duyệt. Hiện dùng quy trình thủ công.' },
  { key: 'youtube', name: 'YouTube Data API', kind: 'social', status_hint: 'needs_oauth', note: 'Chưa triển khai; cần OAuth. Hiện dùng quy trình thủ công.' },
  { key: 'google_drive', name: 'Google Drive', kind: 'storage', status_hint: 'needs_oauth', note: 'Chưa triển khai (Giai đoạn 2).' },
  { key: 'google_calendar', name: 'Google Calendar', kind: 'calendar', status_hint: 'needs_oauth', note: 'Chưa triển khai.' },
  { key: 'google_trends', name: 'Google Trends / nguồn xu hướng được cấp phép', kind: 'research', status_hint: 'not_implemented', note: 'Chưa có API chính thức phù hợp được tích hợp. Dùng nhập xu hướng thủ công.' },
  { key: 'google_flow', name: 'Google Flow', kind: 'video', status_hint: 'manual_only', note: 'Không dùng API: xuất prompt từng cảnh và nhập thủ công.' },
  { key: 'sales_system', name: 'Phần mềm bán hàng nội bộ Trang Tùng Khang', kind: 'crm', status_hint: 'not_implemented', note: 'Chưa triển khai. Hiện nhập/import CSV lead & đơn hàng (trường external_ref sẵn sàng cho tích hợp).' },
] as const;

const startOfRange = () => defaultRange(30);

async function copilotContext(ws: string) {
  const r = startOfRange();
  const [t, counts, ideas, lastRun] = await Promise.all([
    totals(ws, r),
    one<Record<string, number>>("SELECT count(*) FILTER (WHERE status='pending_review') AS pending, count(*) FILTER (WHERE status='scheduled') AS scheduled, count(*) FILTER (WHERE status='published') AS published, count(*) FILTER (WHERE status='draft') AS draft FROM contents WHERE workspace_id=$1 AND parent_content_id IS NULL", [ws]),
    q<{ title: string; total_score: number }>("SELECT title, total_score FROM ideas WHERE workspace_id=$1 AND status IN ('new','selected') ORDER BY total_score DESC NULLS LAST LIMIT 5", [ws]),
    one<{ status: string; finished_at: string }>("SELECT status, finished_at FROM workflow_runs WHERE workspace_id=$1 AND workflow_key='daily' ORDER BY created_at DESC LIMIT 1", [ws]),
  ]);
  return [
    `Nội dung gốc: nháp ${counts?.draft}, chờ duyệt ${counts?.pending}, đã lên lịch ${counts?.scheduled}, đã đăng ${counts?.published}.`,
    `30 ngày qua (${r.from} → ${r.to}): views ${t.totals.views}, leads ${t.totals.leads}, đơn ${t.totals.orders}, doanh thu ${t.totals.revenue} VND, chi phí quảng cáo ${t.totals.ad_spend} VND, chi phí AI ≈ ${Math.round(t.totals.ai_cost)} VND. ${t.snapshots === 0 ? '(Chưa có số liệu hiệu quả nào được nhập.)' : ''}`,
    `Top ý tưởng chưa dùng: ${ideas.map((i) => `${i.title} (${i.total_score ?? '–'})`).join('; ') || 'chưa có'}.`,
    `Daily Agent gần nhất: ${lastRun ? `${lastRun.status}` : 'chưa chạy'}.`,
  ].join('\n');
}

export const systemRoutes: RouteDef[] = [
  // ---------- AI settings ----------
  { method: 'GET', path: '/settings/ai', min: 'admin', handler: async (c) => ({ settings: publicAiSettings(await getAiSettings(c.workspaceId)), pricing: await getPricing(c.workspaceId), demo_forced: env.demoMode, external: await willUseExternal(c.workspaceId) }) },
  {
    method: 'PUT', path: '/settings/ai', min: 'admin',
    schema: z.object({
      primary: ProviderId, fallback: z.array(ProviderId).max(2).default([]), cache_ttl_hours: z.number().int().min(0).max(720).default(24), timeout_ms: z.number().int().min(5000).max(180000).default(60000),
      providers: z.record(ProviderId, z.object({ enabled: z.boolean(), model: z.string().min(1).max(100), api_key: z.string().min(8).max(500).nullish(), clear_key: z.boolean().optional() })),
      task_models: z.record(z.string().max(40), z.object({ provider: ProviderId, model: z.string().min(1).max(100) })).default({}),
    }),
    handler: async (c) => {
      const b = c.body as { primary: ProviderId; fallback: ProviderId[]; cache_ttl_hours: number; timeout_ms: number; providers: Record<ProviderId, { enabled: boolean; model: string; api_key?: string | null; clear_key?: boolean }>; task_models: Record<string, { provider: ProviderId; model: string }> };
      const cur = await getAiSettings(c.workspaceId);
      for (const p of PROVIDERS) {
        const inp = b.providers[p]; if (!inp) continue;
        cur.providers[p].enabled = inp.enabled; cur.providers[p].model = inp.model;
        if (inp.api_key) cur.providers[p].encrypted_key = encryptKey(inp.api_key); // khoá được mã hoá AES-256-GCM, không bao giờ trả về frontend
        if (inp.clear_key) cur.providers[p].encrypted_key = null;
      }
      cur.primary = b.primary; cur.fallback = b.fallback.filter((p) => p !== b.primary); cur.cache_ttl_hours = b.cache_ttl_hours; cur.timeout_ms = b.timeout_ms; cur.task_models = b.task_models;
      await setSetting(c.workspaceId, 'ai_providers', cur);
      await audit(c.workspaceId, c.user.id, 'settings.ai.update', 'settings', 'ai_providers', { primary: b.primary, keys_changed: PROVIDERS.filter((p) => b.providers[p]?.api_key || b.providers[p]?.clear_key) });
      return publicAiSettings(cur);
    },
  },
  {
    // Kiểm tra kết nối bằng một lời gọi rất nhỏ (có tính phí nhỏ). Chỉ chạy khi người dùng bấm.
    method: 'POST', path: '/settings/ai/test', min: 'admin', schema: z.object({ provider: ProviderId }), rate: { key: 'aitest', max: 10 },
    handler: async (c) => {
      const p = (c.body as { provider: ProviderId }).provider;
      const s = await getAiSettings(c.workspaceId);
      const key = resolveKey(s, p);
      if (!key) return { ok: false, error: `Chưa có khoá API cho ${p} (nhập trong Cài đặt hoặc biến ${ENV_KEYS[p]})` };
      try { return await testProvider(p, key, s.providers[p].model); }
      catch (e) { return { ok: false, error: `${(e as Error).message}`.replace(key, maskSecret(key)) }; }
    },
  },
  {
    method: 'PUT', path: '/settings/pricing', min: 'admin',
    schema: z.object({ usd_to_vnd: z.number().min(1000).max(100000), rows: z.array(z.object({ provider: z.string().max(40), model: z.string().max(100), input_per_m: z.number().min(0), output_per_m: z.number().min(0) })).max(50) }),
    handler: async (c) => {
      const b = c.body as Pick<PricingTable, 'usd_to_vnd' | 'rows'>;
      const t: PricingTable = { ...b, updated_at: new Date().toISOString().slice(0, 10), verified: true };
      await setSetting(c.workspaceId, 'ai_pricing', t);
      await audit(c.workspaceId, c.user.id, 'settings.pricing.update');
      return t;
    },
  },
  {
    method: 'GET', path: '/ai/usage',
    handler: async (c) => {
      const w = 'workspace_id=$1';
      const [rows, byModel, byAgent, byDay, budgets, pricing] = await Promise.all([
        q(`SELECT l.*, ar.status AS agent_status FROM ai_usage_logs l LEFT JOIN agent_runs ar ON ar.id=l.agent_run_id WHERE l.workspace_id=$1 ORDER BY l.created_at DESC LIMIT 200`, [c.workspaceId]),
        q(`SELECT provider, model, count(*) AS calls, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens, sum(est_cost_usd) AS cost, count(*) FILTER (WHERE cache_hit) AS cache_hits FROM ai_usage_logs WHERE ${w} GROUP BY 1,2 ORDER BY cost DESC`, [c.workspaceId]),
        q(`SELECT COALESCE(agent_key,'-') AS agent, count(*) AS calls, sum(est_cost_usd) AS cost FROM ai_usage_logs WHERE ${w} GROUP BY 1 ORDER BY cost DESC`, [c.workspaceId]),
        q(`SELECT to_char(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') AS day, sum(est_cost_usd) AS cost, count(*) AS calls FROM ai_usage_logs WHERE ${w} AND created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`, [c.workspaceId]),
        budgetStatus(c.workspaceId), getPricing(c.workspaceId),
      ]);
      return { items: rows, by_model: byModel, by_agent: byAgent, by_day: byDay, budgets, pricing, pricing_default: DEFAULT_PRICING.updated_at };
    },
  },
  {
    method: 'PUT', path: '/budgets', min: 'admin',
    schema: z.object({ daily: z.object({ amount_usd: z.number().min(0).max(100000), warn_pct: z.number().int().min(1).max(100), hard_stop: z.boolean() }), monthly: z.object({ amount_usd: z.number().min(0).max(1000000), warn_pct: z.number().int().min(1).max(100), hard_stop: z.boolean() }) }),
    handler: async (c) => {
      const b = c.body as Record<'daily' | 'monthly', { amount_usd: number; warn_pct: number; hard_stop: boolean }>;
      for (const scope of ['daily', 'monthly'] as const) {
        await q('INSERT INTO budget_limits(workspace_id, scope, amount_usd, warn_pct, hard_stop) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id, scope) DO UPDATE SET amount_usd=EXCLUDED.amount_usd, warn_pct=EXCLUDED.warn_pct, hard_stop=EXCLUDED.hard_stop', [c.workspaceId, scope, b[scope].amount_usd, b[scope].warn_pct, b[scope].hard_stop]);
      }
      await audit(c.workspaceId, c.user.id, 'budget.update', 'budget', undefined, b);
      return budgetStatus(c.workspaceId);
    },
  },

  // ---------- Agent center & prompts ----------
  {
    method: 'GET', path: '/agents',
    handler: async (c) => {
      const cfg = await q<{ agent_key: string; enabled: boolean; provider: string | null; model: string | null }>('SELECT agent_key, enabled, provider, model FROM agent_configs WHERE workspace_id=$1', [c.workspaceId]);
      const stats = await q<{ agent_key: string; runs: number; failed: number; last_run: string; avg_ms: number }>("SELECT agent_key, count(*) AS runs, count(*) FILTER (WHERE status='failed') AS failed, max(created_at) AS last_run, avg(duration_ms)::int AS avg_ms FROM agent_runs WHERE workspace_id=$1 GROUP BY 1", [c.workspaceId]);
      const runs = await q('SELECT id, agent_key, task, status, provider, model, cache_hit, is_demo, error, duration_ms, created_at FROM agent_runs WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 50', [c.workspaceId]);
      return { agents: AGENTS.map(([key, name]) => ({ key, name, ...(cfg.find((x) => x.agent_key === key) ?? { enabled: true }), stats: stats.find((s) => s.agent_key === key) ?? null })), runs };
    },
  },
  {
    method: 'PUT', path: '/agents/:key', min: 'admin', schema: z.object({ enabled: z.boolean().optional(), provider: ProviderId.nullish(), model: z.string().max(100).nullish() }),
    handler: async (c) => {
      const b = c.body as { enabled?: boolean; provider?: string | null; model?: string | null };
      const r = await one('UPDATE agent_configs SET enabled=COALESCE($3,enabled), provider=$4, model=$5 WHERE workspace_id=$1 AND agent_key=$2 RETURNING *', [c.workspaceId, c.params.key, b.enabled ?? null, b.provider ?? null, b.model ?? null]);
      if (!r) throw notFound();
      return r;
    },
  },
  {
    method: 'GET', path: '/prompts',
    handler: async (c) => ({ items: await q(`SELECT t.id, t.agent_key, t.name, t.description, (SELECT json_agg(json_build_object('version', v.version, 'active', v.active, 'system_prompt', v.system_prompt, 'notes', v.notes, 'created_at', v.created_at) ORDER BY v.version DESC) FROM prompt_versions v WHERE v.template_id=t.id) AS versions FROM prompt_templates t WHERE t.workspace_id=$1 ORDER BY t.agent_key, t.name`, [c.workspaceId]), defaults: DEFAULT_PROMPTS.length }),
  },
  {
    // Tạo phiên bản prompt mới (và kích hoạt). Phiên bản cũ được giữ lại để quay lui.
    method: 'POST', path: '/prompts/:id/versions', min: 'admin', schema: z.object({ system_prompt: z.string().min(20).max(20000), notes: z.string().max(300).default(''), activate: z.boolean().default(true) }),
    handler: async (c) => {
      const b = c.body as { system_prompt: string; notes: string; activate: boolean };
      if (!(await one('SELECT 1 FROM prompt_templates WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]))) throw notFound();
      const n = (await one<{ n: number }>('SELECT COALESCE(MAX(version),0)+1 AS n FROM prompt_versions WHERE template_id=$1', [c.params.id]))!.n;
      if (b.activate) await q('UPDATE prompt_versions SET active=false WHERE template_id=$1', [c.params.id]);
      await q('INSERT INTO prompt_versions(workspace_id, template_id, version, system_prompt, active, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [c.workspaceId, c.params.id, n, b.system_prompt, b.activate, b.notes, c.user.id]);
      await audit(c.workspaceId, c.user.id, 'prompt.version', 'prompt', c.params.id, { version: n });
      return { version: n };
    },
  },
  {
    method: 'POST', path: '/prompts/:id/activate', min: 'admin', schema: z.object({ version: z.number().int().min(1) }),
    handler: async (c) => {
      const v = (c.body as { version: number }).version;
      if (!(await one('SELECT 1 FROM prompt_versions WHERE template_id=$1 AND workspace_id=$2 AND version=$3', [c.params.id, c.workspaceId, v]))) throw notFound();
      await q('UPDATE prompt_versions SET active = (version = $2) WHERE template_id=$1', [c.params.id, v]);
      return { ok: true };
    },
  },

  // ---------- Copilot ----------
  {
    method: 'POST', path: '/copilot', rate: { key: 'copilot', max: 30 }, schema: z.object({ message: z.string().min(1).max(4000) }),
    handler: async (c) => {
      const msg = (c.body as { message: string }).message.trim();
      const ctx = { workspaceId: c.workspaceId, userId: c.user.id };
      const m = /^\/([A-Za-z0-9]+)\s*([\s\S]*)$/.exec(msg);
      const cmd = m?.[1].toUpperCase(); const rest = (m?.[2] ?? '').trim();
      const needEdit = () => { if (c.role === 'viewer') throw forbidden('Vai trò Người xem không được chạy lệnh tạo nội dung'); };
      switch (cmd) {
        case 'DAILY': {
          needEdit();
          const id = await startWorkflow(c.workspaceId, c.user.id, 'daily', {});
          after(() => executeRun(id).catch((e) => console.error(e)));
          return { reply: 'Đã khởi chạy **Daily Content Agent**. Theo dõi tiến độ tại AI Agent Center.', link: `/agents?run=${id}` };
        }
        case 'KEYWORD': {
          needEdit();
          const roots = rest.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
          if (!roots.length) return { reply: 'Cú pháp: `/KEYWORD tiền bạc, đám cưới`' };
          const brand = await one<{ id: string }>("SELECT id FROM brands WHERE workspace_id=$1 ORDER BY (kind='personal') DESC LIMIT 1", [c.workspaceId]);
          const r = await A.expandKeywords({ ...ctx, brandId: brand?.id }, { roots, count: 20 });
          const s = await saveKeywords(c.workspaceId, brand?.id ?? null, r.data.keywords, r.meta.demo ? 'demo' : 'ai', r.meta.demo);
          return { reply: `Đã mở rộng từ khoá ${r.meta.demo ? '(DEMO) ' : ''}từ: ${roots.join(', ')} — thêm mới ${s.added}, bỏ qua ${s.skipped} trùng.`, link: '/keywords' };
        }
        case 'VIRAL': {
          needEdit();
          const r = await A.generateIdeas(ctx, { count: 5, keywords: rest ? [rest] : undefined });
          return { reply: `Ý tưởng có tiềm năng thu hút ${r.meta.demo ? '(DEMO) ' : ''}(điểm là ước tính của AI, không cam kết lan truyền):\n\n` + r.data.ideas.map((i, n) => `${n + 1}. **${i.title}** — ${i.hook}`).join('\n') };
        }
        case 'DECODE': return { reply: 'Mở **Giải mã video viral** và dán transcript/nội dung bài tham khảo (Copilot không tự truy cập link).', link: '/viral' };
        case 'STORY': return { reply: 'Mở **Ngân hàng câu chuyện**, chọn nhật ký rồi bấm “Trích xuất câu chuyện”.', link: '/stories' };
        case 'FLOW': {
          const p = await one<{ id: string; title: string; aspect_ratio: string }>('SELECT id, title, aspect_ratio FROM video_projects WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1', [c.workspaceId]);
          if (!p) return { reply: 'Chưa có dự án video nào. Tạo kịch bản trong Content Factory hoặc Video Studio trước.' };
          const sc = await q<{ scene_no: number; duration_sec: number; shot_description: string; dialogue: string; voiceover: string; camera: string; lighting: string; audio: string; environment: string; outfit: string }>('SELECT * FROM video_scenes WHERE project_id=$1 ORDER BY scene_no', [p.id]);
          const pr = buildAllFlowPrompts(sc, { character: null, aspectRatio: p.aspect_ratio, projectTitle: p.title });
          return { reply: `Prompt Google Flow cho **${p.title}** (tạo từ dữ liệu cảnh, không gọi AI):\n\n` + pr.slice(0, 3).map((x) => '```\n' + x.prompt + '\n```').join('\n') + (pr.length > 3 ? `\n… và ${pr.length - 3} cảnh nữa trong Video Studio.` : ''), link: `/video?p=${p.id}` };
        }
        case '30DAY': {
          needEdit();
          const k = await one<{ id: string; keyword: string }>("SELECT id, keyword FROM keywords WHERE workspace_id=$1 ORDER BY favorite DESC, content_potential_score DESC NULLS LAST LIMIT 1", [c.workspaceId]);
          if (!k) return { reply: 'Chưa có từ khoá.' };
          return { reply: `Vào **Phòng từ khoá**, chọn “${k.keyword}” → “Kế hoạch 30 ngày” để tạo 30 ý tưởng (có tốn chi phí AI nếu đã cấu hình khoá).`, link: '/keywords' };
        }
        case 'AUDIT': case 'REPORT': {
          const t = await totals(c.workspaceId, startOfRange());
          const f = (v: number | null, s = '') => (v == null ? '—' : v.toFixed(2) + s);
          return { reply: `**Báo cáo 30 ngày** (số liệu bạn đã nhập; ${t.snapshots} bản ghi)\n- Views: ${t.totals.views} · Reach: ${t.totals.reach}\n- Tương tác/Views: ${f(t.metrics.engagement_rate, '%')}\n- Leads: ${t.totals.leads} · Đơn: ${t.totals.orders}\n- CPL: ${f(t.metrics.cpl)} · ROAS: ${f(t.metrics.roas)} · ROI: ${f(t.metrics.marketing_roi, '%')}\n- Chi phí AI ≈ ${Math.round(t.totals.ai_cost)} VND\n\n*Lưu ý: chỉ là tương quan, không kết luận nhân quả.*`, link: '/analytics' };
        }
        case 'REWRITE': {
          needEdit();
          if (rest.length < 10) return { reply: 'Cú pháp: `/REWRITE <đoạn văn cần viết lại>`' };
          const r = await A.rewriteText(ctx, { instruction: 'Viết lại tự nhiên, gần gũi hơn, giữ nguyên sự thật', text: rest });
          return { reply: r.data.text };
        }
        default: {
          if (cmd) return { reply: 'Lệnh không hợp lệ. Hỗ trợ: /DAILY /KEYWORD /VIRAL /DECODE /STORY /FLOW /30DAY /AUDIT /REPORT /REWRITE' };
          const r = await A.copilotAnswer(ctx, { message: msg, context: await copilotContext(c.workspaceId) });
          return { reply: r.data.answer, demo: r.meta.demo };
        }
      }
    },
  },

  // ---------- Thông báo, audit, tích hợp, dữ liệu ----------
  {
    method: 'GET', path: '/notifications',
    handler: async (c) => ({ items: await q('SELECT id, kind, title, body, link, read_at, created_at FROM notifications WHERE workspace_id=$1 AND (user_id IS NULL OR user_id=$2) ORDER BY created_at DESC LIMIT 50', [c.workspaceId, c.user.id]) }),
  },
  { method: 'POST', path: '/notifications/read', handler: async (c) => { await q('UPDATE notifications SET read_at=now() WHERE workspace_id=$1 AND (user_id IS NULL OR user_id=$2) AND read_at IS NULL', [c.workspaceId, c.user.id]); return { ok: true }; } },
  {
    method: 'GET', path: '/audit-logs', min: 'admin',
    handler: async (c) => ({ items: await q('SELECT a.id, a.action, a.entity_type, a.entity_id, a.detail, a.created_at, u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.workspace_id=$1 ORDER BY a.created_at DESC LIMIT 200', [c.workspaceId]) }),
  },
  {
    method: 'GET', path: '/integrations',
    handler: async (c) => {
      const s = await getAiSettings(c.workspaceId);
      return { items: INTEGRATIONS.map((i) => {
        let status: string = i.status_hint;
        if (i.kind === 'ai' && PROVIDERS.includes(i.key as ProviderId)) status = resolveKey(s, i.key as ProviderId) ? 'configured_untested' : 'needs_api_key';
        return { ...i, status };
      }), demo_forced: env.demoMode };
    },
  },
  {
    // Xuất toàn bộ dữ liệu workspace (quyền sở hữu dữ liệu). Không gồm khoá API.
    method: 'GET', path: '/export/workspace', min: 'admin',
    handler: async (c) => {
      const tables = ['brands', 'brand_dna', 'content_pillars', 'products', 'audience_profiles', 'channels', 'keywords', 'trends', 'viral_decodes', 'daily_journals', 'stories', 'ideas', 'idea_scores', 'campaigns', 'contents', 'content_versions', 'content_variants', 'content_approvals', 'video_projects', 'video_scenes', 'characters', 'schedules', 'analytics_snapshots', 'leads', 'sales_attributions', 'ai_usage_logs', 'budget_limits'];
      const data: Record<string, unknown> = { exported_at: new Date().toISOString(), workspace_id: c.workspaceId };
      for (const t of tables) data[t] = await q(`SELECT * FROM ${t} WHERE workspace_id=$1`, [c.workspaceId]);
      await audit(c.workspaceId, c.user.id, 'workspace.export');
      return new Response(JSON.stringify(data, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="lyvan-workspace-export.json"' } });
    },
  },
  {
    method: 'DELETE', path: '/workspace', min: 'owner', schema: z.object({ confirm_name: z.string() }),
    handler: async (c) => {
      const w = await one<{ name: string }>('SELECT name FROM workspaces WHERE id=$1', [c.workspaceId]);
      if (!w || w.name !== (c.body as { confirm_name: string }).confirm_name) throw badRequest('Tên workspace xác nhận không khớp');
      await audit(null, c.user.id, 'workspace.delete', 'workspace', c.workspaceId, { name: w.name });
      await q('DELETE FROM workspaces WHERE id=$1', [c.workspaceId]);
      return { ok: true };
    },
  },
  {
    method: 'GET', path: '/publications',
    handler: async (c) => ({ items: await q('SELECT j.*, ct.title FROM publication_jobs j JOIN contents ct ON ct.id=j.content_id WHERE j.workspace_id=$1 ORDER BY j.created_at DESC LIMIT 100', [c.workspaceId]) }),
  },
  {
    // Cron: gọi mỗi 5-15 phút (Vercel Cron / crontab). Chỉ chạy lịch ĐÃ ĐƯỢC NGƯỜI DÙNG BẬT & xác nhận.
    method: 'POST', path: '/cron/tick', public: true,
    handler: async ({ req }) => {
      if (!env.cronSecret || req.headers.get('authorization') !== `Bearer ${env.cronSecret}`) throw forbidden('CRON_SECRET không hợp lệ');
      const rows = await q<{ workspace_id: string; workflow_key: WorkflowKey; hour: number; minute: number; weekday: number | null; day_of_month: number | null; timezone: string; last_run_at: string | null; confirmed_by: string | null }>('SELECT * FROM automation_schedules WHERE enabled AND confirmed_by IS NOT NULL');
      const started: string[] = [];
      for (const s of rows) {
        const key = dueKey(s);
        if (!key) continue;
        try {
          const id = await startWorkflow(s.workspace_id, s.confirmed_by, s.workflow_key, { trigger: 'schedule', idempotencyKey: key });
          await q('UPDATE automation_schedules SET last_run_at=now(), next_run_at=$3 WHERE workspace_id=$1 AND workflow_key=$2', [s.workspace_id, s.workflow_key, nextRun(s)?.toISOString() ?? null]);
          after(() => executeRun(id).catch((e) => console.error('[cron]', e)));
          started.push(id);
        } catch (e) { console.error('[cron] bỏ qua', s.workflow_key, (e as Error).message); }
      }
      return { started: started.length };
    },
  },
  { method: 'GET', path: '/health', public: true, handler: async () => { await q('SELECT 1'); return { ok: true, time: new Date().toISOString() }; } },
];

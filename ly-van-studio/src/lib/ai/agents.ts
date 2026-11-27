import { z } from 'zod';
import { one, q } from '../db';
import { loadBrandCtx, dnaToText, type BrandCtx } from './context';
import { generateStructured, type AiMeta, type AiResult } from './client';
import { getActivePrompt } from './prompts';
import { redactPII, wrapUntrusted } from './safety';
import * as S from './schemas';
import * as D from './demo';

export type AgentCtx = {
  workspaceId: string; userId?: string | null; brandId?: string | null;
  workflowRunId?: string | null; runLimitUsd?: number | null; signal?: () => Promise<void>;
};

/** Ghi agent_runs cho mọi lần chạy agent (trạng thái, thời gian, provider, lỗi). */
async function track<T>(ctx: AgentCtx, agentKey: string, task: string, input: unknown, fn: (runId: string) => Promise<AiResult<T>>): Promise<AiResult<T>> {
  const run = await one<{ id: string }>(
    'INSERT INTO agent_runs(workspace_id, workflow_run_id, agent_key, task, input, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [ctx.workspaceId, ctx.workflowRunId ?? null, agentKey, task, JSON.stringify(input ?? {}).slice(0, 20000), ctx.userId ?? null]);
  const t0 = Date.now();
  try {
    const r = await fn(run!.id);
    await q('UPDATE agent_runs SET status=$2, output=$3, provider=$4, model=$5, cache_hit=$6, is_demo=$7, duration_ms=$8 WHERE id=$1',
      [run!.id, 'succeeded', JSON.stringify(r.data).slice(0, 200000), r.meta.provider, r.meta.model, r.meta.cacheHit, r.meta.demo, Date.now() - t0]);
    return r;
  } catch (e) {
    await q('UPDATE agent_runs SET status=$2, error=$3, duration_ms=$4 WHERE id=$1', [run!.id, 'failed', (e as Error).message.slice(0, 1000), Date.now() - t0]);
    throw e;
  }
}

async function brandBlock(ctx: AgentCtx): Promise<{ brand: BrandCtx | null; text: string }> {
  const brand = await loadBrandCtx(ctx.workspaceId, ctx.brandId);
  return { brand, text: brand ? `DNA THƯƠNG HIỆU (đang hoạt động):\n${dnaToText(brand)}` : 'Chưa có DNA thương hiệu.' };
}

function gen<T>(ctx: AgentCtx, agentKey: string, task: string, runId: string, p: { system: string; version: number }, user: string, schema: z.ZodType<T>, demo: () => T, extra: { maxTokens?: number; temperature?: number; cache?: boolean } = {}) {
  return generateStructured<T>({ workspaceId: ctx.workspaceId, userId: ctx.userId, agentKey, task, system: p.system, user, schema, demo, promptVersion: p.version, agentRunId: runId, workflowRunId: ctx.workflowRunId, runLimitUsd: ctx.runLimitUsd, signal: ctx.signal, ...extra });
}

export async function expandKeywords(ctx: AgentCtx, input: { roots: string[]; count: 20 | 50 | 100; languages?: string[] }) {
  return track(ctx, 'keyword', 'keyword_expansion', input, async (runId) => {
    const p = await getActivePrompt(ctx.workspaceId, 'keyword_expansion');
    const { text } = await brandBlock(ctx);
    const user = `${text}\n\nTừ khoá gốc: ${input.roots.join(', ')}\nSố lượng cần: ${input.count}\nNgôn ngữ: ${(input.languages ?? ['vi', 'en', 'zh']).join(', ')}\n` +
      `Trả JSON: {"keywords":[{"keyword","parent","tier","language","category","search_intent","audience","funnel_stage","relevance_score","content_potential_score"}]}`;
    return gen(ctx, 'keyword', 'keyword_expansion', runId, p, user, S.KeywordExpansion, () => D.demoKeywords(input.roots, input.count), { maxTokens: 8000 });
  });
}

export async function generateIdeas(ctx: AgentCtx, input: { count: number; keywords?: string[]; journals?: string[]; trends?: string[]; exclude?: string[]; pillars?: { name: string; weight: number }[] }) {
  return track(ctx, 'strategist', 'idea_generation', { ...input, journals: input.journals?.length }, async (runId) => {
    const p = await getActivePrompt(ctx.workspaceId, 'idea_generation');
    const { brand, text } = await brandBlock(ctx);
    const pillars = input.pillars ?? brand?.pillars ?? [];
    const user = `${text}\n\nSố ý tưởng cần: ${input.count}\nTỪ KHOÁ ƯU TIÊN: ${(input.keywords ?? []).slice(0, 40).join(', ') || '(không có)'}\n` +
      `${input.journals?.length ? 'NHẬT KÝ GẦN ĐÂY (dữ liệu tham khảo):\n' + wrapUntrusted(redactPII(input.journals.join('\n---\n')).slice(0, 6000), 'journal') + '\n' : ''}` +
      `${input.trends?.length ? 'XU HƯỚNG ĐÃ LƯU:\n' + wrapUntrusted(input.trends.join('\n'), 'trends') + '\n' : ''}` +
      `Ý TƯỞNG ĐÃ DÙNG (không trùng): ${(input.exclude ?? []).slice(0, 80).join(' | ') || '(chưa có)'}\n` +
      `Trả JSON: {"ideas":[{"title","summary","pillar","format","platform","hook","keyword","scores":{"attraction","brand_fit","retention","conversion","feasibility"},"rationale"}]}`;
    return gen(ctx, 'strategist', 'idea_generation', runId, p, user, S.IdeaBatch, () => D.demoIdeas(input.count, pillars, input.exclude ?? []), { maxTokens: 8000 });
  });
}

export async function writePost(ctx: AgentCtx, input: { title: string; summary?: string; pillar?: string; platform?: string; hook?: string; storyContext?: string; style?: string }) {
  return track(ctx, 'copywriter', 'post_writing', input, async (runId) => {
    const p = await getActivePrompt(ctx.workspaceId, 'post_writing');
    const { text } = await brandBlock(ctx);
    const story = input.storyContext ? wrapUntrusted(redactPII(input.storyContext).slice(0, 5000), 'story') : '(không có)';
    const user = `${text}\n\nChủ đề: ${input.title}\nTóm tắt: ${input.summary ?? ''}\nTrụ cột: ${input.pillar ?? ''}\nNền tảng: ${input.platform ?? 'facebook_profile'}\nKiểu bài: ${input.style ?? 'chia sẻ kinh nghiệm'}\nHook gợi ý: ${input.hook ?? ''}\nTƯ LIỆU THẬT (chỉ dùng dữ kiện trong này):\n${story}\n` +
      `Trả JSON: {"title","hooks":[>=3],"body","caption","hashtags":[],"cta"}`;
    return gen(ctx, 'copywriter', 'post_writing', runId, p, user, S.PostDraft, () => D.demoPost(input.title, input.pillar ?? '', input.storyContext ?? input.summary ?? ''), { maxTokens: 3000 });
  });
}

export async function writeScript(ctx: AgentCtx, input: { title: string; summary?: string; pillar?: string; durationSec: number; storyContext?: string }) {
  return track(ctx, 'video_script', 'video_script', input, async (runId) => {
    const p = await getActivePrompt(ctx.workspaceId, 'video_script');
    const { text } = await brandBlock(ctx);
    const long = input.durationSec >= 180;
    const story = input.storyContext ? wrapUntrusted(redactPII(input.storyContext).slice(0, 5000), 'story') : '(không có)';
    const user = `${text}\n\nChủ đề: ${input.title}\nTóm tắt: ${input.summary ?? ''}\nThời lượng: ${input.durationSec} giây\nTƯ LIỆU THẬT:\n${story}\n${long ? 'Có phần "youtube": 3 tiêu đề, mô tả SEO, chapters.\n' : 'youtube: null\n'}` +
      `Trả JSON: {"title","main_keyword","audience","problem","desire","hooks":[>=3],"duration_sec","scenes":[{"scene_no","duration_sec","shot_description","dialogue","voiceover","camera","lighting","audio","on_screen_text","environment","outfit"}],"cta","caption","hashtags","youtube"}`;
    return gen(ctx, 'video_script', 'video_script', runId, p, user, S.VideoScript, () => D.demoScript(input.title, input.durationSec, long ? 'long' : 'short', input.summary ?? ''), { maxTokens: 6000 });
  });
}

export async function extractStory(ctx: AgentCtx, input: { text: string }) {
  return track(ctx, 'storyteller', 'story_extraction', { len: input.text.length }, async (runId) => {
    const p = await getActivePrompt(ctx.workspaceId, 'story_extraction');
    const { text } = await brandBlock(ctx);
    const user = `${text}\n\nNHẬT KÝ (đã ẩn thông tin liên hệ):\n${wrapUntrusted(redactPII(input.text).slice(0, 8000), 'journal')}\n` +
      `Trả JSON: {"title","characters":[],"setting","problem","conflict","decision","action","result","lesson","emotion","viewer_value","not_stated":[],"lessons":[3],"broad_keywords":[5],"ideas":[{"title","summary"}x5],"hooks":[3],"facebook_post","short_video_idea"}`;
    return gen(ctx, 'storyteller', 'story_extraction', runId, p, user, S.StoryExtraction, () => D.demoStory(redactPII(input.text)), { maxTokens: 4000 });
  });
}

export async function decodeViral(ctx: AgentCtx, input: { text: string; sourceType: string; url?: string; observedVisuals: boolean }) {
  return track(ctx, 'viral_decoder', 'viral_decode', { ...input, text: input.text.length }, async (runId) => {
    const p = await getActivePrompt(ctx.workspaceId, 'viral_decode');
    const { text } = await brandBlock(ctx);
    const user = `${text}\n\nLoại nguồn: ${input.sourceType}\nURL (chỉ để tham chiếu, KHÔNG được truy cập): ${input.url ?? ''}\nNgười dùng ${input.observedVisuals ? 'CÓ' : 'KHÔNG'} cung cấp mô tả hình ảnh quan sát được.\nNỘI DUNG THAM KHẢO:\n${wrapUntrusted(input.text.slice(0, 12000), 'reference')}\n` +
      `Trả JSON: {"topic","audience","hook","structure":[],"conflict","curiosity","emotion","pacing","camera","lighting","audio","on_screen_text","cta","retention_formula","reusable_formula","template","not_observed":[],"ideas":[{"title","summary"}x5],"script","production_guide"}`;
    return gen(ctx, 'viral_decoder', 'viral_decode', runId, p, user, S.ViralDecode, () => D.demoDecode(input.text, input.observedVisuals), { maxTokens: 5000 });
  });
}

export async function makeVariants(ctx: AgentCtx, input: { title: string; body: string; hook: string; hashtags: string[]; cta: string; platforms: string[] }) {
  return track(ctx, 'distribution', 'variants', { ...input, body: input.body.length }, async (runId) => {
    const p = await getActivePrompt(ctx.workspaceId, 'variants');
    const { text } = await brandBlock(ctx);
    const user = `${text}\n\nNội dung gốc:\nTiêu đề: ${input.title}\nHook: ${input.hook}\nThân:\n${input.body.slice(0, 6000)}\nHashtag: ${input.hashtags.join(' ')}\nCTA: ${input.cta}\nNền tảng cần tạo: ${input.platforms.join(', ')}\n` +
      `Trả JSON: {"variants":[{"platform","title","hook","caption","hashtags","aspect_ratio","duration_sec","cta","body"}]}`;
    return gen(ctx, 'distribution', 'variants', runId, p, user, S.Variants, () => D.demoVariants(input.platforms, input.title, input.hook, input.body, input.hashtags, input.cta), { maxTokens: 5000 });
  });
}

export async function rewriteText(ctx: AgentCtx, input: { instruction: string; text: string }) {
  return track(ctx, 'copywriter', 'rewrite', { instruction: input.instruction, len: input.text.length }, async (runId) => {
    const p = await getActivePrompt(ctx.workspaceId, 'rewrite');
    const { text } = await brandBlock(ctx);
    const user = `${text}\n\nChỉ thị: ${input.instruction}\nVĂN BẢN:\n${wrapUntrusted(input.text.slice(0, 8000), 'text')}\nTrả JSON: {"text","hooks":[],"note"}`;
    return gen(ctx, 'copywriter', 'rewrite', runId, p, user, S.Rewrite, () => D.demoRewrite(input.instruction, input.text), { maxTokens: 3000, cache: false });
  });
}

export async function reviewPerformance(ctx: AgentCtx, input: { period: string; table: unknown }) {
  return track(ctx, 'analytics', 'review', { period: input.period }, async (runId) => {
    const p = await getActivePrompt(ctx.workspaceId, 'review');
    const user = `Kỳ: ${input.period}\nSố liệu đã tính (JSON):\n${JSON.stringify(input.table).slice(0, 8000)}\nTrả JSON: {"summary","best":[],"weak":[],"experiments":[],"next_plan":[],"caveats":[]}`;
    return gen(ctx, 'analytics', 'review', runId, p, user, S.Review, () => D.demoReview(`Kỳ ${input.period}.`), { maxTokens: 2500 });
  });
}

export async function analyzeTrend(ctx: AgentCtx, input: { title: string; notes: string; platform: string }) {
  return track(ctx, 'trend', 'trend_analysis', input, async (runId) => {
    const p = await getActivePrompt(ctx.workspaceId, 'trend_analysis');
    const { text } = await brandBlock(ctx);
    const user = `${text}\n\nXu hướng: ${input.title} (${input.platform})\nGhi chú người dùng:\n${wrapUntrusted(input.notes.slice(0, 4000), 'trend')}\nTrả JSON: {"analysis","application_hint","relevance_score"}`;
    return gen(ctx, 'trend', 'trend_analysis', runId, p, user, S.TrendAnalysis, () => ({ analysis: `${D.DEMO_TAG} Chưa có phân tích AI thật.`, application_hint: `${D.DEMO_TAG} Hãy gắn xu hướng với một trải nghiệm thật của bạn.`, relevance_score: 50 }), { maxTokens: 1500 });
  });
}

export async function copilotAnswer(ctx: AgentCtx, input: { message: string; context: string }) {
  return track(ctx, 'master', 'copilot', { message: input.message }, async (runId) => {
    const p = await getActivePrompt(ctx.workspaceId, 'copilot');
    const { text } = await brandBlock(ctx);
    const user = `${text}\n\nNGỮ CẢNH WORKSPACE (số liệu thật từ DB):\n${input.context}\n\nCÂU HỎI NGƯỜI DÙNG:\n${wrapUntrusted(input.message.slice(0, 4000), 'user_message')}\nTrả JSON: {"answer"}`;
    return gen(ctx, 'master', 'copilot', runId, p, user, S.CopilotAnswer, () => ({ answer: `${D.DEMO_TAG} Copilot chưa kết nối AI thật nên chỉ hiển thị số liệu từ cơ sở dữ liệu:\n\n${input.context}` }), { maxTokens: 2000, cache: false });
  });
}

export type { AiMeta };

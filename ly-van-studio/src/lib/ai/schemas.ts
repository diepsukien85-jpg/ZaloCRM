import { z } from 'zod';

export const LANG = z.enum(['vi', 'en', 'zh']);
export const INTENT = z.enum(['informational', 'navigational', 'commercial', 'transactional']);
export const FUNNEL = z.enum(['awareness', 'consideration', 'decision', 'retention']);
export const FORMAT = z.enum(['post', 'short_video', 'long_video', 'carousel', 'infographic']);
export const PLATFORM = z.enum(['facebook_profile', 'facebook_page', 'facebook_reels', 'tiktok', 'youtube_shorts', 'youtube_long']);
const score = (max: number) => z.coerce.number().min(0).max(max).transform((n) => Math.round(n));

export const KeywordExpansion = z.object({
  keywords: z.array(z.object({
    keyword: z.string().min(1).max(200),
    parent: z.string().max(200).nullish(),
    tier: z.coerce.number().int().min(1).max(5),
    language: LANG.default('vi'),
    category: z.string().max(100).default(''),
    search_intent: INTENT.default('informational'),
    audience: z.string().max(200).default(''),
    funnel_stage: FUNNEL.default('awareness'),
    relevance_score: score(100),
    content_potential_score: score(100),
  })).min(1),
});
export type KeywordExpansionT = z.infer<typeof KeywordExpansion>;

export const IdeaScores = z.object({
  attraction: score(25), brand_fit: score(25), retention: score(20), conversion: score(20), feasibility: score(10),
});
export const IdeaBatch = z.object({
  ideas: z.array(z.object({
    title: z.string().min(3).max(200),
    summary: z.string().max(1000).default(''),
    pillar: z.string().max(100).default(''),
    format: FORMAT.default('post'),
    platform: PLATFORM.default('facebook_profile'),
    hook: z.string().max(400).default(''),
    keyword: z.string().max(200).nullish(),
    scores: IdeaScores,
    rationale: z.string().max(800).default(''),
  })).min(1),
});
export type IdeaBatchT = z.infer<typeof IdeaBatch>;

export const PostDraft = z.object({
  title: z.string().min(1).max(200),
  hooks: z.array(z.string().min(1)).min(3),
  body: z.string().min(1),
  caption: z.string().default(''),
  hashtags: z.array(z.string()).default([]),
  cta: z.string().default(''),
});
export type PostDraftT = z.infer<typeof PostDraft>;

export const SceneSchema = z.object({
  scene_no: z.coerce.number().int().min(1),
  duration_sec: z.coerce.number().int().min(1).max(60),
  shot_description: z.string().default(''),
  dialogue: z.string().default(''),
  voiceover: z.string().default(''),
  camera: z.string().default(''),
  lighting: z.string().default(''),
  audio: z.string().default(''),
  on_screen_text: z.string().default(''),
  environment: z.string().default(''),
  outfit: z.string().default(''),
});
export type SceneT = z.infer<typeof SceneSchema>;

export const VideoScript = z.object({
  title: z.string().min(1),
  main_keyword: z.string().default(''),
  audience: z.string().default(''),
  problem: z.string().default(''),
  desire: z.string().default(''),
  hooks: z.array(z.string()).min(3),
  duration_sec: z.coerce.number().int().min(5).max(1800),
  scenes: z.array(SceneSchema).min(1),
  cta: z.string().default(''),
  caption: z.string().default(''),
  hashtags: z.array(z.string()).default([]),
  youtube: z.object({
    titles: z.array(z.string()).min(1),
    description: z.string(),
    chapters: z.array(z.object({ time: z.string(), title: z.string() })),
  }).nullish(),
});
export type VideoScriptT = z.infer<typeof VideoScript>;

export const StoryExtraction = z.object({
  title: z.string().min(1),
  characters: z.array(z.string()).default([]),
  setting: z.string().default(''),
  problem: z.string().default(''),
  conflict: z.string().default(''),
  decision: z.string().default(''),
  action: z.string().default(''),
  result: z.string().default(''),
  lesson: z.string().default(''),
  emotion: z.string().default(''),
  viewer_value: z.string().default(''),
  not_stated: z.array(z.string()).default([]),
  lessons: z.array(z.string()).min(1),
  broad_keywords: z.array(z.string()).min(1),
  ideas: z.array(z.object({ title: z.string(), summary: z.string().default('') })).min(1),
  hooks: z.array(z.string()).min(1),
  facebook_post: z.string().min(1),
  short_video_idea: z.string().min(1),
});
export type StoryExtractionT = z.infer<typeof StoryExtraction>;

export const ViralDecode = z.object({
  topic: z.string(), audience: z.string(), hook: z.string(),
  structure: z.array(z.string()), conflict: z.string(), curiosity: z.string(), emotion: z.string(),
  pacing: z.string().nullish(), camera: z.string().nullish(), lighting: z.string().nullish(),
  audio: z.string().nullish(), on_screen_text: z.string().nullish(), cta: z.string().default(''),
  retention_formula: z.string(), reusable_formula: z.string(), template: z.string(),
  not_observed: z.array(z.string()).default([]),
  ideas: z.array(z.object({ title: z.string(), summary: z.string().default('') })).min(1),
  script: z.string(), production_guide: z.string(),
});
export type ViralDecodeT = z.infer<typeof ViralDecode>;

export const Variants = z.object({
  variants: z.array(z.object({
    platform: PLATFORM, title: z.string().default(''), hook: z.string().default(''), caption: z.string().default(''),
    hashtags: z.array(z.string()).default([]), aspect_ratio: z.string().default(''),
    duration_sec: z.coerce.number().int().nullish(), cta: z.string().default(''), body: z.string().default(''),
  })).min(1),
});
export type VariantsT = z.infer<typeof Variants>;

export const Rewrite = z.object({ text: z.string().min(1), hooks: z.array(z.string()).default([]), note: z.string().default('') });
export type RewriteT = z.infer<typeof Rewrite>;

export const Review = z.object({
  summary: z.string(), best: z.array(z.string()).default([]), weak: z.array(z.string()).default([]),
  experiments: z.array(z.string()).default([]), next_plan: z.array(z.string()).default([]),
  caveats: z.array(z.string()).default([]),
});
export type ReviewT = z.infer<typeof Review>;

export const CopilotAnswer = z.object({ answer: z.string().min(1) });
export const TrendAnalysis = z.object({ analysis: z.string(), application_hint: z.string(), relevance_score: score(100) });

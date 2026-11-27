import type { ZodType } from 'zod';
import { one, q } from '../db';
import { env } from '../env';
import { sha256 } from '../crypto';
import { assertBudget } from './budget';
import { estimateCost, getPricing } from './pricing';
import { ProviderError, adapters, withRetry } from './providers';
import { extractJson, INJECTION_GUARD } from './safety';
import { PROVIDERS, getAiSettings, resolveKey, type ProviderId } from './settings';
import { HttpError } from '../errors';

export type AiMeta = { provider: string; model: string; demo: boolean; cacheHit: boolean; inputTokens: number; outputTokens: number; costUsd: number; fallbackFrom?: string[] };
export type AiResult<T> = { data: T; meta: AiMeta };

export type GenerateOpts<T> = {
  workspaceId: string;
  userId?: string | null;
  agentKey: string;
  task: string;
  system: string;
  user: string;
  schema: ZodType<T>;
  /** Hàm sinh dữ liệu DEMO (có gắn nhãn) khi chưa cấu hình khoá API hoặc bật AI_DEMO_MODE. */
  demo: () => T;
  promptVersion?: number;
  maxTokens?: number;
  temperature?: number;
  cache?: boolean;
  workflowRunId?: string | null;
  agentRunId?: string | null;
  runLimitUsd?: number | null;
  /** Kiểm tra trước khi tốn tiền: ném lỗi nếu người dùng đã yêu cầu huỷ. */
  signal?: () => Promise<void>;
};

async function logUsage(o: GenerateOpts<unknown>, m: AiMeta, status: string, latency: number, error?: string) {
  await q(`INSERT INTO ai_usage_logs(workspace_id, provider, model, agent_key, task, workflow_run_id, agent_run_id, input_tokens, output_tokens, est_cost_usd, status, error, cache_hit, is_demo, latency_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [o.workspaceId, m.provider, m.model, o.agentKey, o.task, o.workflowRunId ?? null, o.agentRunId ?? null, m.inputTokens, m.outputTokens, m.costUsd, status, error ?? null, m.cacheHit, m.demo, latency]);
}

const approxTokens = (s: string) => Math.ceil(s.length / 3.5);

export async function generateStructured<T>(o: GenerateOpts<T>): Promise<AiResult<T>> {
  const started = Date.now();
  const settings = await getAiSettings(o.workspaceId);
  const system = `${o.system}\n\n${INJECTION_GUARD}`;

  const override = settings.task_models[o.agentKey];
  const order: ProviderId[] = [override?.provider ?? settings.primary, ...settings.fallback].filter((p, i, a) => a.indexOf(p) === i && PROVIDERS.includes(p));
  const usable = env.demoMode ? [] : order.filter((p) => settings.providers[p].enabled && resolveKey(settings, p));

  // ---- DEMO ----
  if (!usable.length) {
    const data = o.schema.parse(o.demo());
    const meta: AiMeta = { provider: 'demo', model: 'demo', demo: true, cacheHit: false, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    await logUsage(o, meta, 'ok', Date.now() - started);
    return { data, meta };
  }

  // ---- Cache (tránh gọi lặp không cần thiết) ----
  const modelFor = (p: ProviderId) => (override && override.provider === p ? override.model : settings.providers[p].model);
  const cacheKey = sha256([o.task, system, o.user, usable[0], modelFor(usable[0])].join('\u0001'));
  if (o.cache !== false) {
    const hit = await one<{ response: unknown; id: string }>('SELECT id, response FROM ai_cache WHERE workspace_id=$1 AND cache_key=$2 AND expires_at > now()', [o.workspaceId, cacheKey]);
    if (hit) {
      const parsed = o.schema.safeParse(hit.response);
      if (parsed.success) {
        const meta: AiMeta = { provider: usable[0], model: modelFor(usable[0]), demo: false, cacheHit: true, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        await logUsage(o, meta, 'ok', Date.now() - started);
        return { data: parsed.data, meta };
      }
    }
  }

  const pricing = await getPricing(o.workspaceId);
  const failed: string[] = [];
  let lastErr: unknown;
  for (const p of usable) {
    const key = resolveKey(settings, p)!;
    const model = modelFor(p);
    try {
      if (o.signal) await o.signal();
      await assertBudget(o.workspaceId, { workflowRunId: o.workflowRunId, runLimitUsd: o.runLimitUsd });
      let user = o.user;
      let inTok = 0, outTok = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await withRetry(() => adapters[p](key, { system, user, model, maxTokens: o.maxTokens ?? 4096, temperature: o.temperature, timeoutMs: settings.timeout_ms, json: true }));
        inTok += r.inputTokens || approxTokens(system + user); outTok += r.outputTokens || approxTokens(r.text);
        let parsed: { success: true; data: T } | { success: false; msg: string };
        try {
          const res = o.schema.safeParse(extractJson(r.text));
          parsed = res.success ? { success: true, data: res.data } : { success: false, msg: res.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
        } catch (e) { parsed = { success: false, msg: (e as Error).message }; }
        if (parsed.success) {
          const costUsd = estimateCost(pricing, p, model, inTok, outTok);
          const meta: AiMeta = { provider: p, model, demo: false, cacheHit: false, inputTokens: inTok, outputTokens: outTok, costUsd, fallbackFrom: failed.length ? failed : undefined };
          await logUsage(o, meta, 'ok', Date.now() - started);
          if (o.cache !== false) {
            await q(`INSERT INTO ai_cache(workspace_id, cache_key, task, response, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' hours')::interval)
                     ON CONFLICT (workspace_id, cache_key) DO UPDATE SET response=EXCLUDED.response, expires_at=EXCLUDED.expires_at`,
              [o.workspaceId, cacheKey, o.task, JSON.stringify(parsed.data), String(settings.cache_ttl_hours)]);
          }
          return { data: parsed.data, meta };
        }
        // Cho model một lần sửa lỗi định dạng
        user = `${o.user}\n\nLần trước bạn trả JSON sai schema (${parsed.msg}). Hãy trả lại JSON đúng schema, không thêm chữ nào khác.`;
      }
      throw new ProviderError('Model trả dữ liệu không đúng schema sau 2 lần thử');
    } catch (e) {
      if (e instanceof HttpError) throw e; // ngân sách / huỷ: không fallback sang provider khác
      lastErr = e;
      failed.push(p);
      await logUsage(o, { provider: p, model, demo: false, cacheHit: false, inputTokens: 0, outputTokens: 0, costUsd: 0 }, 'error', Date.now() - started, (e as Error).message);
    }
  }
  throw new HttpError(502, `Tất cả nhà cung cấp AI đều lỗi (${failed.join(', ')}): ${(lastErr as Error)?.message ?? ''}`, 'ai_failed');
}

/** Có thật sự gửi dữ liệu ra dịch vụ AI bên ngoài không? (dùng cho bước xin phê duyệt dữ liệu nhạy cảm) */
export async function willUseExternal(workspaceId: string): Promise<boolean> {
  if (env.demoMode) return false;
  const s = await getAiSettings(workspaceId);
  return [s.primary, ...s.fallback].some((p) => s.providers[p].enabled && resolveKey(s, p));
}

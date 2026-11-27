import type { ProviderId } from './settings';

export type LlmRequest = { system: string; user: string; model: string; maxTokens: number; temperature?: number; timeoutMs: number; json: boolean };
export type LlmResponse = { text: string; inputTokens: number; outputTokens: number };

export class ProviderError extends Error {
  constructor(message: string, public status?: number, public retryable = false) { super(message); }
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
      throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, retryable);
    }
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if ((e as Error).name === 'AbortError') throw new ProviderError('Hết thời gian chờ (timeout)', 408, true);
    throw new ProviderError(`Lỗi mạng: ${(e as Error).message}`, undefined, true);
  } finally { clearTimeout(t); }
}

type Adapter = (key: string, r: LlmRequest) => Promise<LlmResponse>;

// Endpoint/format theo tài liệu công khai của từng nhà cung cấp. CHƯA kiểm thử với khoá thật trong môi trường phát triển.
export const adapters: Record<ProviderId, Adapter> = {
  async anthropic(key, r) {
    const j = await post('https://api.anthropic.com/v1/messages',
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      { model: r.model, max_tokens: r.maxTokens, temperature: r.temperature ?? 0.7, system: r.system, messages: [{ role: 'user', content: r.user }] }, r.timeoutMs);
    const text = (j.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
    return { text, inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 };
  },
  async openai(key, r) {
    const j = await post('https://api.openai.com/v1/chat/completions', { authorization: `Bearer ${key}` },
      { model: r.model, max_tokens: r.maxTokens, temperature: r.temperature ?? 0.7,
        ...(r.json ? { response_format: { type: 'json_object' } } : {}),
        messages: [{ role: 'system', content: r.system }, { role: 'user', content: r.user }] }, r.timeoutMs);
    return { text: j.choices?.[0]?.message?.content ?? '', inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0 };
  },
  async gemini(key, r) {
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(r.model)}:generateContent`,
      { 'x-goog-api-key': key },
      { systemInstruction: { parts: [{ text: r.system }] }, contents: [{ role: 'user', parts: [{ text: r.user }] }],
        generationConfig: { maxOutputTokens: r.maxTokens, temperature: r.temperature ?? 0.7, ...(r.json ? { responseMimeType: 'application/json' } : {}) } }, r.timeoutMs);
    const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
    return { text, inputTokens: j.usageMetadata?.promptTokenCount ?? 0, outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0 };
  },
};

export async function testProvider(p: ProviderId, key: string, model: string) {
  const r = await adapters[p](key, { system: 'Trả lời đúng một từ.', user: 'Nói: OK', model, maxTokens: 16, timeoutMs: 20000, json: false });
  return { ok: true, sample: r.text.slice(0, 40), inputTokens: r.inputTokens, outputTokens: r.outputTokens };
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 600): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!(e instanceof ProviderError) || !e.retryable || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw last;
}

// Chạy thử với AI THẬT (có thể tốn phí / dùng hạn mức miễn phí). Server phải chạy với khoá trong biến môi trường
// (GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY). Dùng: PROVIDER=gemini MODEL=gemini-3.5-flash node tests/e2e/live-ai.mjs
const BASE = process.env.BASE ?? 'http://localhost:3100';
const PROVIDER = process.env.PROVIDER ?? 'gemini';
const MODEL = process.env.MODEL ?? 'gemini-3.5-flash';
const DAILY = process.env.SKIP_DAILY !== 'true';
const jar = new Map();
async function r(m, p, b) {
  const res = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.55.${Math.floor(Math.random() * 250)}.5`, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }, body: b === undefined ? undefined : JSON.stringify(b) });
  for (const sc of res.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  const t = await res.text(); try { return { s: res.status, j: JSON.parse(t) }; } catch { return { s: res.status, j: t }; }
}
const t0 = Date.now(); const lap = (x) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${x}`);
await r('POST', '/api/auth/register', { email: `live${Date.now()}@e2e.local`, password: 'password123', name: 'Ly Van' });
const mk = (p) => ({ enabled: p === PROVIDER, model: p === PROVIDER ? MODEL : 'x-unused' });
let s = await r('PUT', '/api/settings/ai', { primary: PROVIDER, fallback: [], cache_ttl_hours: 24, timeout_ms: 90000, providers: { anthropic: mk('anthropic'), openai: mk('openai'), gemini: mk('gemini') }, task_models: {} });
lap(`đặt provider: ${s.s} key_source=${s.j.providers?.[PROVIDER]?.key_source}`);
s = await r('POST', '/api/settings/ai/test', { provider: PROVIDER }); lap(`kiểm tra kết nối: ${JSON.stringify(s.j).slice(0, 300)}`);
s = await r('POST', '/api/keywords/expand', { roots: ['Biến hình'], count: 20 });
lap(`keywords: ${s.s} demo=${s.j.meta?.demo} provider=${s.j.meta?.provider} +${s.j.added} tok=${s.j.meta?.inputTokens}/${s.j.meta?.outputTokens} ${s.j.error ?? ''}`);
console.log('  ', (await r('GET', '/api/keywords')).j.items.filter((k) => k.source === 'ai').slice(0, 6).map((k) => `${k.keyword} [t${k.tier}/${k.language}]`).join(' | '));
s = await r('POST', '/api/ideas/generate', { count: 5 });
lap(`ideas: ${s.s} demo=${s.j.meta?.demo} lưu=${s.j.saved?.length} trùng=${s.j.duplicates?.length} ${s.j.error ?? ''}`);
const ideas = (await r('GET', '/api/ideas')).j.items;
console.log('  ', ideas.slice(0, 3).map((i) => `${i.title} (${i.total_score})`).join('\n   '));
if (ideas[0]) {
  s = await r('POST', `/api/ideas/${ideas[0].id}/produce`, { type: 'post' });
  lap(`bài viết: ${s.s} demo=${s.j.is_demo} ${s.j.error ?? ''}`);
  if (s.j.body) console.log('---\n' + s.j.title + '\nHOOK: ' + s.j.hooks?.join(' // ') + '\n' + s.j.body.slice(0, 700) + '\n---');
}
if (DAILY) {
  const run = await r('POST', '/api/workflows/daily/run', {}); lap(`daily: ${run.s} ${run.j.error ?? ''}`);
  let d; for (let i = 0; i < 150; i++) { d = (await r('GET', `/api/workflow-runs/${run.j.run_id}`)).j; if (['succeeded', 'failed', 'cancelled'].includes(d.run.status)) break; await new Promise((x) => setTimeout(x, 3000)); }
  lap(`daily kết thúc: ${d.run.status} demo=${d.run.is_demo} chi phí=$${d.usage.usd} token=${d.usage.tokens} lỗi=${d.run.error ?? '-'}`);
  for (const st of d.steps) console.log(`   ${st.step_no}. ${st.status} ${st.name} ${st.error ?? ''}`);
}
const u = (await r('GET', '/api/ai/usage')).j;
console.log('usage:', u.by_model.map((m) => `${m.provider}/${m.model} gọi=${m.calls} in=${m.input_tokens} out=${m.output_tokens}`).join(' ; '), '| lỗi:', u.items.filter((i) => i.status === 'error').map((i) => String(i.error).slice(0, 150)).slice(0, 3));

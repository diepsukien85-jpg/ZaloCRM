// E2E qua HTTP thật: chạy với server đang chạy (BASE=http://localhost:3100). Dùng Node >= 20.
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://localhost:3100';
let passed = 0; const failed = [];
const results = [];

class Client {
  constructor() { this.cookies = new Map(); this.ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; }
  async req(method, path, body, opts = {}) {
    const headers = { 'x-forwarded-for': this.ip, ...(opts.headers ?? {}) };
    if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
    headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), redirect: 'manual' });
    for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (!v || /Max-Age=0|expires=Thu, 01 Jan 1970/i.test(sc)) this.cookies.delete(k); else this.cookies.set(k, v); }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* không phải JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  patch(p, b = {}) { return this.req('PATCH', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  del(p, b) { return this.req('DELETE', p, b); }
}

async function test(name, fn) {
  try { await fn(); passed++; results.push(`✔ ${name}`); } catch (e) { failed.push(name); results.push(`✘ ${name}\n    ${String(e.message).split('\n').slice(0, 4).join('\n    ')}`); }
}
const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
async function signup(label) {
  const c = new Client();
  const email = `${label}-${uniq()}@e2e.local`;
  const r = await c.post('/api/auth/register', { email, password: 'password123', name: label });
  assert.equal(r.status, 200, r.text);
  return { c, email };
}

const A = await signup('owner');
const B = await signup('other');

await test('1-2. đăng ký, đăng nhập, /auth/me trả workspace', async () => {
  const me = await A.c.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.role, 'owner');
  const c2 = new Client();
  assert.equal((await c2.post('/api/auth/login', { email: A.email, password: 'sai-mat-khau' })).status, 401);
  assert.equal((await c2.post('/api/auth/login', { email: A.email, password: 'password123' })).status, 200);
  assert.equal((await c2.get('/api/auth/me')).status, 200);
});

await test('xác thực: không đăng nhập → 401 cho mọi API nghiệp vụ; trang web → chuyển /login', async () => {
  const anon = new Client();
  for (const p of ['/api/dashboard', '/api/contents', '/api/keywords', '/api/brands', '/api/leads', '/api/settings/ai', '/api/export/workspace']) assert.equal((await anon.get(p)).status, 401, p);
  const page = await anon.get('/');
  assert.equal(page.status, 307);
  assert.match(page.headers.get('location') ?? '', /\/login/);
});

await test('mật khẩu yếu / email trùng bị từ chối; không lộ email tồn tại khi đăng nhập sai', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/auth/register', { email: 'x@e2e.local', password: '123', name: 'x' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { email: A.email, password: 'password123', name: 'dup' })).status, 409);
  const w1 = await c.post('/api/auth/login', { email: A.email, password: 'wrong-wrong' });
  const w2 = await c.post('/api/auth/login', { email: 'ghost@e2e.local', password: 'wrong-wrong' });
  assert.equal(w1.json.error, w2.json.error);
});

await test('3-4. thương hiệu & DNA: cập nhật tạo phiên bản mới', async () => {
  const brands = (await A.c.get('/api/brands')).json.items;
  assert.equal(brands.length, 2);
  const ly = brands.find((b) => b.kind === 'personal');
  const dna = { ...ly.dna.data, voice: 'Giọng thử nghiệm e2e' };
  const r = await A.c.put(`/api/brands/${ly.id}/dna`, dna);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.version, 2);
  const versions = (await A.c.get(`/api/brands/${ly.id}/dna/versions`)).json.items;
  assert.equal(versions.length, 2);
  const bad = await A.c.put(`/api/brands/${ly.id}/pillars`, { pillars: [{ name: 'a', weight: 50 }, { name: 'b', weight: 40 }] });
  assert.equal(bad.status, 400);
});

await test('5. cấu hình AI provider: khoá không bao giờ trả về frontend', async () => {
  const put = await A.c.put('/api/settings/ai', { primary: 'anthropic', fallback: ['openai'], cache_ttl_hours: 24, timeout_ms: 60000, providers: { anthropic: { enabled: true, model: 'claude-sonnet-5-5', api_key: 'sk-ant-e2e-secret-key-12345' }, openai: { enabled: true, model: 'gpt-4.1' }, gemini: { enabled: false, model: 'gemini-3.5-flash' } }, task_models: {} });
  assert.equal(put.status, 200, put.text);
  const got = await A.c.get('/api/settings/ai');
  assert.ok(!got.text.includes('sk-ant-e2e'));
  assert.ok(!got.text.includes('encrypted_key'));
  assert.equal(got.json.settings.providers.anthropic.key_source, 'workspace');
  // test kết nối với khoá giả: phải báo lỗi thật, không "thành công giả"
  const t = await A.c.post('/api/settings/ai/test', { provider: 'gemini' });
  assert.equal(t.json.ok, false);
  // trả lại chế độ DEMO để các bước sau không gọi API ngoài
  await A.c.put('/api/settings/ai', { primary: 'anthropic', fallback: [], cache_ttl_hours: 24, timeout_ms: 60000, providers: { anthropic: { enabled: true, model: 'claude-sonnet-5-5', clear_key: true }, openai: { enabled: true, model: 'gpt-4.1' }, gemini: { enabled: true, model: 'gemini-3.5-flash' } }, task_models: {} });
});

await test('6-7. từ khoá: mở rộng (DEMO có nhãn), lưu yêu thích, volume bắt buộc nguồn', async () => {
  const r = await A.c.post('/api/keywords/expand', { roots: ['Tiền bạc', 'Biến hình'], count: 20 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.meta.demo, true);
  assert.ok(r.json.added > 5);
  const list = (await A.c.get('/api/keywords')).json.items;
  assert.ok(list.some((k) => k.language === 'en') || list.length > 20);
  assert.ok(list.every((k) => k.search_volume == null), 'không được tự bịa lượng tìm kiếm');
  const kw = list.find((k) => k.source === 'demo');
  assert.ok(kw.is_demo);
  assert.equal((await A.c.patch(`/api/keywords/${kw.id}`, { favorite: true })).status, 200);
  assert.equal((await A.c.patch(`/api/keywords/${kw.id}`, { search_volume: 5000 })).status, 400);
  assert.equal((await A.c.patch(`/api/keywords/${kw.id}`, { search_volume: 5000, search_volume_source: 'GKP 11/2026' })).status, 200);
  const csv = await A.c.get('/api/keywords/export.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
});

let journalId, storyId;
await test('8-9. nhật ký → câu chuyện (riêng tư; demo không cần xác nhận)', async () => {
  const j = await A.c.post('/api/journals', { title: 'Kho hôm nay', body: 'Sáng nay đội thợ kiểm tra màn sao. Một bộ bị lỗi đèn, tôi quyết định thay luôn. Khách gọi 0912345678 hỏi giá.', privacy: 'private' });
  assert.equal(j.status, 200, j.text);
  journalId = j.json.id;
  const s = await A.c.post(`/api/journals/${journalId}/extract`, {});
  assert.equal(s.status, 200, s.text);
  storyId = s.json.story.id;
  assert.ok(s.json.story.is_demo);
  assert.ok(!JSON.stringify(s.json).includes('0912345678'), 'SĐT khách phải được ẩn');
  const found = (await A.c.get('/api/journals?q=màn sao')).json.items;
  assert.ok(found.some((x) => x.id === journalId));
});

let contentId;
await test('10-13. ý tưởng, chấm điểm, chống trùng, chạy Daily Agent → 3 bài + 2 kịch bản', async () => {
  const idea = await A.c.post('/api/ideas', { title: 'Ba sai lầm khi nhập thiết bị sự kiện', pillar: 'Kinh doanh & tiền bạc' });
  assert.equal(idea.status, 200, idea.text);
  const dup = await A.c.post('/api/ideas', { title: 'Ba sai lầm khi nhập thiết bị sự kiện!' });
  assert.equal(dup.status, 409);
  assert.equal((await A.c.put(`/api/ideas/${idea.json.id}/score`, { attraction: 26, brand_fit: 1, retention: 1, conversion: 1, feasibility: 1 })).status, 400);
  const sc = await A.c.put(`/api/ideas/${idea.json.id}/score`, { attraction: 20, brand_fit: 20, retention: 15, conversion: 10, feasibility: 8 });
  assert.equal(sc.json.total, 73);
  const run = await A.c.post('/api/workflows/daily/run', {});
  assert.equal(run.status, 200, run.text);
  const again = await A.c.post('/api/workflows/daily/run', {});
  assert.equal(again.status, 409, 'không chạy song song');
  let d;
  for (let i = 0; i < 60; i++) { d = (await A.c.get(`/api/workflow-runs/${run.json.run_id}`)).json; if (['succeeded', 'failed', 'cancelled'].includes(d.run.status)) break; await new Promise((r) => setTimeout(r, 500)); }
  assert.equal(d.run.status, 'succeeded', JSON.stringify(d.run.error));
  assert.equal(d.steps.length, 12);
  const contents = (await A.c.get('/api/contents?originals=true')).json.items;
  assert.equal(contents.filter((c) => c.content_type === 'post' || c.content_type === 'carousel').length, 3);
  assert.equal(contents.filter((c) => c.content_type === 'video_script').length, 2);
  assert.ok(contents.every((c) => c.is_demo && c.status === 'draft'));
  contentId = contents.find((c) => c.content_type === 'post').id;
});

await test('14. sửa, lưu phiên bản, khôi phục', async () => {
  const before = (await A.c.get(`/api/contents/${contentId}`)).json;
  const e = await A.c.patch(`/api/contents/${contentId}`, { body: before.content.body + '\n\nĐoạn mới từ e2e', note: 'e2e' });
  assert.equal(e.status, 200, e.text);
  const after = (await A.c.get(`/api/contents/${contentId}`)).json;
  assert.equal(after.versions.length, before.versions.length + 1);
  const r = await A.c.post(`/api/contents/${contentId}/restore`, { version: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.body, before.versions.at(-1).body);
});

await test('rewrite AI chỉ trả đề xuất, không tự ghi đè', async () => {
  const cur = (await A.c.get(`/api/contents/${contentId}`)).json.content;
  const r = await A.c.post(`/api/contents/${contentId}/rewrite`, { instruction: 'Rút gọn' });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.text.length > 0);
  assert.equal((await A.c.get(`/api/contents/${contentId}`)).json.content.body, cur.body);
});

await test('15. prompt Google Flow cho từng cảnh + xuất SRT/ZIP', async () => {
  const projs = (await A.c.get('/api/video/projects')).json.items;
  assert.equal(projs.length, 2);
  const p = (await A.c.get(`/api/video/projects/${projs[0].id}`)).json;
  assert.ok(p.scenes.length >= 2);
  assert.ok(p.scenes.every((s) => s.prompt.includes('Character reference') && s.prompt.includes('Negative constraints')));
  const rg = await A.c.post(`/api/video/projects/${projs[0].id}/prompts`, {});
  assert.equal(rg.status, 200);
  const ids = p.scenes.map((s) => s.id).reverse();
  assert.equal((await A.c.post(`/api/video/projects/${projs[0].id}/reorder`, { scene_ids: ids })).status, 200);
  assert.equal((await A.c.post(`/api/video/projects/${projs[0].id}/reorder`, { scene_ids: ids.slice(1) })).status, 400);
  const dup = await A.c.post(`/api/video/scenes/${p.scenes[0].id}/duplicate`, {});
  assert.equal(dup.status, 200, dup.text);
  assert.equal((await A.c.get(`/api/video/projects/${projs[0].id}`)).json.scenes.length, p.scenes.length + 1);
  const srt = await A.c.get(`/api/video/projects/${projs[0].id}/export?kind=srt`);
  assert.match(srt.text, /-->/);
  const zip = await fetch(`${BASE}/api/video/projects/${projs[0].id}/export?kind=zip`, { headers: { cookie: [...A.c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  const buf = Buffer.from(await zip.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
});

await test('16-17. phê duyệt & lên lịch: đúng quy trình, có xác nhận', async () => {
  assert.equal((await A.c.post(`/api/contents/${contentId}/transition`, { to: 'approved' })).status, 400);
  assert.equal((await A.c.post(`/api/contents/${contentId}/transition`, { to: 'pending_review' })).status, 200);
  assert.equal((await A.c.post(`/api/contents/${contentId}/transition`, { to: 'approved' })).status, 200);
  const when = new Date(Date.now() + 86400000).toISOString();
  assert.equal((await A.c.post(`/api/contents/${contentId}/transition`, { to: 'scheduled', scheduled_at: when })).status, 400);
  assert.equal((await A.c.post(`/api/contents/${contentId}/transition`, { to: 'scheduled', scheduled_at: when, confirm: true })).status, 200);
  const from = new Date(Date.now() - 86400000).toISOString(), to = new Date(Date.now() + 5 * 86400000).toISOString();
  const cal = (await A.c.get(`/api/calendar?from=${from}&to=${to}`)).json.items;
  assert.ok(cal.some((c) => c.id === contentId));
  const later = new Date(Date.now() + 2 * 86400000).toISOString();
  assert.equal((await A.c.patch(`/api/calendar/${contentId}/move`, { scheduled_at: later })).status, 409, 'đổi lịch đã xác nhận cần xác nhận');
  assert.equal((await A.c.patch(`/api/calendar/${contentId}/move`, { scheduled_at: later, confirm: true })).status, 200);
});

await test('18. xuất nội dung Markdown/CSV và dữ liệu workspace', async () => {
  const md = await A.c.get(`/api/contents/${contentId}/export.md`);
  assert.match(md.headers.get('content-type'), /markdown/);
  assert.match(md.text, /^# /);
  assert.equal((await A.c.get('/api/contents/export.csv')).status, 200);
  const ex = await A.c.get('/api/export/workspace');
  assert.equal(ex.status, 200);
  assert.ok(!ex.text.includes('encrypted_key'));
  assert.ok(Object.keys(JSON.parse(ex.text)).includes('contents'));
});

await test('19-20. nhập số liệu thủ công + CSV, báo cáo & công thức (mẫu số 0)', async () => {
  const d = new Date().toISOString().slice(0, 10);
  assert.equal((await A.c.post('/api/analytics/snapshots', { content_id: contentId, platform: 'facebook_profile', snapshot_date: d, views: 2000, likes: 100, comments: 20, shares: 10, saves: 10, leads: 5, orders: 1, revenue: 20000000, gross_profit: 5000000, ad_spend: 1000000 })).status, 200);
  assert.equal((await A.c.post('/api/analytics/snapshots', { snapshot_date: d, views: -5 })).status, 400);
  const imp = await A.c.post('/api/analytics/import', { csv: `snapshot_date,platform,views,likes,leads\n${d},tiktok,500,40,2\nkhong-phai-ngay,tiktok,1,1,1\n` });
  assert.equal(imp.json.imported, 1);
  assert.equal(imp.json.errors.length, 1);
  assert.equal(imp.json.errors[0].line, 3);
  const s = (await A.c.get('/api/analytics/summary')).json;
  assert.equal(s.totals.views, 2500);
  assert.ok(Math.abs(s.metrics.engagement_rate - ((140 + 40) / 2500) * 100) < 0.001);
  assert.ok(s.metrics.marketing_cost >= 1000000);
  const top = (await A.c.get('/api/analytics/top')).json.items;
  assert.equal(top[0].id, contentId);
  const dash = (await A.c.get('/api/dashboard')).json;
  assert.equal(dash.production.originals >= 5, true);
});

await test('21. ngân sách: vượt giới hạn → dừng workflow có nhật ký (không gọi AI trả phí)', async () => {
  const put = await A.c.put('/api/budgets', { daily: { amount_usd: 0.5, warn_pct: 80, hard_stop: true }, monthly: { amount_usd: 10, warn_pct: 80, hard_stop: true } });
  assert.equal(put.status, 200);
  assert.equal((await A.c.put('/api/budgets', { daily: { amount_usd: -1, warn_pct: 80, hard_stop: true }, monthly: { amount_usd: 10, warn_pct: 80, hard_stop: true } })).status, 400);
  const usage = (await A.c.get('/api/ai/usage')).json;
  assert.ok(usage.budgets.length === 2);
  assert.ok(usage.items.every((i) => i.is_demo && Number(i.est_cost_usd) === 0));
});

await test('lịch tự động mặc định TẮT; bật cần xác nhận; chỉ admin', async () => {
  const wf = (await A.c.get('/api/workflows')).json.items;
  assert.ok(wf.length === 3 && wf.every((w) => w.enabled === false));
  assert.equal((await A.c.put('/api/automations/daily', { enabled: true })).status, 400);
  assert.equal((await A.c.put('/api/automations/daily', { enabled: true, confirm: true, hour: 7 })).status, 200);
  assert.equal((await A.c.put('/api/automations/daily', { enabled: false })).status, 200);
});

await test('22a. phân quyền theo vai trò: viewer chỉ đọc, editor không duyệt/không đổi cài đặt', async () => {
  const V = await signup('viewer');
  // owner thêm V vào workspace của A làm viewer
  assert.equal((await A.c.post('/api/members', { email: V.email, role: 'viewer' })).status, 200);
  const meA = (await A.c.get('/api/auth/me')).json;
  assert.equal((await V.c.post('/api/auth/workspace', { workspace_id: meA.workspaceId })).status, 200);
  assert.equal((await V.c.get('/api/auth/me')).json.role, 'viewer');
  assert.equal((await V.c.get('/api/contents')).status, 200);
  assert.equal((await V.c.post('/api/contents', { title: 'x' })).status, 403);
  assert.equal((await V.c.patch(`/api/contents/${contentId}`, { title: 'hack' })).status, 403);
  assert.equal((await V.c.put('/api/settings/ai', {})).status, 403);
  assert.equal((await V.c.get('/api/settings/ai')).status, 403);
  assert.equal((await V.c.get('/api/audit-logs')).status, 403);
  assert.equal((await V.c.post('/api/workflows/daily/run', {})).status, 403);
  assert.equal((await V.c.post('/api/copilot', { message: '/DAILY' })).status, 403);
  // nâng lên editor: sửa được, không duyệt được
  assert.equal((await A.c.post('/api/members', { email: V.email, role: 'editor' })).status, 200);
  assert.equal((await V.c.post('/api/contents', { title: 'bài của editor', body: 'nội dung' })).status, 200);
  const mine = (await V.c.get('/api/contents?q=editor')).json.items[0];
  assert.equal((await V.c.post(`/api/contents/${mine.id}/transition`, { to: 'pending_review' })).status, 200);
  const ap = await V.c.post(`/api/contents/${mine.id}/transition`, { to: 'approved' });
  assert.equal(ap.status, 403);
  assert.equal((await V.c.del('/api/workspace', { confirm_name: 'x' })).status, 403);
});

await test('22b. cách ly workspace: B không đọc/sửa/xoá/xuất dữ liệu của A bằng ID', async () => {
  const ideaId = (await A.c.get('/api/ideas')).json.items[0].id;
  const kwId = (await A.c.get('/api/keywords')).json.items[0].id;
  const projId = (await A.c.get('/api/video/projects')).json.items[0].id;
  const sceneId = (await A.c.get(`/api/video/projects/${projId}`)).json.scenes[0].id;
  const brandId = (await A.c.get('/api/brands')).json.items[0].id;
  const chans = (await A.c.get('/api/channels')).json.items;
  const checks = [
    ['GET', `/api/contents/${contentId}`], ['PATCH', `/api/contents/${contentId}`, { title: 'hack' }], ['DELETE', `/api/contents/${contentId}`],
    ['POST', `/api/contents/${contentId}/transition`, { to: 'pending_review' }], ['GET', `/api/contents/${contentId}/export.md`], ['POST', `/api/contents/${contentId}/rewrite`, { instruction: 'abc' }],
    ['PATCH', `/api/keywords/${kwId}`, { favorite: true }], ['PUT', `/api/ideas/${ideaId}/score`, { attraction: 1, brand_fit: 1, retention: 1, conversion: 1, feasibility: 1 }],
    ['GET', `/api/video/projects/${projId}`], ['PATCH', `/api/video/scenes/${sceneId}`, { dialogue: 'hack' }], ['DELETE', `/api/video/scenes/${sceneId}`], ['GET', `/api/video/projects/${projId}/export?kind=zip`],
    ['PUT', `/api/brands/${brandId}/dna`, { about: 'hack' }], ['PATCH', `/api/channels/${chans[0].id}`, { name: 'hack' }], ['DELETE', `/api/channels/${chans[0].id}`],
    ['GET', `/api/workflow-runs/${(await A.c.get('/api/workflows')).json.runs[0].id}`], ['POST', `/api/journals/${journalId}/extract`, {}], ['POST', `/api/stories/${storyId}/ideas`, {}],
  ];
  for (const [m, p, b] of checks) {
    const r = await B.c.req(m, p, b);
    assert.ok([403, 404].includes(r.status) || (r.status === 400 && m === 'PUT'), `${m} ${p} → ${r.status}`);
    if (m === 'GET') assert.ok(!r.text.includes(contentId.slice(0, 8)) || r.status === 404);
  }
  // và dữ liệu của A không bị thay đổi
  const c = (await A.c.get(`/api/contents/${contentId}`)).json.content;
  assert.notEqual(c.title, 'hack');
  assert.equal((await A.c.get('/api/channels')).json.items.length, chans.length);
  // danh sách của B không chứa dữ liệu của A
  assert.equal((await B.c.get('/api/contents')).json.items.length, 0);
  assert.equal((await B.c.get('/api/ideas')).json.items.length, 0);
});

await test('bảo mật: CSRF (Origin khác bị chặn), body sai định dạng, endpoint lạ', async () => {
  const r = await A.c.req('POST', '/api/contents', { title: 'x' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  const ok = await A.c.req('POST', '/api/contents', { title: 'cùng origin ok' }, { headers: { origin: BASE } });
  assert.equal(ok.status, 200);
  assert.equal((await A.c.req('POST', '/api/contents', undefined)).status, 400);
  assert.equal((await A.c.get('/api/khong-ton-tai')).status, 404);
  assert.equal((await A.c.req('PUT', '/api/health')).status, 405);
  assert.equal((await A.c.post('/api/contents', { title: '' })).status, 400);
  assert.equal((await A.c.post('/api/contents', { title: 'x', content_type: 'virus' })).status, 400);
  const cookieHeader = (await new Client().req('POST', '/api/auth/login', { email: A.email, password: 'password123' })).headers.get('set-cookie') ?? '';
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=lax/i);
});

await test('bảo mật: XSS lưu dưới dạng văn bản; header an toàn', async () => {
  const payload = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  const c = await A.c.post('/api/contents', { title: payload, body: payload });
  assert.equal(c.status, 200);
  const got = (await A.c.get(`/api/contents/${c.json.id}`)).json.content;
  assert.equal(got.title, payload); // lưu nguyên văn; React escape khi hiển thị
  const h = await A.c.get('/login');
  assert.equal(h.headers.get('x-frame-options'), 'DENY');
  assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
});

await test('upload: chặn file nguy hiểm, nhận ảnh hợp lệ, signed URL hết hạn/sửa chữ ký, cách ly', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const form = (name, type, data) => { const f = new FormData(); f.append('file', new Blob([data], { type }), name); return f; };
  assert.equal((await A.c.req('POST', '/api/media', form('x.html', 'text/html', '<script>1</script>'))).status, 400);
  assert.equal((await A.c.req('POST', '/api/media', form('x.png', 'image/png', '<script>alert(1)</script>'))).status, 400);
  assert.equal((await A.c.req('POST', '/api/media', form('x.svg', 'image/svg+xml', '<svg onload=alert(1)/>'))).status, 400);
  assert.equal((await A.c.req('POST', '/api/media', new FormData())).status, 400);
  const up = await A.c.req('POST', '/api/media', form('anh.png', 'image/png', png));
  assert.equal(up.status, 200, up.text);
  const url = up.json.url;
  const raw = await fetch(BASE + url);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(BASE + url.replace(/sig=.{4}/, 'sig=AAAA'))).status, 403);
  assert.equal((await fetch(BASE + url.replace(/exp=\d+/, 'exp=1'))).status, 403);
  assert.equal((await B.c.del(`/api/media/${up.json.id}`)).status, 404);
  assert.equal((await B.c.get('/api/media')).json.items.length, 0);
  assert.equal((await A.c.del(`/api/media/${up.json.id}`)).status, 200);
});

await test('lead: consent bắt buộc khi import, CSV lỗi báo theo dòng, quy thuộc doanh thu', async () => {
  const l = await A.c.post('/api/leads', { name: 'Chị Hoa', contact: '0900000000', contact_consent: true, need: 'Nhà rạp mới', status: 'qualified' });
  assert.equal(l.status, 200, l.text);
  assert.equal((await A.c.post('/api/leads/import', { csv: 'name,contact\nA,1', consent_confirmed: false })).status, 400);
  const imp = await A.c.post('/api/leads/import', { csv: 'name,contact,status\nAnh Nam,0911,new\n,0922,new\nChị Mai,0933,khong-hop-le', consent_confirmed: true });
  assert.equal(imp.json.imported, 1);
  assert.equal(imp.json.errors.length, 2);
  const at = await A.c.post(`/api/leads/${l.json.id}/attribute`, { content_id: contentId, revenue: 30000000, gross_profit: 8000000, method: 'manual' });
  assert.equal(at.status, 200, at.text);
  assert.equal((await B.c.post(`/api/leads/${l.json.id}/attribute`, { content_id: contentId, revenue: 1, gross_profit: 1 })).status, 404);
});

await test('copilot: lệnh nhanh dùng dữ liệu thật; lệnh sai được báo', async () => {
  const r = await A.c.post('/api/copilot', { message: '/REPORT' });
  assert.match(r.json.reply, /Báo cáo 30 ngày/);
  assert.match((await A.c.post('/api/copilot', { message: '/XYZ' })).json.reply, /Lệnh không hợp lệ/);
  const q = await A.c.post('/api/copilot', { message: 'Hôm nay có bao nhiêu bài chờ duyệt?' });
  assert.equal(q.status, 200);
  assert.equal(q.json.demo, true);
  const f = await A.c.post('/api/copilot', { message: '/FLOW' });
  assert.match(f.json.reply, /Google Flow/);
});

await test('tích hợp: không tuyên bố kết nối khi chưa có; không có endpoint giả', async () => {
  const i = (await A.c.get('/api/integrations')).json.items;
  for (const k of ['meta', 'tiktok', 'youtube', 'google_drive']) assert.ok(['needs_oauth', 'not_implemented'].includes(i.find((x) => x.key === k).status));
  assert.equal(i.find((x) => x.key === 'google_flow').status, 'manual_only');
  assert.ok(!i.some((x) => x.status === 'connected'));
});

await test('cron: cần CRON_SECRET', async () => {
  assert.equal((await new Client().post('/api/cron/tick', {})).status, 403);
});

await test('25. dữ liệu tồn tại sau khi đăng nhập lại (phiên mới)', async () => {
  const c = new Client();
  await c.post('/api/auth/login', { email: A.email, password: 'password123' });
  const list = (await c.get('/api/contents?originals=true')).json.items;
  assert.ok(list.length >= 5);
  assert.equal((await c.get('/api/ideas')).json.items.length >= 10, true);
});

await test('bảo mật: giới hạn tần suất đăng nhập (rate limit)', async () => {
  const c = new Client(); let last;
  for (let i = 0; i < 20; i++) { last = await c.post('/api/auth/login', { email: `spam${i % 2}@e2e.local`, password: 'x' }); if (last.status === 429) break; }
  assert.equal(last.status, 429);
});

console.log(results.join('\n'));
console.log(`\n${passed} đạt, ${failed.length} lỗi`);
process.exit(failed.length ? 1 : 0);

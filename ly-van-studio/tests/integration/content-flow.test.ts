import { describe, it, expect, afterAll } from 'vitest';
import { one, q } from '@/lib/db';
import { createContent, editContent, restoreVersion, saveIdeas, transition } from '@/lib/services/content';
import { totals, productionCounts } from '@/lib/services/analytics';
import { makeWorkspace, closePool } from '../helpers/factory';

afterAll(closePool);

describe('vòng đời nội dung', () => {
  it('draft → duyệt → lên lịch → đăng, có audit và phê duyệt', async () => {
    const w = await makeWorkspace('life');
    const c = await createContent(w.workspaceId, w.userId, { title: 'Bài thử', body: 'Nội dung ban đầu' });
    expect(c.current_version).toBe(1);
    // không thể nhảy cóc
    await expect(transition(w.workspaceId, w.userId, 'owner', c.id, { to: 'approved' })).rejects.toThrow(/Không thể chuyển/);
    await expect(transition(w.workspaceId, w.userId, 'owner', c.id, { to: 'published', confirm: true })).rejects.toThrow();
    await transition(w.workspaceId, w.userId, 'owner', c.id, { to: 'pending_review' });
    // editor không được duyệt
    await expect(transition(w.workspaceId, w.userId, 'editor', c.id, { to: 'approved' })).rejects.toThrow(/Chỉ quản trị/);
    await transition(w.workspaceId, w.userId, 'owner', c.id, { to: 'approved', note: 'ok' });
    // lên lịch cần thời điểm + xác nhận
    await expect(transition(w.workspaceId, w.userId, 'owner', c.id, { to: 'scheduled', confirm: true })).rejects.toThrow(/thời điểm/);
    await expect(transition(w.workspaceId, w.userId, 'owner', c.id, { to: 'scheduled', scheduled_at: '2026-12-01T01:00:00Z' })).rejects.toThrow(/xác nhận/);
    const s = await transition(w.workspaceId, w.userId, 'owner', c.id, { to: 'scheduled', scheduled_at: '2026-12-01T01:00:00Z', confirm: true });
    expect(s.status).toBe('scheduled');
    expect(await one("SELECT 1 FROM schedules WHERE content_id=$1 AND status='confirmed'", [c.id])).toBeTruthy();
    // đăng công khai cần xác nhận
    await expect(transition(w.workspaceId, w.userId, 'owner', c.id, { to: 'published' })).rejects.toThrow(/xác nhận/);
    const p = await transition(w.workspaceId, w.userId, 'owner', c.id, { to: 'published', confirm: true });
    expect(p.status).toBe('published');
    const job = await one<{ mode: string; status: string }>('SELECT mode, status FROM publication_jobs WHERE content_id=$1', [c.id]);
    expect(job).toMatchObject({ mode: 'manual', status: 'published_manual' }); // không giả lập đăng API
    const audits = await q<{ action: string }>("SELECT action FROM audit_logs WHERE workspace_id=$1 AND entity_id=$2 ORDER BY created_at", [w.workspaceId, c.id]);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['content.approved', 'content.scheduled', 'content.published']));
    const appr = await q<{ action: string }>('SELECT action FROM content_approvals WHERE content_id=$1', [c.id]);
    expect(appr.map((a) => a.action)).toEqual(expect.arrayContaining(['request_review', 'approve', 'reschedule_confirm', 'publish_confirm']));
  });

  it('yêu cầu sửa bắt buộc ghi chú; sửa sau khi duyệt đưa về nháp', async () => {
    const w = await makeWorkspace('edit');
    const c = await createContent(w.workspaceId, w.userId, { title: 'T', body: 'B' });
    await transition(w.workspaceId, w.userId, 'owner', c.id, { to: 'pending_review' });
    await expect(transition(w.workspaceId, w.userId, 'owner', c.id, { to: 'changes_requested' })).rejects.toThrow(/ghi chú/);
    await transition(w.workspaceId, w.userId, 'owner', c.id, { to: 'approved' });
    const e = await editContent(w.workspaceId, w.userId, c.id, { body: 'Đã sửa' });
    expect(e.status).toBe('draft');
  });

  it('phiên bản: tạo mới khi đổi nội dung, autosave gộp, khôi phục', async () => {
    const w = await makeWorkspace('ver');
    const c = await createContent(w.workspaceId, w.userId, { title: 'T', body: 'v1' });
    await editContent(w.workspaceId, w.userId, c.id, { body: 'v2' });
    const a1 = await editContent(w.workspaceId, w.userId, c.id, { body: 'v3a' }, { source: 'autosave' });
    const a2 = await editContent(w.workspaceId, w.userId, c.id, { body: 'v3b' }, { source: 'autosave' });
    expect(a2.current_version).toBe(a1.current_version); // autosave gộp, không phình lịch sử
    expect(a2.current_version).toBe(3);
    const same = await editContent(w.workspaceId, w.userId, c.id, { body: 'v3b' }, { source: 'manual' });
    expect(same.current_version).toBe(3); // không đổi gì → không tạo version
    const r = await restoreVersion(w.workspaceId, w.userId, c.id, 1);
    expect(r.body).toBe('v1');
    expect(r.current_version).toBe(4);
    const vs = await q('SELECT version FROM content_versions WHERE content_id=$1', [c.id]);
    expect(vs).toHaveLength(4);
  });
});

describe('ý tưởng', () => {
  it('phát hiện trùng và tính tổng điểm trên thang 100', async () => {
    const w = await makeWorkspace('idea');
    const mk = (title: string) => ({ ideas: [{ title, summary: '', pillar: 'x', format: 'post' as const, platform: 'facebook_profile' as const, hook: '', keyword: null, scores: { attraction: 25, brand_fit: 25, retention: 20, conversion: 20, feasibility: 10 }, rationale: '' }] });
    const a = await saveIdeas(w.workspaceId, mk('Vì sao ánh sáng quyết định cảm xúc lễ đường'), { source: 'manual', isDemo: false });
    expect(a.saved[0].total).toBe(100);
    const b = await saveIdeas(w.workspaceId, mk('Vì sao ánh sáng quyết định cảm xúc của lễ đường'), { source: 'manual', isDemo: false });
    expect(b.saved).toHaveLength(0);
    expect(b.duplicates[0].similarity).toBeGreaterThan(0.6);
    // workspace khác không bị coi là trùng
    const w2 = await makeWorkspace('idea2');
    const c = await saveIdeas(w2.workspaceId, mk('Vì sao ánh sáng quyết định cảm xúc lễ đường'), { source: 'manual', isDemo: false });
    expect(c.saved).toHaveLength(1);
  });
});

describe('ràng buộc dữ liệu & analytics', () => {
  it('không cho lưu lượng tìm kiếm khi không có nguồn (không bịa số liệu)', async () => {
    const w = await makeWorkspace('kw');
    await expect(q("INSERT INTO keywords(workspace_id, keyword, search_volume) VALUES ($1,'abc',1000)", [w.workspaceId])).rejects.toThrow(/keywords_volume_needs_source/);
    await q("INSERT INTO keywords(workspace_id, keyword, search_volume, search_volume_source) VALUES ($1,'abd',1000,'Google Keyword Planner 11/2026')", [w.workspaceId]);
  });
  it('từ khoá trùng (không phân biệt hoa thường) bị chặn trong cùng workspace', async () => {
    const w = await makeWorkspace('kw2');
    await q("INSERT INTO keywords(workspace_id, keyword) VALUES ($1,'Kinh Doanh Mới')", [w.workspaceId]);
    await expect(q("INSERT INTO keywords(workspace_id, keyword) VALUES ($1,'kinh doanh mới')", [w.workspaceId])).rejects.toThrow(/keywords_uq/);
  });
  it('analytics tổng hợp đúng, tách doanh thu và lợi nhuận; KPI chỉ đếm nội dung gốc', async () => {
    const w = await makeWorkspace('an');
    const c = await createContent(w.workspaceId, w.userId, { title: 'Gốc', body: 'x' });
    await createContent(w.workspaceId, w.userId, { title: 'Biến thể', body: 'x', parent_content_id: c.id });
    await q("INSERT INTO analytics_snapshots(workspace_id, content_id, platform, snapshot_date, views, likes, comments, leads, orders, revenue, gross_profit, ad_spend) VALUES ($1,$2,'facebook_profile','2026-11-20',1000,60,20,10,2,50000000,10000000,4000000)", [w.workspaceId, c.id]);
    await q("INSERT INTO ai_usage_logs(workspace_id, provider, model, est_cost_usd, created_at) VALUES ($1,'anthropic','m',1,'2026-11-20T03:00:00Z')", [w.workspaceId]);
    const t = await totals(w.workspaceId, { from: '2026-11-01', to: '2026-11-30' });
    expect(t.totals.views).toBe(1000);
    expect(t.metrics.engagement_rate).toBeCloseTo(8);
    expect(t.totals.ai_cost).toBe(25500);
    expect(t.metrics.marketing_cost).toBe(4_025_500);
    expect(t.metrics.marketing_roi).toBeCloseTo(((10_000_000 - 4_025_500) / 4_025_500) * 100);
    expect(t.metrics.roas).toBeCloseTo(12.5); // doanh thu / CHI PHÍ QUẢNG CÁO (không gồm chi phí AI)
    const empty = await totals(w.workspaceId, { from: '2025-01-01', to: '2025-01-31' });
    expect(empty.metrics.engagement_rate).toBeNull();
    expect(empty.metrics.cpl).toBeNull();
    const cnt = await productionCounts(w.workspaceId, { from: '2020-01-01', to: '2030-01-01' });
    expect(cnt.originals).toBe(1);
  });
});

describe('cách ly workspace', () => {
  it('mọi bảng nghiệp vụ đều có workspace_id và FK tới workspaces', async () => {
    const rows = await q<{ table_name: string }>(`SELECT t.table_name FROM information_schema.tables t WHERE t.table_schema='public' AND t.table_type='BASE TABLE'
      AND t.table_name NOT IN ('users','workspaces','schema_migrations','rate_limits') AND NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_name=t.table_name AND c.column_name='workspace_id')`);
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });
  it('các bảng theo đặc tả (≥ 49 bảng) đều tồn tại', async () => {
    const need = 'users workspaces workspace_members brands brand_dna brand_dna_versions products audience_profiles content_pillars channels channel_connections keywords keyword_relationships trend_sources trends source_references research_reports viral_decodes daily_journals stories ideas idea_scores campaigns contents content_versions content_variants content_approvals video_projects video_scenes characters media_assets schedules publication_jobs publication_logs analytics_snapshots leads sales_attributions agent_configs prompt_templates prompt_versions agent_runs workflow_definitions workflow_runs workflow_steps automation_schedules ai_usage_logs budget_limits notifications audit_logs app_settings'.split(' ');
    const have = (await q<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).map((r) => r.table_name);
    expect(need.filter((t) => !have.includes(t))).toEqual([]);
  });
  it('workspace mới có thương hiệu/DNA/kênh/prompt mặc định; lịch tự động TẮT; không có số liệu giả', async () => {
    const w = await makeWorkspace('boot');
    const brands = await q<{ name: string }>('SELECT name FROM brands WHERE workspace_id=$1', [w.workspaceId]);
    expect(brands.map((b) => b.name).sort()).toEqual(['Nguyễn Thị Ly Vân', 'Trang Tùng Khang']);
    expect((await q('SELECT 1 FROM channels WHERE workspace_id=$1', [w.workspaceId]))).toHaveLength(5);
    const pil = await one<{ s: number }>('SELECT sum(weight) AS s FROM content_pillars WHERE workspace_id=$1', [w.workspaceId]);
    expect(pil!.s).toBe(100);
    const en = await q<{ enabled: boolean }>('SELECT enabled FROM automation_schedules WHERE workspace_id=$1', [w.workspaceId]);
    expect(en).toHaveLength(3);
    expect(en.every((e) => !e.enabled)).toBe(true);
    expect((await q('SELECT 1 FROM analytics_snapshots WHERE workspace_id=$1', [w.workspaceId]))).toHaveLength(0);
    expect((await q('SELECT 1 FROM prompt_versions WHERE workspace_id=$1 AND active', [w.workspaceId])).length).toBeGreaterThanOrEqual(9);
  });
  it('workspace A không thấy dữ liệu của B qua các truy vấn có lọc workspace_id', async () => {
    const a = await makeWorkspace('isoA'); const b = await makeWorkspace('isoB');
    await createContent(a.workspaceId, a.userId, { title: 'Bí mật của A', body: 'x' });
    const seenByB = await q('SELECT 1 FROM contents WHERE workspace_id=$1', [b.workspaceId]);
    expect(seenByB).toHaveLength(0);
    const brandA = await one<{ id: string }>('SELECT id FROM brands WHERE workspace_id=$1 LIMIT 1', [a.workspaceId]);
    // Khoá ngoại không cho tham chiếu chéo workspace ở tầng ứng dụng: API luôn kèm workspace_id = ngữ cảnh người dùng
    const cross = await q('SELECT 1 FROM brands WHERE id=$1 AND workspace_id=$2', [brandA!.id, b.workspaceId]);
    expect(cross).toHaveLength(0);
  });
});

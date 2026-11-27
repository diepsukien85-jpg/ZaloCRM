import { describe, it, expect, afterAll } from 'vitest';
import { one, q } from '@/lib/db';
import { executeRun, startWorkflow, cancelRun } from '@/lib/services/workflows';
import { makeWorkspace, closePool } from '../helpers/factory';

afterAll(closePool);

describe('Daily Agent (chế độ DEMO, không cần API key)', () => {
  it('tạo 10 ý tưởng, chọn 5, 3 bài + 2 kịch bản, biến thể, đều gắn nhãn demo', async () => {
    const w = await makeWorkspace('daily');
    const id = await startWorkflow(w.workspaceId, w.userId, 'daily');
    await executeRun(id);
    const run = await one<{ status: string; is_demo: boolean; error: string | null }>('SELECT status, is_demo, error FROM workflow_runs WHERE id=$1', [id]);
    expect(run?.error).toBeNull();
    expect(run?.status).toBe('succeeded');
    expect(run?.is_demo).toBe(true);

    const steps = await q<{ status: string }>('SELECT status FROM workflow_steps WHERE run_id=$1', [id]);
    expect(steps).toHaveLength(12);
    expect(steps.every((s) => s.status === 'succeeded')).toBe(true);

    const ideas = await q<{ status: string; is_demo: boolean; total_score: number }>('SELECT status, is_demo, total_score FROM ideas WHERE workspace_id=$1', [w.workspaceId]);
    expect(ideas.length).toBe(10);
    expect(ideas.filter((i) => i.status === 'in_production')).toHaveLength(5);
    expect(ideas.every((i) => i.is_demo && i.total_score >= 0 && i.total_score <= 100)).toBe(true);

    const contents = await q<{ content_type: string; is_demo: boolean; status: string; parent_content_id: string | null }>('SELECT content_type, is_demo, status, parent_content_id FROM contents WHERE workspace_id=$1', [w.workspaceId]);
    expect(contents.filter((c) => c.content_type === 'post' || c.content_type === 'carousel')).toHaveLength(3);
    expect(contents.filter((c) => c.content_type === 'video_script')).toHaveLength(2);
    expect(contents.every((c) => c.is_demo && c.status === 'draft')).toBe(true); // chưa tự duyệt/đăng

    const variants = await one<{ n: number }>('SELECT count(*) AS n FROM content_variants WHERE workspace_id=$1', [w.workspaceId]);
    expect(variants!.n).toBe(3 * 2 + 2 * 3);
    // Biến thể KHÔNG phải nội dung gốc → KPI không đếm trùng
    const orig = await one<{ n: number }>('SELECT count(*) AS n FROM contents WHERE workspace_id=$1 AND parent_content_id IS NULL', [w.workspaceId]);
    expect(orig!.n).toBe(5);

    const scenes = await one<{ n: number; empty: number }>("SELECT count(*) AS n, count(*) FILTER (WHERE prompt = '') AS empty FROM video_scenes WHERE workspace_id=$1", [w.workspaceId]);
    expect(scenes!.n).toBeGreaterThan(3);
    expect(scenes!.empty).toBe(0);

    const usage = await one<{ n: number; cost: number }>('SELECT count(*) AS n, sum(est_cost_usd) AS cost FROM ai_usage_logs WHERE workspace_id=$1 AND workflow_run_id=$2', [w.workspaceId, id]);
    expect(usage!.n).toBeGreaterThan(5);
    expect(usage!.cost).toBe(0); // demo không tốn tiền
    const notif = await one('SELECT 1 FROM notifications WHERE workspace_id=$1 AND kind=$2', [w.workspaceId, 'workflow_done']);
    expect(notif).toBeTruthy();
  });

  it('chạy lần 2 không tạo ý tưởng trùng với lần 1', async () => {
    const w = await makeWorkspace('daily2');
    for (let i = 0; i < 2; i++) { const id = await startWorkflow(w.workspaceId, w.userId, 'daily'); await executeRun(id); }
    const titles = await q<{ title: string }>('SELECT title FROM ideas WHERE workspace_id=$1', [w.workspaceId]);
    expect(new Set(titles.map((t) => t.title.toLowerCase())).size).toBe(titles.length);
    expect(titles.length).toBeGreaterThanOrEqual(15);
  });

  it('idempotency: không tạo hai lần chạy cùng khoá; không chạy song song', async () => {
    const w = await makeWorkspace('idem');
    const id = await startWorkflow(w.workspaceId, w.userId, 'daily', { idempotencyKey: 'k1' });
    await expect(startWorkflow(w.workspaceId, w.userId, 'daily', { idempotencyKey: 'k2' })).rejects.toThrow(/đang chạy/);
    await cancelRun(w.workspaceId, id);
    const r = await one<{ status: string }>('SELECT status FROM workflow_runs WHERE id=$1', [id]);
    expect(r?.status).toBe('cancelled');
  });

  it('dừng khi vượt ngân sách (hard stop) với provider thật; demo thì không tính phí', async () => {
    const w = await makeWorkspace('budget');
    await q("UPDATE budget_limits SET amount_usd=0.01 WHERE workspace_id=$1 AND scope='daily'", [w.workspaceId]);
    await q("INSERT INTO ai_usage_logs(workspace_id, provider, model, est_cost_usd) VALUES ($1,'anthropic','x',0.02)", [w.workspaceId]);
    const { assertBudget } = await import('@/lib/ai/budget');
    await expect(assertBudget(w.workspaceId)).rejects.toThrow(/ngân sách/);
  });

  it('weekly review chạy được khi chưa có số liệu và ghi chú rõ thiếu dữ liệu', async () => {
    const w = await makeWorkspace('weekly');
    const id = await startWorkflow(w.workspaceId, w.userId, 'weekly');
    await executeRun(id);
    const r = await one<{ status: string; error: string | null }>('SELECT status, error FROM workflow_runs WHERE id=$1', [id]);
    expect(r?.error).toBeNull();
    expect(r?.status).toBe('succeeded');
    const rep = await one<{ is_demo: boolean }>("SELECT is_demo FROM research_reports WHERE workspace_id=$1 AND kind='weekly'", [w.workspaceId]);
    expect(rep?.is_demo).toBe(true);
  });
});

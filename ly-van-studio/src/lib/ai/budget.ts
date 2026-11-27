import { one, q } from '../db';
import { paymentRequired } from '../errors';

export type Spend = { daily: number; monthly: number; run: number };

export async function getSpend(workspaceId: string, workflowRunId?: string | null): Promise<Spend> {
  const r = await one<{ daily: number; monthly: number }>(
    `SELECT
       COALESCE(SUM(est_cost_usd) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date), 0) AS daily,
       COALESCE(SUM(est_cost_usd) FILTER (WHERE date_trunc('month', created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')), 0) AS monthly
     FROM ai_usage_logs WHERE workspace_id=$1`, [workspaceId]);
  let run = 0;
  if (workflowRunId) {
    const x = await one<{ s: number }>('SELECT COALESCE(SUM(est_cost_usd),0) AS s FROM ai_usage_logs WHERE workspace_id=$1 AND workflow_run_id=$2', [workspaceId, workflowRunId]);
    run = x?.s ?? 0;
  }
  return { daily: r?.daily ?? 0, monthly: r?.monthly ?? 0, run };
}

export type BudgetStatus = { scope: 'daily' | 'monthly'; limit: number; spent: number; pct: number; warn: boolean; exceeded: boolean; hard_stop: boolean };

export async function budgetStatus(workspaceId: string): Promise<BudgetStatus[]> {
  const limits = await q<{ scope: 'daily' | 'monthly'; amount_usd: number; warn_pct: number; hard_stop: boolean }>(
    'SELECT scope, amount_usd, warn_pct, hard_stop FROM budget_limits WHERE workspace_id=$1', [workspaceId]);
  const s = await getSpend(workspaceId);
  return limits.map((l) => {
    const spent = l.scope === 'daily' ? s.daily : s.monthly;
    const pct = l.amount_usd > 0 ? (spent / l.amount_usd) * 100 : spent > 0 ? 100 : 0;
    return { scope: l.scope, limit: l.amount_usd, spent, pct, warn: pct >= l.warn_pct, exceeded: spent >= l.amount_usd, hard_stop: l.hard_stop };
  });
}

/** Gọi TRƯỚC mỗi lần gọi AI có tính phí. Ném 402 nếu vượt ngân sách cứng. Trả về cảnh báo (nếu có). */
export async function assertBudget(workspaceId: string, opts: { workflowRunId?: string | null; runLimitUsd?: number | null } = {}) {
  const statuses = await budgetStatus(workspaceId);
  for (const s of statuses) {
    if (s.exceeded && s.hard_stop) throw paymentRequired(`Đã chạm ngân sách ${s.scope === 'daily' ? 'ngày' : 'tháng'} ($${s.limit.toFixed(2)}). Tăng ngân sách trong "Quản lý chi phí AI" để tiếp tục.`);
  }
  if (opts.runLimitUsd != null && opts.workflowRunId) {
    const sp = await getSpend(workspaceId, opts.workflowRunId);
    if (sp.run >= opts.runLimitUsd) throw paymentRequired(`Workflow đã vượt giới hạn ngân sách của lần chạy ($${opts.runLimitUsd.toFixed(2)}).`);
  }
  for (const s of statuses.filter((x) => x.warn && !x.exceeded)) {
    const title = `Sắp vượt ngân sách AI ${s.scope === 'daily' ? 'ngày' : 'tháng'} (${Math.round(s.pct)}%)`;
    const dup = await one("SELECT 1 FROM notifications WHERE workspace_id=$1 AND kind='budget_warn' AND title=$2 AND created_at > now() - interval '12 hours'", [workspaceId, title]);
    if (!dup) await q("INSERT INTO notifications(workspace_id, kind, title, body, link) VALUES ($1,'budget_warn',$2,$3,'/ai-cost')", [workspaceId, title, `Đã dùng $${s.spent.toFixed(4)} / $${s.limit.toFixed(2)}`]);
  }
}

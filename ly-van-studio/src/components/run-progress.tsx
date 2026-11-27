'use client';
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, Loader2, MinusCircle, XCircle } from 'lucide-react';
import { api, fmtDateTime, fmtUsd } from '@/lib/client';
import { Badge, Button, DemoBadge, Notice, useUi } from './ui';

type Step = { step_no: number; name: string; status: string; output_summary: Record<string, unknown>; error: string | null; duration_ms: number | null };
type RunData = { run: { id: string; workflow_key: string; status: string; error: string | null; is_demo: boolean; started_at: string | null; finished_at: string | null; attempt: number }; steps: Step[]; usage: { usd: number; tokens: number } };

const ICON: Record<string, React.ReactNode> = {
  succeeded: <CheckCircle2 className="h-4 w-4 text-ok" />, running: <Loader2 className="h-4 w-4 animate-spin text-brand" />, failed: <XCircle className="h-4 w-4 text-danger" />,
  pending: <Circle className="h-4 w-4 text-muted" />, skipped: <MinusCircle className="h-4 w-4 text-muted" />,
};

/** Theo dõi tiến độ một lần chạy workflow (poll DB mỗi 1.5s tới khi kết thúc). */
export function RunProgress({ runId, onDone }: { runId: string; onDone?: (d: RunData) => void }) {
  const [d, setD] = useState<RunData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { toast } = useUi();
  const done = useRef(onDone); done.current = onDone;

  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const r = await api<RunData>(`/workflow-runs/${runId}`);
        if (stop) return;
        setD(r);
        if (['succeeded', 'failed', 'cancelled'].includes(r.run.status)) { done.current?.(r); return; }
      } catch (e) { if (!stop) setErr((e as Error).message); return; }
      setTimeout(tick, 1500);
    }
    tick();
    return () => { stop = true; };
  }, [runId]);

  if (err) return <Notice tone="red">{err}</Notice>;
  if (!d) return <p className="text-sm text-muted">Đang khởi tạo…</p>;
  const { run, steps, usage } = d;
  const active = ['queued', 'running'].includes(run.status);
  const doneN = steps.filter((s) => s.status === 'succeeded').length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={run.status === 'succeeded' ? 'green' : run.status === 'failed' ? 'red' : run.status === 'cancelled' ? 'gray' : 'blue'}>{{ queued: 'Chờ chạy', running: 'Đang chạy', succeeded: 'Hoàn tất', failed: 'Thất bại', cancelled: 'Đã huỷ' }[run.status]}</Badge>
        <DemoBadge show={run.is_demo} />
        <span className="text-muted">{doneN}/{steps.length} bước · {fmtUsd(usage.usd)} · {usage.tokens} token</span>
        {run.started_at && <span className="text-xs text-muted">Bắt đầu {fmtDateTime(run.started_at)}</span>}
        <div className="flex-1" />
        {active && <Button size="sm" variant="danger" onClick={async () => { try { await api(`/workflow-runs/${runId}/cancel`, { method: 'POST' }); toast('Đã gửi yêu cầu huỷ', 'info'); } catch (e) { toast((e as Error).message, 'err'); } }}>Huỷ</Button>}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface2"><div className="h-full bg-brand transition-all" style={{ width: `${(doneN / Math.max(steps.length, 1)) * 100}%` }} /></div>
      <ol className="space-y-1.5">
        {steps.map((s) => (
          <li key={s.step_no} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5">{ICON[s.status]}</span>
            <div className="min-w-0 flex-1">
              <p className={s.status === 'pending' ? 'text-muted' : ''}>{s.step_no}. {s.name}{s.duration_ms != null && <span className="ml-2 text-xs text-muted">{(s.duration_ms / 1000).toFixed(1)}s</span>}</p>
              {s.status === 'succeeded' && Object.keys(s.output_summary ?? {}).length > 0 && <p className="break-words text-xs text-muted">{Object.entries(s.output_summary).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</p>}
              {s.error && <p className="text-xs text-danger">{s.error}</p>}
            </div>
          </li>
        ))}
      </ol>
      {run.error && <Notice tone="red">Lỗi: {run.error}</Notice>}
      {run.status === 'failed' && <Button size="sm" onClick={async () => { try { const r = await api<{ run_id: string }>(`/workflow-runs/${runId}/retry`, { method: 'POST' }); location.href = `/agents?run=${r.run_id}`; } catch (e) { toast((e as Error).message, 'err'); } }}>Chạy lại</Button>}
    </div>
  );
}

'use client';
import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { api, fmtDateTime, fmtUsd, useApi } from '@/lib/client';
import { Badge, Button, Card, DemoBadge, Empty, ErrorNote, Field, Input, Modal, Notice, PageHeader, Spinner, Table, Td, useAction, useUi } from '@/components/ui';
import { RunProgress } from '@/components/run-progress';

type Wf = {
  key: string; name: string; description: string; steps: string[]; implemented: boolean; enabled: boolean | null; hour: number | null; minute: number | null; weekday: number | null; day_of_month: number | null;
  timezone: string | null; budget_limit_usd: number | string | null; last_run_at: string | null; next_run_at: string | null; confirmed_at: string | null;
};
type RunRow = { id: string; workflow_key: string; status: string; trigger: string; attempt: number; error: string | null; is_demo: boolean; started_at: string | null; finished_at: string | null; created_at: string };
type Me = { role: 'owner' | 'admin' | 'editor' | 'viewer' };

const STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: 'Chờ chạy', tone: 'blue' }, running: { label: 'Đang chạy', tone: 'blue' }, succeeded: { label: 'Hoàn tất', tone: 'green' }, failed: { label: 'Thất bại', tone: 'red' }, cancelled: { label: 'Đã huỷ', tone: 'gray' },
};
const WEEKDAY = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
const pad = (n: number | null) => (n == null ? '--' : String(n).padStart(2, '0'));

function WorkflowCard({ w, canAdmin, canRun, onChanged, onOpenRun }: { w: Wf; canAdmin: boolean; canRun: boolean; onChanged: () => Promise<void>; onOpenRun: (id: string) => void }) {
  const [hour, setHour] = useState(String(w.hour ?? 7));
  const [minute, setMinute] = useState(String(w.minute ?? 0));
  const [budget, setBudget] = useState(w.budget_limit_usd == null ? '' : String(w.budget_limit_usd));
  const { busy, run } = useAction();
  const { confirm } = useUi();
  const enabled = !!w.enabled;
  const h = Number(hour); const m = Number(minute); const b = budget === '' ? null : Number(budget);
  const valid = Number.isInteger(h) && h >= 0 && h <= 23 && Number.isInteger(m) && m >= 0 && m <= 59 && (b === null || (Number.isFinite(b) && b >= 0));

  const confirmEnable = () => confirm({
    title: `Bật chạy tự động: ${w.name}`, confirmLabel: 'Tôi hiểu, bật tự động', danger: true,
    body: <div className="space-y-2"><p>Workflow sẽ <b>tự chạy theo lịch</b> lúc {pad(h)}:{pad(m)} ({w.timezone ?? 'Asia/Ho_Chi_Minh'}) mà không cần bạn bấm.</p>
      <p>Mỗi lần chạy sẽ gọi AI và <b>phát sinh chi phí</b> (nếu đã cấu hình khoá API; ở chế độ demo chi phí bằng 0 nhưng nội dung chỉ là mẫu).</p>
      <p>Giới hạn mỗi lần chạy: {b == null ? 'không đặt' : fmtUsd(b, 2)}. Ngân sách ngày/tháng vẫn được áp dụng. Bạn có thể tắt bất cứ lúc nào.</p></div>,
  });
  const toggle = async () => {
    if (!enabled) { if (!valid) return; if (!(await confirmEnable())) return; }
    await run('tg', async () => {
      await api(`/automations/${w.key}`, { method: 'PUT', body: enabled ? { enabled: false } : { enabled: true, confirm: true, hour: h, minute: m, budget_limit_usd: b } });
      await onChanged();
    }, enabled ? 'Đã tắt lịch tự động' : 'Đã bật lịch tự động');
  };
  const saveCfg = async () => {
    if (!valid) return;
    if (enabled && !(await confirmEnable())) return;
    await run('sv', async () => {
      await api(`/automations/${w.key}`, { method: 'PUT', body: { enabled, ...(enabled ? { confirm: true } : {}), hour: h, minute: m, budget_limit_usd: b } });
      await onChanged();
    }, 'Đã lưu cấu hình lịch');
  };
  const runNow = async () => {
    if (!(await confirm({ title: `Chạy thủ công ${w.name}?`, body: 'Lần chạy này sẽ gọi AI và có thể phát sinh chi phí.', confirmLabel: 'Chạy ngay' }))) return;
    const r = await run('rn', () => api<{ run_id: string }>(`/workflows/${w.key}/run`, { body: { budget_usd: b } }));
    if (r) { await onChanged(); onOpenRun(r.run_id); }
  };

  return (
    <Card title={w.name} actions={<><Badge tone={enabled ? 'green' : 'gray'}>{enabled ? 'Tự động: BẬT' : 'Tự động: TẮT'}</Badge>{!w.implemented && <Badge tone="amber">Chưa triển khai</Badge>}</>}>
      <p className="text-sm text-muted">{w.description}</p>
      <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">{w.steps.length} bước</summary><ol className="ml-4 mt-1 list-decimal">{w.steps.map((s, i) => <li key={i}>{s}</li>)}</ol></details>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Field label="Giờ"><Input type="number" min={0} max={23} value={hour} onChange={(e) => setHour(e.target.value)} disabled={!canAdmin} /></Field>
        <Field label="Phút"><Input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(e.target.value)} disabled={!canAdmin} /></Field>
        <Field label="Ngân sách/lần (USD)"><Input type="number" min={0} step="0.1" value={budget} onChange={(e) => setBudget(e.target.value)} disabled={!canAdmin} placeholder="Không giới hạn" /></Field>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">
        <dt className="text-muted">Múi giờ</dt><dd className="text-right">{w.timezone ?? 'Asia/Ho_Chi_Minh'}</dd>
        {w.weekday != null && <><dt className="text-muted">Ngày trong tuần</dt><dd className="text-right">{WEEKDAY[w.weekday]}</dd></>}
        {w.day_of_month != null && <><dt className="text-muted">Ngày trong tháng</dt><dd className="text-right">{w.day_of_month}</dd></>}
        <dt className="text-muted">Lần chạy tự động gần nhất</dt><dd className="text-right">{fmtDateTime(w.last_run_at)}</dd>
        <dt className="text-muted">Lần chạy kế tiếp</dt><dd className="text-right">{enabled ? (w.next_run_at ? fmtDateTime(w.next_run_at) : 'Sẽ được tính khi cron chạy') : '—'}</dd>
        <dt className="text-muted">Xác nhận bật lúc</dt><dd className="text-right">{fmtDateTime(w.confirmed_at)}</dd>
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        {canAdmin && <Button variant={enabled ? 'secondary' : 'primary'} disabled={!w.implemented || (!enabled && !valid)} busy={busy === 'tg'} onClick={toggle}>{enabled ? 'Tắt tự động' : 'Bật tự động…'}</Button>}
        {canAdmin && <Button disabled={!valid} busy={busy === 'sv'} onClick={saveCfg}>Lưu giờ & ngân sách</Button>}
        {canRun && <Button disabled={!w.implemented} busy={busy === 'rn'} onClick={runNow}><Play className="h-4 w-4" />Chạy thủ công</Button>}
      </div>
      {!valid && <p className="mt-2 text-xs text-danger">Giờ 0–23, phút 0–59, ngân sách ≥ 0.</p>}
    </Card>
  );
}

export default function AutomationPage() {
  const { data: me } = useApi<Me>('/auth/me');
  const canAdmin = me?.role === 'owner' || me?.role === 'admin';
  const canRun = !!me && me.role !== 'viewer';
  const { data, error, loading, reload } = useApi<{ items: Wf[]; runs: RunRow[] }>('/workflows');
  const [runId, setRunId] = useState<string | null>(null);
  const [origin, setOrigin] = useState('https://<tên-miền-của-bạn>');
  const { busy, run } = useAction();
  const { confirm } = useUi();
  useEffect(() => { setOrigin(location.origin); }, []);

  const cancel = async (id: string) => { await run('c' + id, async () => { await api(`/workflow-runs/${id}/cancel`, { method: 'POST' }); await reload(); }, 'Đã gửi yêu cầu huỷ'); };
  const retry = async (r: RunRow) => {
    if (!(await confirm({ title: 'Chạy lại?', body: 'Sẽ tạo lần chạy mới và có thể phát sinh chi phí AI.', confirmLabel: 'Chạy lại' }))) return;
    const res = await run('r' + r.id, () => api<{ run_id: string }>(`/workflow-runs/${r.id}/retry`, { method: 'POST' }));
    if (res) { await reload(); setRunId(res.run_id); }
  };

  return (
    <div>
      <PageHeader title="Automation Center" desc="Mặc định mọi lịch tự động đều TẮT cho tới khi bạn chủ động xác nhận bật. Chạy thủ công luôn dùng được." />
      <div className="mb-4"><Notice tone="amber">Lịch tự động chỉ chạy khi có <b>cron</b> gọi <code>POST /api/cron/tick</code> (mỗi 5–15 phút) kèm header <code>Authorization: Bearer $CRON_SECRET</code>. Nếu chưa cấu hình cron và <code>CRON_SECRET</code>, bật lịch ở đây sẽ KHÔNG tự chạy.</Notice></div>
      {loading && !data && <Spinner />}<ErrorNote message={error} />
      {!canAdmin && me && <div className="mb-3"><Notice tone="blue">Bạn không có quyền admin: không thể bật/tắt lịch hoặc đổi cấu hình.</Notice></div>}
      {data && (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            {data.items.map((w) => <WorkflowCard key={w.key + (w.enabled ? '1' : '0') + w.hour + w.minute + w.budget_limit_usd} w={w} canAdmin={canAdmin} canRun={canRun} onChanged={reload} onOpenRun={setRunId} />)}
          </div>
          <Card title="Lịch sử chạy gần đây" actions={<Button size="sm" onClick={reload}>Làm mới</Button>}>
            <Table head={['Bắt đầu', 'Workflow', 'Trạng thái', 'Kích hoạt', 'Lần thử', 'Kết thúc', 'Lỗi', '']}
              empty={data.runs.length === 0 ? <div className="p-3"><Empty title="Chưa có lần chạy nào" /></div> : undefined}>
              {data.runs.map((r) => {
                const st = STATUS[r.status] ?? { label: r.status, tone: 'gray' };
                return (
                  <tr key={r.id}>
                    <Td className="whitespace-nowrap text-xs">{fmtDateTime(r.started_at ?? r.created_at)}</Td><Td>{r.workflow_key}</Td>
                    <Td><Badge tone={st.tone}>{st.label}</Badge> <DemoBadge show={r.is_demo} /></Td><Td className="text-xs">{r.trigger === 'schedule' ? 'Theo lịch' : r.trigger === 'manual' ? 'Thủ công' : r.trigger}</Td>
                    <Td className="tabular-nums">{r.attempt}</Td><Td className="whitespace-nowrap text-xs">{fmtDateTime(r.finished_at)}</Td><Td className="max-w-xs break-words text-xs text-danger">{r.error ?? ''}</Td>
                    <Td className="whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => setRunId(r.id)}>Chi tiết</Button>
                      {canRun && ['queued', 'running'].includes(r.status) && <Button size="sm" variant="ghost" busy={busy === 'c' + r.id} onClick={() => cancel(r.id)}>Huỷ</Button>}
                      {canRun && ['failed', 'cancelled'].includes(r.status) && <Button size="sm" variant="ghost" busy={busy === 'r' + r.id} onClick={() => retry(r)}>Chạy lại</Button>}
                    </Td>
                  </tr>
                );
              })}
            </Table>
          </Card>
          <Card title="Hướng dẫn cấu hình cron">
            <div className="space-y-2 text-sm">
              <p>1. Đặt biến môi trường <code>CRON_SECRET</code> (chuỗi bí mật dài) trên máy chủ rồi khởi động lại ứng dụng.</p>
              <p>2. Crontab (mỗi 10 phút):</p>
              <pre className="overflow-x-auto rounded-lg bg-surface2 p-3 text-xs">{`*/10 * * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" ${origin}/api/cron/tick`}</pre>
              <p>3. Vercel Cron: tạo cron gọi <code>/api/cron/tick</code>; hãy kiểm tra xem phương thức/ header Authorization của Vercel có khớp endpoint này (POST + Bearer) không, nếu không dùng crontab ngoài.</p>
              <p className="text-xs text-muted">Chỉ các lịch bạn đã bật và xác nhận mới được chạy. Mỗi lịch có khoá chống chạy trùng trong cùng một khung giờ.</p>
            </div>
          </Card>
        </div>
      )}
      <Modal open={!!runId} onClose={() => setRunId(null)} title="Chi tiết lần chạy" wide>{runId && <RunProgress runId={runId} onDone={() => { reload(); }} />}</Modal>
    </div>
  );
}

'use client';
import { useEffect, useState } from 'react';
import { api, PLATFORM_LABEL, useApi } from '@/lib/client';
import { Button, Card, ErrorNote, Field, Input, Modal, Notice, Spinner, useAction } from '@/components/ui';

type Kpi = { posts_per_day: number; short_videos_per_day: number; originals_per_30_days: number };
type Dash = { production: Record<string, number>; today: Record<string, number> };
type Channel = { id: string; name: string; platform: string; kpi: Partial<Kpi> | null };
const FIELDS: { key: keyof Kpi; label: string }[] = [{ key: 'posts_per_day', label: 'Bài/ngày' }, { key: 'short_videos_per_day', label: 'Video ngắn/ngày' }, { key: 'originals_per_30_days', label: 'Nội dung gốc/30 ngày' }];

function Bar({ label, value, target }: { label: string; value: number; target: number }) {
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs"><span>{label}</span><span className="tabular-nums">{value}/{target}</span></div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface2"><div className="h-full bg-teal" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function ChannelKpi({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, error, loading, reload } = useApi<{ items: Channel[] }>(open ? '/channels' : null);
  const { busy, run } = useAction();
  const [vals, setVals] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => {
    if (!data) return;
    const v: Record<string, Record<string, string>> = {};
    for (const c of data.items) v[c.id] = Object.fromEntries(FIELDS.map((f) => [f.key, c.kpi?.[f.key] != null ? String(c.kpi[f.key]) : '']));
    setVals(v);
  }, [data]);
  async function save(c: Channel) {
    const kpi: Partial<Kpi> = {};
    for (const f of FIELDS) { const raw = vals[c.id]?.[f.key]; if (raw !== '' && raw != null) kpi[f.key] = Number(raw); }
    await run(c.id, () => api(`/channels/${c.id}`, { method: 'PATCH', body: { kpi } }), `Đã lưu KPI kênh ${c.name}`);
    reload();
  }
  return (
    <Modal open={open} onClose={onClose} title="KPI từng kênh" wide footer={<Button onClick={onClose}>Đóng</Button>}>
      <ErrorNote message={error} />
      {loading && !data ? <Spinner /> : !data?.items.length ? <p className="text-sm text-muted">Chưa có kênh nào. Thêm kênh ở mục Kênh.</p> : (
        <ul className="space-y-3">
          {data.items.map((c) => (
            <li key={c.id} className="rounded-lg border border-line p-3">
              <p className="mb-2 text-sm font-medium">{c.name} <span className="text-xs text-muted">· {PLATFORM_LABEL[c.platform] ?? c.platform}</span></p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                {FIELDS.map((f) => <Field key={f.key} label={f.label}><Input type="number" min={0} value={vals[c.id]?.[f.key] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [c.id]: { ...v[c.id], [f.key]: e.target.value } }))} /></Field>)}
                <div className="flex items-end"><Button size="md" variant="primary" busy={busy === c.id} onClick={() => void save(c)}>Lưu</Button></div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function KpiPanel({ refreshKey }: { refreshKey: number }) {
  const kpi = useApi<Kpi>('/kpi');
  const dash = useApi<Dash>('/dashboard');
  const { busy, run } = useAction();
  const [form, setForm] = useState<Record<keyof Kpi, string> | null>(null);
  const [ch, setCh] = useState(false);
  const { reload: reloadDash } = dash;
  useEffect(() => { if (refreshKey) reloadDash(); }, [refreshKey, reloadDash]);
  useEffect(() => { if (kpi.data) setForm({ posts_per_day: String(kpi.data.posts_per_day), short_videos_per_day: String(kpi.data.short_videos_per_day), originals_per_30_days: String(kpi.data.originals_per_30_days) }); }, [kpi.data]);

  async function save() {
    if (!form) return;
    const body = { posts_per_day: Number(form.posts_per_day), short_videos_per_day: Number(form.short_videos_per_day), originals_per_30_days: Number(form.originals_per_30_days) };
    if (Object.values(body).some((v) => !Number.isFinite(v) || v < 0)) { return void run('x', async () => { throw new Error('KPI phải là số không âm'); }); }
    await run('kpi', () => api('/kpi', { method: 'PUT', body }), 'Đã lưu KPI');
    kpi.reload();
  }
  const k = kpi.data, d = dash.data;
  return (
    <Card title="KPI nội dung" actions={<Button size="sm" onClick={() => setCh(true)}>KPI từng kênh</Button>}>
      <ErrorNote message={kpi.error ?? dash.error} />
      {!k || !form ? <Spinner /> : (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted">Tiến độ thực tế</p>
            {d ? (
              <>
                <Bar label="Bài đăng hôm nay" value={d.today.posts ?? 0} target={k.posts_per_day} />
                <Bar label="Video ngắn hôm nay" value={d.today.videos ?? 0} target={k.short_videos_per_day} />
                <Bar label="Nội dung gốc (30 ngày)" value={d.production.originals ?? 0} target={k.originals_per_30_days} />
              </>
            ) : <Spinner />}
            <p className="text-xs text-muted">Chỉ đếm nội dung gốc, không đếm biến thể phân phối.</p>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Mục tiêu KPI</p>
            <div className="grid grid-cols-3 gap-2">
              {FIELDS.map((f) => <Field key={f.key} label={f.label}><Input type="number" min={0} value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} /></Field>)}
            </div>
            <Button variant="primary" busy={busy === 'kpi'} onClick={() => void save()}>Lưu KPI</Button>
            <Notice tone="blue">Chỉnh KPI cần quyền quản trị; nếu không đủ quyền, hệ thống sẽ báo lỗi.</Notice>
          </div>
        </div>
      )}
      <ChannelKpi open={ch} onClose={() => setCh(false)} />
    </Card>
  );
}

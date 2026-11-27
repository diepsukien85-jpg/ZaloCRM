'use client';
import { useRef, useState } from 'react';
import { Download, Trash2, Upload } from 'lucide-react';
import { api, download, fmtDate, fmtNum, fmtVnd, PLATFORM_LABEL, useApi, vnDate } from '@/lib/client';
import { Badge, Button, Empty, ErrorNote, Field, Input, Notice, Select, Spinner, Table, Tabs, Td, Textarea, useAction, useUi } from '@/components/ui';

export type Snapshot = {
  id: string; snapshot_date: string; platform: string; content_id: string | null; content_title: string | null; channel_id: string | null; channel_name: string | null;
  views: number; reach: number; likes: number; comments: number; shares: number; saves: number; leads: number; orders: number; revenue: number; gross_profit: number; ad_spend: number;
  data_source: string; attribution_method: string; notes: string;
};
type Ch = { id: string; name: string };
type Ct = { id: string; title: string };
type ImportResult = { imported: number; errors: { line: number; error: string }[] };

export const ATTRIBUTION_LABEL: Record<string, string> = { manual: 'Thủ công', first_touch: 'First touch', last_touch: 'Last touch', last_click: 'Last click', none: 'Không quy thuộc' };
export const SOURCE_LABEL: Record<string, string> = { manual: 'Nhập tay', csv: 'Import CSV', api: 'API' };
const CSV_TEMPLATE = 'snapshot_date,platform,content_id,channel_id,views,reach,watch_time_sec,avg_view_duration_sec,completion_rate,likes,comments,shares,saves,followers_gained,leads,quotes,orders,revenue,gross_profit,ad_spend,attribution_method,notes\n';

const NUM_FIELDS: [string, string, string?][] = [
  ['views', 'Views'], ['reach', 'Reach'], ['watch_time_sec', 'Tổng thời gian xem (giây)'], ['avg_view_duration_sec', 'Thời gian xem TB (giây)'], ['completion_rate', 'Tỷ lệ xem hết (%)', '0-100'],
  ['likes', 'Like'], ['comments', 'Comment'], ['shares', 'Share'], ['saves', 'Save'], ['followers_gained', 'Follower mới'], ['leads', 'Lead'], ['quotes', 'Báo giá'], ['orders', 'Đơn'],
  ['revenue', 'Doanh thu (VND)'], ['gross_profit', 'Lợi nhuận gộp (VND)'], ['ad_spend', 'Chi phí quảng cáo (VND)'],
];

function ManualForm({ channels, contents, onSaved }: { channels: Ch[]; contents: Ct[]; onSaved: () => void }) {
  const { busy, run } = useAction();
  const [err, setErr] = useState<string | null>(null);
  const init = () => ({ snapshot_date: vnDate(), platform: 'facebook_page', content_id: '', channel_id: '', attribution_method: 'manual', notes: '', ...Object.fromEntries(NUM_FIELDS.map(([k]) => [k, ''])) } as Record<string, string>);
  const [f, setF] = useState<Record<string, string>>(init);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));

  const submit = async () => {
    setErr(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.snapshot_date)) { setErr('Chọn ngày hợp lệ'); return; }
    const body: Record<string, unknown> = { snapshot_date: f.snapshot_date, platform: f.platform, content_id: f.content_id || null, channel_id: f.channel_id || null, attribution_method: f.attribution_method, notes: f.notes };
    for (const [k, label] of NUM_FIELDS) {
      const raw = f[k].trim(); if (raw === '') continue;
      const n = Number(raw);
      if (Number.isNaN(n) || (k !== 'followers_gained' && k !== 'gross_profit' && n < 0)) { setErr(`${label}: số không hợp lệ`); return; }
      if (!['avg_view_duration_sec', 'completion_rate', 'revenue', 'gross_profit', 'ad_spend'].includes(k) && !Number.isInteger(n)) { setErr(`${label}: phải là số nguyên`); return; }
      body[k] = n;
    }
    const r = await run('add', () => api('/analytics/snapshots', { body }), 'Đã lưu số liệu');
    if (r !== undefined) { setF(init()); onSaved(); }
  };

  return (
    <div className="space-y-3">
      <Notice tone="blue">Số liệu nhập tay được đánh dấu nguồn “Nhập tay”. Chỉ nhập số bạn đọc được từ công cụ thống kê chính thức của nền tảng hoặc hệ thống bán hàng; ô để trống sẽ lưu là 0.</Notice>
      <ErrorNote message={err} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Ngày *"><Input type="date" value={f.snapshot_date} onChange={(e) => set('snapshot_date', e.target.value)} /></Field>
        <Field label="Nền tảng"><Select value={f.platform} onChange={(e) => set('platform', e.target.value)}>{Object.entries(PLATFORM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="Kênh"><Select value={f.channel_id} onChange={(e) => set('channel_id', e.target.value)}><option value="">—</option>{channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label="Nội dung" className="sm:col-span-2 lg:col-span-3"><Select value={f.content_id} onChange={(e) => set('content_id', e.target.value)}><option value="">— Không gắn nội dung cụ thể —</option>{contents.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</Select></Field>
        {NUM_FIELDS.map(([k, label, ph]) => <Field key={k} label={label}><Input type="number" inputMode="decimal" step="any" placeholder={ph ?? '0'} value={f[k]} onChange={(e) => set(k, e.target.value)} /></Field>)}
        <Field label="Phương pháp quy thuộc doanh thu"><Select value={f.attribution_method} onChange={(e) => set('attribution_method', e.target.value)}>{Object.entries(ATTRIBUTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="Ghi chú" className="sm:col-span-2 lg:col-span-3"><Textarea className="min-h-16" maxLength={1000} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>
      <Button variant="primary" busy={busy === 'add'} onClick={submit}>Lưu số liệu</Button>
    </div>
  );
}

function ImportCsv({ onDone }: { onDone: () => void }) {
  const { busy, run } = useAction();
  const [csv, setCsv] = useState('');
  const [res, setRes] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const go = async () => { setRes(null); const r = await run('imp', () => api<ImportResult>('/analytics/import', { body: { csv } })); if (r) { setRes(r); if (r.imported) onDone(); } };
  return (
    <div className="space-y-3">
      <Notice tone="blue">Tên cột đúng như mẫu: <code className="break-all">{CSV_TEMPLATE.trim()}</code>. Cột <code>snapshot_date</code> dạng YYYY-MM-DD; <code>content_id</code>/<code>channel_id</code> là UUID (có thể để trống). Nguồn dữ liệu được ghi là “Import CSV”.</Notice>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => download('mau-analytics.csv', CSV_TEMPLATE, 'text/csv')}><Download className="h-4 w-4" />Tải mẫu CSV</Button>
        <Button size="sm" onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" />Chọn file .csv</Button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setCsv(await f.text()); setRes(null); } e.target.value = ''; }} />
      </div>
      <Field label="Hoặc dán nội dung CSV"><Textarea className="min-h-40 font-mono text-xs" value={csv} onChange={(e) => { setCsv(e.target.value); setRes(null); }} /></Field>
      <Button variant="primary" busy={busy === 'imp'} disabled={csv.trim().length < 10} onClick={go}>Import</Button>
      {res && (
        <div className="space-y-2">
          <Notice tone={res.imported ? 'green' : 'amber'}>Đã nhập {res.imported} dòng. {res.errors.length ? `${res.errors.length} dòng lỗi.` : 'Không có lỗi.'}</Notice>
          {res.errors.length > 0 && <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line p-2 text-xs">{res.errors.map((e, i) => <li key={i}><strong>Dòng {e.line}:</strong> <span className="text-danger">{e.error}</span></li>)}</ul>}
          {res.errors.length >= 50 && <p className="text-xs text-muted">Chỉ hiển thị tối đa 50 lỗi đầu tiên.</p>}
        </div>
      )}
    </div>
  );
}

function SnapshotList({ items, loading, error, onDeleted }: { items: Snapshot[]; loading: boolean; error: string | null; onDeleted: () => void }) {
  const { busy, run } = useAction();
  const { confirm } = useUi();
  const del = async (s: Snapshot) => {
    if (!(await confirm({ title: 'Xoá bản ghi số liệu?', body: `Ngày ${fmtDate(s.snapshot_date)} · ${PLATFORM_LABEL[s.platform] ?? s.platform}. Số liệu tổng hợp sẽ thay đổi.`, confirmLabel: 'Xoá', danger: true }))) return;
    const r = await run('d-' + s.id, () => api(`/analytics/snapshots/${s.id}`, { method: 'DELETE' }), 'Đã xoá bản ghi');
    if (r !== undefined) onDeleted();
  };
  return (
    <div className="space-y-2">
      <ErrorNote message={error} />
      {loading && !items.length && <Spinner />}
      {!loading && !items.length && !error && <Empty title="Chưa có bản ghi số liệu" hint="Nhập thủ công hoặc import CSV. Hệ thống không tự tạo số liệu." />}
      {items.length > 0 && (
        <Table head={['Ngày', 'Nguồn', 'Nền tảng / Kênh', 'Nội dung', 'Views', 'Lead', 'Đơn', 'Doanh thu', 'Lợi nhuận gộp', 'Chi phí QC', 'Quy thuộc', '']}>
          {items.map((s) => (
            <tr key={s.id}>
              <Td className="whitespace-nowrap">{fmtDate(s.snapshot_date)}</Td>
              <Td><Badge tone={s.data_source === 'api' ? 'teal' : s.data_source === 'csv' ? 'blue' : 'gray'}>{SOURCE_LABEL[s.data_source] ?? s.data_source}</Badge></Td>
              <Td>{PLATFORM_LABEL[s.platform] ?? s.platform}<p className="text-xs text-muted">{s.channel_name ?? '—'}</p></Td>
              <Td className="max-w-48"><span className="line-clamp-2">{s.content_title ?? '—'}</span></Td>
              <Td className="tabular-nums">{fmtNum(s.views)}</Td><Td className="tabular-nums">{fmtNum(s.leads)}</Td><Td className="tabular-nums">{fmtNum(s.orders)}</Td>
              <Td className="tabular-nums">{fmtVnd(s.revenue)}</Td><Td className="tabular-nums">{fmtVnd(s.gross_profit)}</Td><Td className="tabular-nums">{fmtVnd(s.ad_spend)}</Td>
              <Td>{ATTRIBUTION_LABEL[s.attribution_method] ?? s.attribution_method}</Td>
              <Td><Button size="sm" variant="ghost" aria-label="Xoá bản ghi" busy={busy === 'd-' + s.id} onClick={() => del(s)}><Trash2 className="h-4 w-4 text-danger" /></Button></Td>
            </tr>
          ))}
        </Table>
      )}
      {items.length >= 300 && <p className="text-xs text-muted">Hiển thị 300 bản ghi gần nhất.</p>}
    </div>
  );
}

type TabId = 'list' | 'manual' | 'csv';
export function DataEntry({ snapshots, loading, error, canWrite, onChanged }: { snapshots: Snapshot[]; loading: boolean; error: string | null; canWrite: boolean; onChanged: () => void }) {
  const [tab, setTab] = useState<TabId>('list');
  const { data: chs } = useApi<{ items: Ch[] }>('/channels');
  const { data: cts } = useApi<{ items: Ct[] }>('/contents?originals=true');
  const tabs: { id: TabId; label: string }[] = [{ id: 'list', label: `Bản ghi đã nhập (${snapshots.length})` }, ...(canWrite ? [{ id: 'manual' as const, label: 'Nhập số liệu thủ công' }, { id: 'csv' as const, label: 'Import CSV' }] : [])];
  return (
    <div className="space-y-3">
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'list' && <SnapshotList items={snapshots} loading={loading} error={error} onDeleted={onChanged} />}
      {tab === 'manual' && <ManualForm channels={chs?.items ?? []} contents={cts?.items ?? []} onSaved={() => { onChanged(); setTab('list'); }} />}
      {tab === 'csv' && <ImportCsv onDone={onChanged} />}
    </div>
  );
}

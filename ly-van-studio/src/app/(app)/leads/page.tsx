'use client';
import { useMemo, useRef, useState } from 'react';
import { Download, LayoutGrid, Link2, Pencil, Plus, Table2, Trash2, Upload } from 'lucide-react';
import { api, download, fmtDate, fmtNum, fmtPct, fmtVnd, LEAD_STATUS_LABEL, PLATFORM_LABEL, useApi } from '@/lib/client';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Stat, Table, Td, Textarea, useAction, useUi } from '@/components/ui';

type Lead = {
  id: string; name: string; contact: string; contact_consent: boolean; source: string; platform: string | null; channel_id: string | null; content_id: string | null; need: string; product_interest: string;
  budget: number | null; status: string; assignee_id: string | null; quote_amount: number | null; order_count: number; revenue: number; gross_profit: number; notes: string; external_ref: string | null; created_at: string;
  content_title: string | null; channel_name: string | null; assignee_name: string | null;
};
type Ch = { id: string; name: string };
type Ct = { id: string; title: string };
type Member = { user_id: string; name: string; email: string };
type ImportResult = { imported: number; errors: { line: number; error: string }[] };

const STATUSES = ['new', 'contacted', 'qualified', 'quoted', 'negotiating', 'won', 'lost'] as const;
const QUALIFIED_UP = ['qualified', 'quoted', 'negotiating', 'won'];
const S_TONE: Record<string, string> = { new: 'gray', contacted: 'blue', qualified: 'teal', quoted: 'amber', negotiating: 'gold', won: 'green', lost: 'red' };
const METHOD_LABEL: Record<string, string> = { manual: 'Thủ công (tự gán nội dung)', first_touch: 'First touch — nội dung chạm đầu tiên', last_touch: 'Last touch — nội dung chạm cuối cùng' };
const CSV_TEMPLATE = 'name,contact,source,platform,need,product_interest,budget,status,notes,external_ref\nNguyễn Văn A,0900000000,facebook,facebook_page,Cần tư vấn,Gói A,5000000,new,Khách đồng ý để lại liên hệ,\n';

type Form = { id?: string; name: string; contact: string; consent: boolean; source: string; platform: string; channel_id: string; content_id: string; need: string; product_interest: string; budget: string; status: string; assignee_id: string; quote_amount: string; order_count: string; revenue: string; gross_profit: string; notes: string; external_ref: string };
const blank: Form = { name: '', contact: '', consent: false, source: 'manual', platform: '', channel_id: '', content_id: '', need: '', product_interest: '', budget: '', status: 'new', assignee_id: '', quote_amount: '', order_count: '0', revenue: '0', gross_profit: '0', notes: '', external_ref: '' };
const toForm = (l: Lead): Form => ({
  id: l.id, name: l.name, contact: l.contact ?? '', consent: l.contact_consent, source: l.source, platform: l.platform ?? '', channel_id: l.channel_id ?? '', content_id: l.content_id ?? '', need: l.need ?? '', product_interest: l.product_interest ?? '',
  budget: l.budget != null ? String(l.budget) : '', status: l.status, assignee_id: l.assignee_id ?? '', quote_amount: l.quote_amount != null ? String(l.quote_amount) : '', order_count: String(l.order_count ?? 0), revenue: String(l.revenue ?? 0), gross_profit: String(l.gross_profit ?? 0), notes: l.notes ?? '', external_ref: l.external_ref ?? '',
});
const optNum = (s: string) => (s.trim() === '' ? null : Number(s));

export default function LeadsPage() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'table' | 'pipeline'>('table');
  const path = useMemo(() => (search.trim() ? `/leads?q=${encodeURIComponent(search.trim())}` : '/leads'), [search]);
  const { data, error, loading, reload } = useApi<{ items: Lead[] }>(path);
  const { data: chs } = useApi<{ items: Ch[] }>('/channels');
  const { data: cts } = useApi<{ items: Ct[] }>('/contents?originals=true');
  const { data: mem } = useApi<{ items: Member[] }>('/members');
  const { data: me } = useApi<{ role: string }>('/auth/me');
  const { busy, run } = useAction();
  const { confirm } = useUi();
  const [form, setForm] = useState<Form | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const [consent, setConsent] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [attr, setAttr] = useState<{ lead: Lead; content_id: string; method: string; revenue: string; gross_profit: string; note: string } | null>(null);
  const [attrErr, setAttrErr] = useState<string | null>(null);

  const all = useMemo(() => data?.items ?? [], [data]);
  const items = status ? all.filter((l) => l.status === status) : all;
  const canWrite = me ? me.role !== 'viewer' : false;
  const isAdmin = me?.role === 'admin' || me?.role === 'owner';

  const sum = useMemo(() => {
    const qualified = all.filter((l) => QUALIFIED_UP.includes(l.status)).length;
    const won = all.filter((l) => l.status === 'won').length;
    return {
      total: all.length, qualified, won, rate: qualified > 0 ? (won / qualified) * 100 : null,
      orders: all.reduce((s, l) => s + (l.order_count ?? 0), 0), revenue: all.reduce((s, l) => s + Number(l.revenue ?? 0), 0), profit: all.reduce((s, l) => s + Number(l.gross_profit ?? 0), 0),
    };
  }, [all]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    if (!form) return;
    setFormErr(null);
    if (!form.name.trim()) { setFormErr('Cần nhập tên khách'); return; }
    if (form.contact.trim() && !form.consent) { setFormErr('Cần tick xác nhận khách hàng đã đồng ý cung cấp liên hệ trước khi lưu thông tin liên hệ.'); return; }
    const nums = { budget: optNum(form.budget), quote_amount: optNum(form.quote_amount), order_count: Number(form.order_count || 0), revenue: Number(form.revenue || 0), gross_profit: Number(form.gross_profit || 0) };
    if ([nums.budget, nums.quote_amount, nums.order_count, nums.revenue, nums.gross_profit].some((n) => n !== null && Number.isNaN(n))) { setFormErr('Các trường số không hợp lệ'); return; }
    if (!Number.isInteger(nums.order_count)) { setFormErr('Số đơn phải là số nguyên'); return; }
    const body: Record<string, unknown> = {
      name: form.name.trim(), contact: form.contact.trim(), contact_consent: form.consent, source: form.source.trim() || 'manual', platform: form.platform || null, channel_id: form.channel_id || null, content_id: form.content_id || null,
      need: form.need, product_interest: form.product_interest, status: form.status, assignee_id: form.assignee_id || null, notes: form.notes, ...nums,
    };
    if (!form.id) body.external_ref = form.external_ref.trim() || null;
    const r = await run('save', () => api(form.id ? `/leads/${form.id}` : '/leads', { method: form.id ? 'PATCH' : 'POST', body }), form.id ? 'Đã cập nhật khách hàng' : 'Đã thêm khách hàng');
    if (r !== undefined) { setForm(null); reload(); }
  };

  const changeStatus = async (l: Lead, s: string) => {
    if (s === l.status) return;
    const r = await run('st-' + l.id, () => api(`/leads/${l.id}`, { method: 'PATCH', body: { status: s } }), `Đã chuyển sang “${LEAD_STATUS_LABEL[s]}”`);
    if (r !== undefined) reload();
  };

  const del = async (l: Lead) => {
    if (!(await confirm({ title: `Xoá khách hàng “${l.name}”?`, body: 'Dữ liệu liên hệ sẽ bị xoá vĩnh viễn, không thể hoàn tác.', confirmLabel: 'Xoá', danger: true }))) return;
    const r = await run('del-' + l.id, () => api(`/leads/${l.id}`, { method: 'DELETE' }), 'Đã xoá');
    if (r !== undefined) reload();
  };

  const doImport = async () => {
    setResult(null);
    const r = await run('import', () => api<ImportResult>('/leads/import', { body: { csv, consent_confirmed: consent } }));
    if (r) { setResult(r); if (r.imported) reload(); }
  };
  const onFile = async (f: File | undefined) => { if (!f) return; setCsv(await f.text()); setResult(null); };

  const doAttr = async () => {
    if (!attr) return;
    setAttrErr(null);
    if (!attr.content_id) { setAttrErr('Chọn nội dung để quy thuộc'); return; }
    const revenue = Number(attr.revenue || 0), gross_profit = Number(attr.gross_profit || 0);
    if (Number.isNaN(revenue) || Number.isNaN(gross_profit) || revenue < 0) { setAttrErr('Doanh thu/lợi nhuận không hợp lệ'); return; }
    const r = await run('attr', () => api(`/leads/${attr.lead.id}/attribute`, { body: { content_id: attr.content_id, method: attr.method, revenue, gross_profit, note: attr.note } }), 'Đã ghi quy thuộc doanh thu');
    if (r !== undefined) setAttr(null);
  };

  const rowActions = (l: Lead) => (
    <div className="flex flex-wrap gap-1">
      {canWrite && <Button size="sm" variant="ghost" aria-label="Sửa" onClick={() => { setFormErr(null); setForm(toForm(l)); }}><Pencil className="h-4 w-4" /></Button>}
      {canWrite && <Button size="sm" variant="ghost" aria-label="Quy thuộc doanh thu" title="Quy thuộc doanh thu cho nội dung" onClick={() => { setAttrErr(null); setAttr({ lead: l, content_id: l.content_id ?? '', method: 'manual', revenue: String(l.revenue ?? 0), gross_profit: String(l.gross_profit ?? 0), note: '' }); }}><Link2 className="h-4 w-4" /></Button>}
      {isAdmin && <Button size="sm" variant="ghost" aria-label="Xoá" busy={busy === 'del-' + l.id} onClick={() => del(l)}><Trash2 className="h-4 w-4 text-danger" /></Button>}
    </div>
  );
  const statusSelect = (l: Lead) => (
    <Select aria-label={`Trạng thái ${l.name}`} className="h-8 w-auto min-w-32 text-xs" value={l.status} disabled={!canWrite || busy === 'st-' + l.id} onChange={(e) => changeStatus(l, e.target.value)}>
      {STATUSES.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}
    </Select>
  );

  return (
    <div>
      <PageHeader title="Khách hàng tiềm năng" desc="Theo dõi lead từ nội dung đến đơn hàng. Chỉ lưu thông tin liên hệ khi khách đã đồng ý cung cấp."
        actions={<>
          <a href="/api/leads/export.csv" className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 text-sm font-medium hover:bg-surface2"><Download className="h-4 w-4" />Xuất CSV</a>
          {canWrite && <Button onClick={() => { setCsv(''); setResult(null); setConsent(false); setImportOpen(true); }}><Upload className="h-4 w-4" />Import CSV</Button>}
          {canWrite && <Button variant="primary" onClick={() => { setFormErr(null); setForm({ ...blank }); }}><Plus className="h-4 w-4" />Thêm lead</Button>}
        </>} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Tổng lead" value={fmtNum(sum.total)} hint={`${sum.qualified} đủ điều kiện trở lên`} />
        <Stat label="Tỷ lệ chốt" value={fmtPct(sum.rate)} hint={`${sum.won} thành công / ${sum.qualified} đủ điều kiện trở lên`} />
        <Stat label="Số đơn" value={fmtNum(sum.orders)} />
        <Stat label="Doanh thu" value={sum.total ? fmtVnd(sum.revenue) : '—'} hint="Doanh thu, không phải lợi nhuận" />
        <Stat label="Lợi nhuận gộp" value={sum.total ? fmtVnd(sum.profit) : '—'} />
      </div>
      <p className="mb-4 text-xs text-muted">Công thức: Tỷ lệ chốt = lead “Thành công” ÷ lead từ “Đủ điều kiện” trở lên (Đủ điều kiện, Đã báo giá, Đàm phán, Thành công) × 100; mẫu số 0 hiển thị “—”. Tính trên tối đa 500 lead mới nhất{search ? ' khớp từ khoá tìm kiếm' : ''}. Doanh thu/lợi nhuận là số bạn nhập tay hoặc import — chưa tích hợp phần mềm bán hàng nội bộ.</p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input aria-label="Tìm kiếm" className="w-full sm:w-64" placeholder="Tìm theo tên hoặc nhu cầu…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select aria-label="Lọc trạng thái" className="w-full sm:w-48" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Mọi trạng thái</option>{STATUSES.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}</Select>
        <div className="ml-auto flex gap-1">
          <Button variant={view === 'table' ? 'primary' : 'secondary'} onClick={() => setView('table')}><Table2 className="h-4 w-4" />Bảng</Button>
          <Button variant={view === 'pipeline' ? 'primary' : 'secondary'} onClick={() => setView('pipeline')}><LayoutGrid className="h-4 w-4" />Pipeline</Button>
        </div>
      </div>

      <ErrorNote message={error} />
      {loading && !data && <Spinner />}
      {data && !items.length && <Empty title="Chưa có khách hàng tiềm năng" hint="Thêm tay (khi khách đã đồng ý) hoặc import CSV có xác nhận consent." />}

      {data && items.length > 0 && view === 'table' && (
        <Table head={['Khách hàng', 'Trạng thái', 'Nguồn', 'Nội dung phát sinh', 'Phụ trách', 'Doanh thu', 'Lợi nhuận gộp', '']}>
          {items.map((l) => (
            <tr key={l.id}>
              <Td><p className="font-medium">{l.name}</p><p className="text-xs text-muted">{l.contact ? l.contact : '—'} {l.contact && (l.contact_consent ? <Badge tone="green">Có đồng ý</Badge> : <Badge tone="red">Chưa xác nhận</Badge>)}</p><p className="text-xs text-muted">{fmtDate(l.created_at)}</p></Td>
              <Td>{statusSelect(l)}</Td>
              <Td><p>{l.source}</p><p className="text-xs text-muted">{l.platform ? PLATFORM_LABEL[l.platform] ?? l.platform : '—'}{l.channel_name ? ` · ${l.channel_name}` : ''}</p></Td>
              <Td className="max-w-56"><span className="line-clamp-2">{l.content_title ?? '—'}</span></Td>
              <Td>{l.assignee_name ?? '—'}</Td>
              <Td className="tabular-nums">{fmtVnd(l.revenue)}<p className="text-xs text-muted">{l.order_count} đơn</p></Td>
              <Td className="tabular-nums">{fmtVnd(l.gross_profit)}</Td>
              <Td>{rowActions(l)}</Td>
            </tr>
          ))}
        </Table>
      )}

      {data && items.length > 0 && view === 'pipeline' && (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {STATUSES.map((s) => {
            const col = items.filter((l) => l.status === s);
            return (
              <div key={s} className="w-64 shrink-0 rounded-xl border border-line bg-surface2 p-2">
                <div className="mb-2 flex items-center justify-between px-1 text-sm font-semibold"><span>{LEAD_STATUS_LABEL[s]}</span><Badge tone={S_TONE[s]}>{col.length}</Badge></div>
                <div className="space-y-2">
                  {col.map((l) => (
                    <div key={l.id} className="rounded-lg border border-line bg-surface p-2.5 text-sm">
                      <p className="break-words font-medium">{l.name}</p>
                      <p className="line-clamp-2 text-xs text-muted">{l.need || l.product_interest || '—'}</p>
                      <p className="mt-1 text-xs tabular-nums text-muted">{l.revenue ? fmtVnd(l.revenue) : l.budget ? `NS ${fmtVnd(l.budget)}` : ''}</p>
                      <div className="mt-2 flex items-center justify-between gap-1">{statusSelect(l)}{rowActions(l)}</div>
                    </div>
                  ))}
                  {!col.length && <p className="px-1 py-3 text-center text-xs text-muted">Trống</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Card className="mt-6" title="Quy thuộc doanh thu">
        <p className="text-sm text-muted">Dùng nút liên kết ở mỗi lead để gán doanh thu/lợi nhuận cho một nội dung gốc. Phương pháp: <strong>Thủ công</strong> (bạn tự chọn nội dung), <strong>First touch</strong> (nội dung khách thấy đầu tiên), <strong>Last touch</strong> (nội dung chạm cuối trước khi mua). Quy thuộc chỉ phản ánh tương quan, không chứng minh nội dung gây ra đơn hàng. Doanh thu khác lợi nhuận gộp — ghi riêng từng số.</p>
      </Card>

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Sửa khách hàng' : 'Thêm khách hàng'} wide footer={<><Button onClick={() => setForm(null)}>Huỷ</Button><Button variant="primary" busy={busy === 'save'} onClick={save}>Lưu</Button></>}>
        {form && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><ErrorNote message={formErr} /></div>
            <Field label="Tên *"><Input value={form.name} maxLength={200} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Liên hệ (SĐT/email)"><Input value={form.contact} maxLength={200} onChange={(e) => set('contact', e.target.value)} /></Field>
            <label className="flex items-start gap-2 rounded-lg bg-surface2 p-2.5 text-sm sm:col-span-2"><input type="checkbox" className="mt-1" checked={form.consent} onChange={(e) => set('consent', e.target.checked)} /><span>Khách hàng đã được hỏi và <strong>đồng ý cung cấp thông tin liên hệ</strong>. Không thu thập thông tin riêng tư từ mạng xã hội khi chưa có sự đồng ý.</span></label>
            <Field label="Nguồn"><Input value={form.source} maxLength={100} onChange={(e) => set('source', e.target.value)} /></Field>
            <Field label="Nền tảng"><Select value={form.platform} onChange={(e) => set('platform', e.target.value)}><option value="">—</option>{Object.entries(PLATFORM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Kênh"><Select value={form.channel_id} onChange={(e) => set('channel_id', e.target.value)}><option value="">—</option>{chs?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            <Field label="Nội dung phát sinh lead"><Select value={form.content_id} onChange={(e) => set('content_id', e.target.value)}><option value="">—</option>{cts?.items.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</Select></Field>
            <Field label="Nhu cầu" className="sm:col-span-2"><Textarea className="min-h-16" value={form.need} onChange={(e) => set('need', e.target.value)} /></Field>
            <Field label="Sản phẩm quan tâm"><Input value={form.product_interest} onChange={(e) => set('product_interest', e.target.value)} /></Field>
            <Field label="Ngân sách (VND)"><Input type="number" min={0} value={form.budget} onChange={(e) => set('budget', e.target.value)} /></Field>
            <Field label="Trạng thái"><Select value={form.status} onChange={(e) => set('status', e.target.value)}>{STATUSES.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}</Select></Field>
            <Field label="Nhân viên phụ trách"><Select value={form.assignee_id} onChange={(e) => set('assignee_id', e.target.value)}><option value="">—</option>{mem?.items.map((m) => <option key={m.user_id} value={m.user_id}>{m.name || m.email}</option>)}</Select></Field>
            <Field label="Giá báo (VND)"><Input type="number" min={0} value={form.quote_amount} onChange={(e) => set('quote_amount', e.target.value)} /></Field>
            <Field label="Số đơn"><Input type="number" min={0} step={1} value={form.order_count} onChange={(e) => set('order_count', e.target.value)} /></Field>
            <Field label="Doanh thu (VND)"><Input type="number" min={0} value={form.revenue} onChange={(e) => set('revenue', e.target.value)} /></Field>
            <Field label="Lợi nhuận gộp (VND)" hint="Khác doanh thu: là phần còn lại sau giá vốn."><Input type="number" value={form.gross_profit} onChange={(e) => set('gross_profit', e.target.value)} /></Field>
            <Field label="Ghi chú" className="sm:col-span-2"><Textarea className="min-h-16" value={form.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
            <Field label="external_ref (mã bên ngoài)" className="sm:col-span-2" hint="Dành cho tích hợp phần mềm bán hàng nội bộ sau này — hiện CHƯA tích hợp, chỉ lưu mã tham chiếu. Chỉ nhập được khi tạo mới (API sửa chưa hỗ trợ trường này).">
              <Input value={form.external_ref} maxLength={100} disabled={!!form.id} onChange={(e) => set('external_ref', e.target.value)} />
            </Field>
          </div>
        )}
      </Modal>

      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Import CSV khách hàng" wide
        footer={<><Button onClick={() => setImportOpen(false)}>Đóng</Button><Button variant="primary" busy={busy === 'import'} disabled={!csv.trim() || !consent} onClick={doImport}>Import</Button></>}>
        <div className="space-y-3">
          <Notice tone="blue">Cột: <code className="break-all">name,contact,source,platform,need,product_interest,budget,status,notes,external_ref</code>. Chỉ <code>name</code> bắt buộc; status là một trong new, contacted, qualified, quoted, negotiating, won, lost.</Notice>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => download('mau-leads.csv', CSV_TEMPLATE, 'text/csv')}><Download className="h-4 w-4" />Tải mẫu CSV</Button>
            <Button size="sm" onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" />Chọn file .csv</Button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
          </div>
          <Field label="Hoặc dán nội dung CSV (dòng đầu là tiêu đề cột)"><Textarea className="min-h-40 font-mono text-xs" value={csv} onChange={(e) => { setCsv(e.target.value); setResult(null); }} /></Field>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>Tôi xác nhận dữ liệu liên hệ trong file được thu thập hợp lệ và <strong>khách hàng đã đồng ý</strong> cung cấp. (Bắt buộc)</span></label>
          {result && (
            <div className="space-y-2">
              <Notice tone={result.imported ? 'green' : 'amber'}>Đã import {result.imported} dòng. {result.errors.length ? `${result.errors.length} dòng lỗi.` : 'Không có lỗi.'}</Notice>
              {result.errors.length > 0 && <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line p-2 text-xs">{result.errors.map((e, i) => <li key={i}><strong>Dòng {e.line}:</strong> <span className="text-danger">{e.error}</span></li>)}</ul>}
              {result.errors.length >= 50 && <p className="text-xs text-muted">Chỉ hiển thị tối đa 50 lỗi đầu tiên.</p>}
            </div>
          )}
        </div>
      </Modal>

      <Modal open={!!attr} onClose={() => setAttr(null)} title={`Quy thuộc doanh thu — ${attr?.lead.name ?? ''}`}
        footer={<><Button onClick={() => setAttr(null)}>Huỷ</Button><Button variant="primary" busy={busy === 'attr'} onClick={doAttr}>Ghi quy thuộc</Button></>}>
        {attr && (
          <div className="space-y-3">
            <ErrorNote message={attrErr} />
            <Field label="Nội dung được quy thuộc"><Select value={attr.content_id} onChange={(e) => setAttr({ ...attr, content_id: e.target.value })}><option value="">— Chọn —</option>{cts?.items.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</Select></Field>
            <Field label="Phương pháp quy thuộc"><Select value={attr.method} onChange={(e) => setAttr({ ...attr, method: e.target.value })}>{Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Doanh thu (VND)"><Input type="number" min={0} value={attr.revenue} onChange={(e) => setAttr({ ...attr, revenue: e.target.value })} /></Field>
              <Field label="Lợi nhuận gộp (VND)"><Input type="number" value={attr.gross_profit} onChange={(e) => setAttr({ ...attr, gross_profit: e.target.value })} /></Field>
            </div>
            <Field label="Ghi chú"><Input value={attr.note} maxLength={500} onChange={(e) => setAttr({ ...attr, note: e.target.value })} /></Field>
            <p className="text-xs text-muted">Quy thuộc là quan hệ tương quan do bạn xác định, không phải bằng chứng nhân quả.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}

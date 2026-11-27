'use client';
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, fmtDateTime, useApi } from '@/lib/client';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Table, Tabs, Td, Textarea, useAction, useUi } from '@/components/ui';

type DnaData = { about: string; positioning: string; personality: string; voice: string; values: string[]; goals: string[]; audiences: string[]; products: string[]; rules: string[]; avoid: string[] };
type Pillar = { name: string; weight: number; description: string };
type Brand = { id: string; name: string; kind: 'personal' | 'business'; website: string | null; description: string; dna: { data: Partial<DnaData>; version: number } | null; pillars: (Pillar & { id: string })[] };
type DnaVersion = { version: number; data: Partial<DnaData>; created_at: string };
type Product = { id: string; name: string; category: string | null; description: string; url: string | null };
type Audience = { id: string; name: string; description: string; pain_points: string[]; desires: string[] };
type Me = { role: 'owner' | 'admin' | 'editor' | 'viewer' };

const LIST_FIELDS: { key: 'values' | 'goals' | 'audiences' | 'products' | 'rules' | 'avoid'; label: string }[] = [
  { key: 'values', label: 'Giá trị cốt lõi' }, { key: 'goals', label: 'Mục tiêu' }, { key: 'audiences', label: 'Khách hàng mục tiêu' },
  { key: 'products', label: 'Sản phẩm/dịch vụ' }, { key: 'rules', label: 'Quy tắc nội dung' }, { key: 'avoid', label: 'Điều cần tránh' },
];
type Form = Record<'about' | 'positioning' | 'personality' | 'voice', string> & Record<(typeof LIST_FIELDS)[number]['key'], string>;
const toForm = (d: Partial<DnaData> | undefined): Form => ({
  about: d?.about ?? '', positioning: d?.positioning ?? '', personality: d?.personality ?? '', voice: d?.voice ?? '',
  values: (d?.values ?? []).join('\n'), goals: (d?.goals ?? []).join('\n'), audiences: (d?.audiences ?? []).join('\n'),
  products: (d?.products ?? []).join('\n'), rules: (d?.rules ?? []).join('\n'), avoid: (d?.avoid ?? []).join('\n'),
});
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const toDna = (f: Form): DnaData => ({ about: f.about, positioning: f.positioning, personality: f.personality, voice: f.voice, values: lines(f.values), goals: lines(f.goals), audiences: lines(f.audiences), products: lines(f.products), rules: lines(f.rules), avoid: lines(f.avoid) });

export default function DnaPage() {
  const { data: me } = useApi<Me>('/auth/me');
  const canEdit = me?.role === 'owner' || me?.role === 'admin';
  const brands = useApi<{ items: Brand[] }>('/brands');
  const [brandId, setBrandId] = useState('');
  const [tab, setTab] = useState<'dna' | 'pillars' | 'products' | 'audiences'>('dna');
  const [newOpen, setNewOpen] = useState(false);
  const brand = brands.data?.items.find((b) => b.id === brandId) ?? brands.data?.items[0];

  return (
    <div>
      <PageHeader title="DNA thương hiệu" desc="DNA là nền tảng để mọi agent viết đúng giọng và đúng định vị. Mỗi lần lưu tạo một phiên bản mới, có thể xem lại và dùng lại."
        actions={canEdit ? <Button onClick={() => setNewOpen(true)}><Plus className="h-4 w-4" />Thêm thương hiệu</Button> : undefined} />
      {!canEdit && me && <div className="mb-3"><Notice tone="blue">Chế độ chỉ đọc: chỉ admin/owner được chỉnh sửa DNA.</Notice></div>}
      {brands.loading && !brands.data && <Spinner />}
      <ErrorNote message={brands.error} />
      {brands.data && brands.data.items.length === 0 && <Empty title="Chưa có thương hiệu" hint="Thêm thương hiệu đầu tiên để bắt đầu." />}
      {brand && (
        <div className="space-y-4">
          <div className="max-w-md"><Field label="Thương hiệu"><Select value={brand.id} onChange={(e) => setBrandId(e.target.value)}>{brands.data!.items.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.kind === 'personal' ? 'cá nhân' : 'doanh nghiệp'})</option>)}</Select></Field></div>
          <Tabs tabs={[{ id: 'dna', label: 'DNA' }, { id: 'pillars', label: 'Trụ cột nội dung' }, { id: 'products', label: 'Sản phẩm' }, { id: 'audiences', label: 'Chân dung khách hàng' }]} value={tab} onChange={setTab} />
          {tab === 'dna' && <DnaEditor key={brand.id + ':' + (brand.dna?.version ?? 0)} brand={brand} canEdit={canEdit} onSaved={brands.reload} />}
          {tab === 'pillars' && <PillarEditor key={brand.id + ':' + brand.pillars.map((p) => p.id).join()} brand={brand} canEdit={canEdit} onSaved={brands.reload} />}
          {tab === 'products' && <ProductList key={brand.id} brandId={brand.id} canEdit={canEdit} />}
          {tab === 'audiences' && <AudienceList key={brand.id} brandId={brand.id} canEdit={canEdit} />}
        </div>
      )}
      <NewBrand open={newOpen} onClose={() => setNewOpen(false)} onCreated={async (id) => { await brands.reload(); setBrandId(id); }} />
    </div>
  );
}

function DnaEditor({ brand, canEdit, onSaved }: { brand: Brand; canEdit: boolean; onSaved: () => Promise<void> }) {
  const [f, setF] = useState<Form>(() => toForm(brand.dna?.data));
  const versions = useApi<{ items: DnaVersion[] }>(`/brands/${brand.id}/dna/versions`);
  const { busy, run } = useAction();
  const set = (k: keyof Form, v: string) => setF((p) => ({ ...p, [k]: v }));
  const save = () => run('dna', async () => { await api(`/brands/${brand.id}/dna`, { method: 'PUT', body: toDna(f) }); await onSaved(); await versions.reload(); }, 'Đã lưu thành phiên bản DNA mới');
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card title={`DNA · phiên bản hiện tại v${brand.dna?.version ?? '—'}`}>
        <div className="space-y-3">
          {([['about', 'Giới thiệu'], ['positioning', 'Định vị'], ['personality', 'Tính cách thương hiệu'], ['voice', 'Giọng văn']] as const).map(([k, l]) => (
            <Field key={k} label={l}><Textarea value={f[k]} onChange={(e) => set(k, e.target.value)} readOnly={!canEdit} /></Field>
          ))}
          {LIST_FIELDS.map((x) => (
            <Field key={x.key} label={`${x.label} (mỗi dòng một mục)`}><Textarea value={f[x.key]} onChange={(e) => set(x.key, e.target.value)} readOnly={!canEdit} /></Field>
          ))}
          {canEdit && <Button variant="primary" size="lg" busy={busy === 'dna'} onClick={save}>Lưu thành phiên bản mới</Button>}
        </div>
      </Card>
      <Card title="Lịch sử phiên bản">
        {versions.loading && !versions.data && <Spinner />}
        <ErrorNote message={versions.error} />
        {versions.data?.items.length === 0 && <Empty title="Chưa có phiên bản" />}
        <ul className="divide-y divide-line">
          {versions.data?.items.map((v) => (
            <li key={v.version} className="flex items-center gap-2 py-2 text-sm">
              <b>v{v.version}</b>{v.version === brand.dna?.version && <Badge tone="green">Hiện tại</Badge>}
              <span className="flex-1 text-xs text-muted">{fmtDateTime(v.created_at)}</span>
              {canEdit && <Button size="sm" onClick={() => { setF(toForm(v.data)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Dùng lại bản này</Button>}
            </li>
          ))}
        </ul>
        {canEdit && <p className="mt-2 text-xs text-muted">“Dùng lại bản này” chỉ nạp vào form; bạn bấm Lưu để tạo version mới.</p>}
      </Card>
    </div>
  );
}

function PillarEditor({ brand, canEdit, onSaved }: { brand: Brand; canEdit: boolean; onSaved: () => Promise<void> }) {
  const [rows, setRows] = useState<Pillar[]>(() => brand.pillars.map((p) => ({ name: p.name, weight: Number(p.weight), description: p.description ?? '' })));
  const { busy, run } = useAction();
  const sum = rows.reduce((s, r) => s + (Number(r.weight) || 0), 0);
  const ok = Math.abs(sum - 100) < 0.01 && rows.length > 0 && rows.every((r) => r.name.trim());
  const upd = (i: number, p: Partial<Pillar>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <Card title="Tỷ trọng trụ cột nội dung" actions={<Badge tone={Math.abs(sum - 100) < 0.01 ? 'green' : 'red'}>Tổng {Math.round(sum * 100) / 100}% / 100%</Badge>}>
      <div className="space-y-3">
        {rows.length === 0 && <Empty title="Chưa có trụ cột" />}
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_88px_auto] gap-2 rounded-lg border border-line p-2">
            <Input aria-label="Tên trụ cột" value={r.name} onChange={(e) => upd(i, { name: e.target.value })} disabled={!canEdit} placeholder="Tên trụ cột" />
            <Input aria-label="Tỷ trọng %" type="number" min={0} max={100} value={r.weight} onChange={(e) => upd(i, { weight: Number(e.target.value) })} disabled={!canEdit} />
            {canEdit ? <Button variant="ghost" aria-label="Xoá" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button> : <span />}
            <Input className="col-span-3" aria-label="Mô tả" value={r.description} onChange={(e) => upd(i, { description: e.target.value })} disabled={!canEdit} placeholder="Mô tả ngắn" />
          </div>
        ))}
        {!ok && canEdit && <Notice tone="red">Tổng tỷ trọng phải đúng 100% (hiện {Math.round(sum * 100) / 100}%) và tên không được để trống.</Notice>}
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setRows((r) => [...r, { name: '', weight: 0, description: '' }])}><Plus className="h-4 w-4" />Thêm trụ cột</Button>
            <Button variant="primary" disabled={!ok} busy={busy === 'pl'} onClick={() => run('pl', async () => { await api(`/brands/${brand.id}/pillars`, { method: 'PUT', body: { pillars: rows } }); await onSaved(); }, 'Đã lưu trụ cột')}>Lưu trụ cột</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function NewBrand({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const [name, setName] = useState(''); const [kind, setKind] = useState<'personal' | 'business'>('business'); const [website, setWebsite] = useState(''); const [desc, setDesc] = useState('');
  const { busy, run } = useAction();
  const submit = async () => {
    const r = await run('nb', () => api<{ id: string }>('/brands', { body: { name: name.trim(), kind, website: website.trim() || null, description: desc } }), 'Đã tạo thương hiệu');
    if (r) { setName(''); setWebsite(''); setDesc(''); onClose(); await onCreated(r.id); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Thêm thương hiệu" footer={<><Button onClick={onClose}>Huỷ</Button><Button variant="primary" disabled={!name.trim()} busy={busy === 'nb'} onClick={submit}>Tạo</Button></>}>
      <div className="space-y-3">
        <Field label="Tên thương hiệu"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        <Field label="Loại"><Select value={kind} onChange={(e) => setKind(e.target.value as 'personal' | 'business')}><option value="business">Doanh nghiệp</option><option value="personal">Cá nhân</option></Select></Field>
        <Field label="Website (không bắt buộc)"><Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" /></Field>
        <Field label="Mô tả"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function ProductList({ brandId, canEdit }: { brandId: string; canEdit: boolean }) {
  const { data, error, loading, reload } = useApi<{ items: Product[] }>(`/products?brand_id=${brandId}`);
  const [edit, setEdit] = useState<Partial<Product> | null>(null);
  const { busy, run } = useAction();
  const { confirm } = useUi();
  const save = async () => {
    if (!edit) return;
    const body = { brand_id: brandId, name: (edit.name ?? '').trim(), category: edit.category || null, description: edit.description ?? '', url: edit.url || null };
    const r = await run('ps', () => api(edit.id ? `/products/${edit.id}` : '/products', { method: edit.id ? 'PATCH' : 'POST', body }), 'Đã lưu sản phẩm');
    if (r !== undefined) { setEdit(null); await reload(); }
  };
  const del = async (p: Product) => {
    if (!(await confirm({ title: 'Xoá sản phẩm?', body: p.name, danger: true, confirmLabel: 'Xoá' }))) return;
    await run('pd' + p.id, async () => { await api(`/products/${p.id}`, { method: 'DELETE' }); await reload(); }, 'Đã xoá');
  };
  return (
    <Card title="Sản phẩm / dịch vụ" actions={canEdit ? <Button size="sm" onClick={() => setEdit({})}><Plus className="h-4 w-4" />Thêm</Button> : undefined}>
      {loading && !data && <Spinner />}<ErrorNote message={error} />
      {data && (
        <Table head={['Tên', 'Nhóm', 'Mô tả', '']} empty={data.items.length === 0 ? <div className="p-3"><Empty title="Chưa có sản phẩm" /></div> : undefined}>
          {data.items.map((p) => (
            <tr key={p.id}><Td className="font-medium">{p.name}</Td><Td>{p.category ?? '—'}</Td><Td className="max-w-md text-xs">{p.description || '—'}</Td>
              <Td className="whitespace-nowrap text-right">{canEdit && <><Button size="sm" variant="ghost" onClick={() => setEdit(p)}>Sửa</Button><Button size="sm" variant="ghost" busy={busy === 'pd' + p.id} onClick={() => del(p)}>Xoá</Button></>}</Td></tr>
          ))}
        </Table>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Sửa sản phẩm' : 'Thêm sản phẩm'} footer={<><Button onClick={() => setEdit(null)}>Huỷ</Button><Button variant="primary" disabled={!edit?.name?.trim()} busy={busy === 'ps'} onClick={save}>Lưu</Button></>}>
        <div className="space-y-3">
          <Field label="Tên"><Input value={edit?.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Nhóm"><Input value={edit?.category ?? ''} onChange={(e) => setEdit({ ...edit, category: e.target.value })} /></Field>
          <Field label="Link"><Input value={edit?.url ?? ''} onChange={(e) => setEdit({ ...edit, url: e.target.value })} /></Field>
          <Field label="Mô tả"><Textarea value={edit?.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
        </div>
      </Modal>
    </Card>
  );
}

function AudienceList({ brandId, canEdit }: { brandId: string; canEdit: boolean }) {
  const { data, error, loading, reload } = useApi<{ items: Audience[] }>(`/audiences?brand_id=${brandId}`);
  const [edit, setEdit] = useState<{ id?: string; name: string; description: string; pain: string; desires: string } | null>(null);
  const { busy, run } = useAction();
  const { confirm } = useUi();
  const open = (a?: Audience) => setEdit(a ? { id: a.id, name: a.name, description: a.description, pain: (a.pain_points ?? []).join('\n'), desires: (a.desires ?? []).join('\n') } : { name: '', description: '', pain: '', desires: '' });
  const save = async () => {
    if (!edit) return;
    const body = { brand_id: brandId, name: edit.name.trim(), description: edit.description, pain_points: lines(edit.pain), desires: lines(edit.desires) };
    const r = await run('as', () => api(edit.id ? `/audiences/${edit.id}` : '/audiences', { method: edit.id ? 'PATCH' : 'POST', body }), 'Đã lưu chân dung');
    if (r !== undefined) { setEdit(null); await reload(); }
  };
  const del = async (a: Audience) => {
    if (!(await confirm({ title: 'Xoá chân dung khách hàng?', body: a.name, danger: true, confirmLabel: 'Xoá' }))) return;
    await run('ad' + a.id, async () => { await api(`/audiences/${a.id}`, { method: 'DELETE' }); await reload(); }, 'Đã xoá');
  };
  return (
    <Card title="Chân dung khách hàng" actions={canEdit ? <Button size="sm" onClick={() => open()}><Plus className="h-4 w-4" />Thêm</Button> : undefined}>
      {loading && !data && <Spinner />}<ErrorNote message={error} />
      {data?.items.length === 0 && <Empty title="Chưa có chân dung khách hàng" />}
      <div className="grid gap-3 sm:grid-cols-2">
        {data?.items.map((a) => (
          <div key={a.id} className="rounded-lg border border-line p-3 text-sm">
            <p className="font-medium">{a.name}</p><p className="mt-1 text-xs text-muted">{a.description || '—'}</p>
            <p className="mt-2 text-xs"><b>Nỗi đau:</b> {a.pain_points?.length ? a.pain_points.join('; ') : '—'}</p>
            <p className="text-xs"><b>Mong muốn:</b> {a.desires?.length ? a.desires.join('; ') : '—'}</p>
            {canEdit && <div className="mt-2 flex gap-1"><Button size="sm" onClick={() => open(a)}>Sửa</Button><Button size="sm" variant="ghost" busy={busy === 'ad' + a.id} onClick={() => del(a)}>Xoá</Button></div>}
          </div>
        ))}
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Sửa chân dung' : 'Thêm chân dung'} footer={<><Button onClick={() => setEdit(null)}>Huỷ</Button><Button variant="primary" disabled={!edit?.name.trim()} busy={busy === 'as'} onClick={save}>Lưu</Button></>}>
        {edit && <div className="space-y-3">
          <Field label="Tên"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Mô tả"><Textarea value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          <Field label="Nỗi đau (mỗi dòng một mục)"><Textarea value={edit.pain} onChange={(e) => setEdit({ ...edit, pain: e.target.value })} /></Field>
          <Field label="Mong muốn (mỗi dòng một mục)"><Textarea value={edit.desires} onChange={(e) => setEdit({ ...edit, desires: e.target.value })} /></Field>
        </div>}
      </Modal>
    </Card>
  );
}

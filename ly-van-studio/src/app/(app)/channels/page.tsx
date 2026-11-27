'use client';
/* eslint-disable @next/next/no-img-element */
import { useState } from 'react';
import { ExternalLink, Pencil, Plus, Plug, Trash2 } from 'lucide-react';
import { api, fmtDateTime, PLATFORM_LABEL, useApi } from '@/lib/client';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Textarea, useAction, useUi } from '@/components/ui';

type Kpi = { posts_per_day?: number; short_videos_per_day?: number; originals_per_30_days?: number };
type Channel = {
  id: string; brand_id: string | null; name: string; platform: string; url: string | null; avatar_url: string | null; target_audience: string; content_pillars: string[];
  kpi: Kpi; connection_status: 'not_connected' | 'manual' | 'connected' | 'error'; credentials_ref: string | null; last_sync_at: string | null; permissions: Record<string, unknown> | null; is_satellite: boolean; is_demo?: boolean;
};
type Brand = { id: string; name: string; pillars: { name: string }[] };
type Integration = { key: string; name: string; status: string; note: string };

const CONN_LABEL: Record<string, string> = { not_connected: 'Chưa kết nối', manual: 'Thủ công', connected: 'Đã kết nối', error: 'Lỗi kết nối' };
const CONN_TONE: Record<string, string> = { not_connected: 'gray', manual: 'blue', connected: 'green', error: 'red' };
const PLATFORMS = ['facebook_profile', 'facebook_page', 'facebook_reels', 'tiktok', 'youtube', 'youtube_shorts', 'other'] as const;
const INTEGRATION_OF: Record<string, string> = { facebook_profile: 'meta', facebook_page: 'meta', facebook_reels: 'meta', tiktok: 'tiktok', youtube: 'youtube', youtube_shorts: 'youtube' };

type Form = { id?: string; name: string; platform: string; url: string; avatar_url: string; brand_id: string; target_audience: string; pillars: string; posts_per_day: string; short_videos_per_day: string; originals_per_30_days: string; connection_status: string; credentials_ref: string; is_satellite: boolean };
const blank: Form = { name: '', platform: 'facebook_page', url: '', avatar_url: '', brand_id: '', target_audience: '', pillars: '', posts_per_day: '', short_videos_per_day: '', originals_per_30_days: '', connection_status: 'manual', credentials_ref: '', is_satellite: false };
const toForm = (c: Channel): Form => ({
  id: c.id, name: c.name, platform: c.platform, url: c.url ?? '', avatar_url: c.avatar_url ?? '', brand_id: c.brand_id ?? '', target_audience: c.target_audience ?? '', pillars: (c.content_pillars ?? []).join(', '),
  posts_per_day: c.kpi?.posts_per_day != null ? String(c.kpi.posts_per_day) : '', short_videos_per_day: c.kpi?.short_videos_per_day != null ? String(c.kpi.short_videos_per_day) : '',
  originals_per_30_days: c.kpi?.originals_per_30_days != null ? String(c.kpi.originals_per_30_days) : '', connection_status: c.connection_status, credentials_ref: c.credentials_ref ?? '', is_satellite: c.is_satellite,
});
const numOrUndef = (s: string) => (s.trim() === '' ? undefined : Number(s));

export default function ChannelsPage() {
  const { data, error, loading, reload } = useApi<{ items: Channel[] }>('/channels');
  const { data: brands } = useApi<{ items: Brand[] }>('/brands');
  const { data: integ } = useApi<{ items: Integration[] }>('/integrations');
  const { data: me } = useApi<{ role: string }>('/auth/me');
  const { busy, run } = useAction();
  const { confirm } = useUi();
  const [form, setForm] = useState<Form | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [connectFor, setConnectFor] = useState<Channel | null>(null);
  const canWrite = me ? me.role !== 'viewer' : false;
  const items = data?.items ?? [];
  const brandName = (id: string | null) => brands?.items.find((b) => b.id === id)?.name ?? '—';
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    if (!form) return;
    setFormErr(null);
    if (!form.name.trim()) { setFormErr('Cần nhập tên kênh'); return; }
    const kpi: Kpi = {};
    const a = numOrUndef(form.posts_per_day), b = numOrUndef(form.short_videos_per_day), c = numOrUndef(form.originals_per_30_days);
    for (const v of [a, b, c]) if (v !== undefined && (Number.isNaN(v) || v < 0)) { setFormErr('KPI phải là số không âm'); return; }
    if (a !== undefined) kpi.posts_per_day = a;
    if (b !== undefined) kpi.short_videos_per_day = b;
    if (c !== undefined) kpi.originals_per_30_days = c;
    const body = {
      name: form.name.trim(), platform: form.platform, url: form.url.trim() || null, avatar_url: form.avatar_url.trim() || null, brand_id: form.brand_id || null,
      target_audience: form.target_audience.trim(), content_pillars: form.pillars.split(',').map((s) => s.trim()).filter(Boolean), kpi,
      connection_status: form.connection_status, credentials_ref: form.credentials_ref.trim() || null, is_satellite: form.is_satellite,
    };
    const r = await run('save', () => api(form.id ? `/channels/${form.id}` : '/channels', { method: form.id ? 'PATCH' : 'POST', body }), form.id ? 'Đã cập nhật kênh' : 'Đã thêm kênh');
    if (r !== undefined) { setForm(null); reload(); }
  };

  const del = async (c: Channel) => {
    const ok = await confirm({ title: `Xoá kênh “${c.name}”?`, body: 'Các nội dung/số liệu đã gắn kênh sẽ mất liên kết kênh. Không thể hoàn tác.', confirmLabel: 'Xoá kênh', danger: true });
    if (!ok) return;
    const r = await run('del-' + c.id, () => api(`/channels/${c.id}`, { method: 'DELETE' }), 'Đã xoá kênh');
    if (r !== undefined) reload();
  };

  const integFor = (c: Channel) => integ?.items.find((i) => i.key === INTEGRATION_OF[c.platform]);

  return (
    <div>
      <PageHeader title="Kênh" desc="Quản lý các kênh nội dung, KPI từng kênh và trạng thái kết nối."
        actions={canWrite ? <Button variant="primary" onClick={() => { setFormErr(null); setForm({ ...blank, brand_id: brands?.items[0]?.id ?? '' }); }}><Plus className="h-4 w-4" />Thêm kênh</Button> : undefined} />

      <div className="mb-4 space-y-2">
        <Notice tone="blue"><strong>Chưa kết nối API — dùng quy trình xuất &amp; đăng thủ công.</strong> Hệ thống chưa có connector OAuth nào cho Facebook, TikTok hay YouTube (xem trạng thái ở danh sách tích hợp). Bạn xuất nội dung đã duyệt rồi tự đăng, sau đó nhập số liệu ở mục Phân tích hiệu quả.</Notice>
        <Notice tone="amber">Facebook cá nhân <strong>không có API đăng bài</strong> như Facebook Page — chỉ có thể đăng thủ công. Số liệu của kênh này phải nhập tay hoặc import CSV.</Notice>
        <Notice tone="red"><strong>Chính sách:</strong> không dùng bot tương tác giả, không mua view/like/follow, không spam hay đăng hàng loạt nội dung trùng lặp. Kênh vệ tinh phải đăng nội dung có giá trị riêng và tuân thủ điều khoản từng nền tảng.</Notice>
      </div>

      <ErrorNote message={error} />
      {loading && !data && <Spinner />}
      {data && !items.length && <Empty title="Chưa có kênh nào" hint="Thêm kênh đầu tiên để gắn cho nội dung và số liệu." action={canWrite ? <Button variant="primary" onClick={() => setForm({ ...blank, brand_id: brands?.items[0]?.id ?? '' })}>Thêm kênh</Button> : undefined} />}

      <div className="grid gap-3 lg:grid-cols-2">
        {items.map((c) => {
          const perms = c.permissions ? Object.entries(c.permissions) : [];
          return (
            <Card key={c.id} pad={false}>
              <div className="flex items-start gap-3 p-4">
                {c.avatar_url ? <img src={c.avatar_url} alt="" className="h-12 w-12 shrink-0 rounded-full border border-line object-cover" />
                  : <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface2 text-lg font-semibold text-muted" aria-hidden>{c.name.slice(0, 1).toUpperCase()}</div>}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h3 className="break-words font-semibold">{c.name}</h3>
                    {c.is_satellite && <Badge tone="gold">Kênh vệ tinh</Badge>}
                    {c.is_demo && <Badge tone="amber">DEMO</Badge>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                    <Badge tone="teal">{PLATFORM_LABEL[c.platform] ?? c.platform}</Badge>
                    <Badge tone={CONN_TONE[c.connection_status]}>{CONN_LABEL[c.connection_status]}</Badge>
                  </div>
                  {c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex max-w-full items-center gap-1 break-all text-xs text-brand hover:underline"><ExternalLink className="h-3 w-3 shrink-0" />{c.url}</a> : <p className="mt-1 text-xs text-muted">Chưa có URL</p>}
                </div>
              </div>
              <dl className="grid gap-x-4 gap-y-2 border-t border-line px-4 py-3 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-muted">Thương hiệu</dt><dd>{brandName(c.brand_id)}</dd></div>
                <div><dt className="text-xs text-muted">Đối tượng mục tiêu</dt><dd className="break-words">{c.target_audience || '—'}</dd></div>
                <div className="sm:col-span-2"><dt className="text-xs text-muted">Trụ cột nội dung</dt><dd className="mt-0.5 flex flex-wrap gap-1">{c.content_pillars?.length ? c.content_pillars.map((p) => <Badge key={p}>{p}</Badge>) : '—'}</dd></div>
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted">KPI</dt>
                  <dd className="mt-0.5 grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="rounded-lg bg-surface2 p-2"><p className="text-base font-semibold tabular-nums">{c.kpi?.posts_per_day ?? '—'}</p>bài/ngày</div>
                    <div className="rounded-lg bg-surface2 p-2"><p className="text-base font-semibold tabular-nums">{c.kpi?.short_videos_per_day ?? '—'}</p>video ngắn/ngày</div>
                    <div className="rounded-lg bg-surface2 p-2"><p className="text-base font-semibold tabular-nums">{c.kpi?.originals_per_30_days ?? '—'}</p>nội dung gốc/30 ngày</div>
                  </dd>
                </div>
                <div><dt className="text-xs text-muted">Tham chiếu thông tin xác thực</dt><dd className="break-all">{c.credentials_ref || '—'}</dd></div>
                <div><dt className="text-xs text-muted">Đồng bộ lần cuối</dt><dd>{c.last_sync_at ? fmtDateTime(c.last_sync_at) : 'Chưa đồng bộ'}</dd></div>
                <div className="sm:col-span-2"><dt className="text-xs text-muted">Quyền</dt><dd className="break-words">{perms.length ? perms.map(([k, v]) => `${k}: ${String(v)}`).join(' · ') : 'Chưa cấp quyền API nào'}</dd></div>
              </dl>
              <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
                <Button size="sm" onClick={() => setConnectFor(c)}><Plug className="h-4 w-4" />Kết nối</Button>
                {canWrite && <Button size="sm" onClick={() => { setFormErr(null); setForm(toForm(c)); }}><Pencil className="h-4 w-4" />Sửa</Button>}
                {canWrite && <Button size="sm" variant="danger" busy={busy === 'del-' + c.id} onClick={() => del(c)}><Trash2 className="h-4 w-4" />Xoá</Button>}
              </div>
            </Card>
          );
        })}
      </div>

      <Modal open={!!connectFor} onClose={() => setConnectFor(null)} title={`Kết nối “${connectFor?.name ?? ''}”` } footer={<Button onClick={() => setConnectFor(null)}>Đóng</Button>}>
        {connectFor && (() => {
          const i = integFor(connectFor);
          return (
            <div className="space-y-3 text-sm">
              <Notice tone="amber"><strong>Chưa triển khai.</strong> Chưa có connector OAuth cho nền tảng này nên không thể kết nối. Hệ thống không giả lập kết nối thành công.</Notice>
              {i && <p><strong>{i.name}</strong> — trạng thái: <Badge tone="amber">{i.status}</Badge><br /><span className="text-muted">{i.note}</span></p>}
              {connectFor.platform === 'facebook_profile' && <p className="text-muted">Facebook cá nhân không có API đăng bài. Hãy dùng quy trình xuất và đăng thủ công.</p>}
              <p className="text-muted">Trong lúc chờ: giữ trạng thái “Thủ công”, xuất nội dung đã duyệt, tự đăng, rồi nhập số liệu ở Phân tích hiệu quả.</p>
            </div>
          );
        })()}
      </Modal>

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Sửa kênh' : 'Thêm kênh'} wide
        footer={<><Button onClick={() => setForm(null)}>Huỷ</Button><Button variant="primary" busy={busy === 'save'} onClick={save}>Lưu</Button></>}>
        {form && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><ErrorNote message={formErr} /></div>
            <Field label="Tên kênh *"><Input value={form.name} maxLength={200} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Nền tảng"><Select value={form.platform} onChange={(e) => set('platform', e.target.value)}>{PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}</Select></Field>
            <Field label="URL kênh"><Input type="url" value={form.url} placeholder="https://…" onChange={(e) => set('url', e.target.value)} /></Field>
            <Field label="URL ảnh đại diện"><Input type="url" value={form.avatar_url} placeholder="https://…" onChange={(e) => set('avatar_url', e.target.value)} /></Field>
            <Field label="Thương hiệu"><Select value={form.brand_id} onChange={(e) => set('brand_id', e.target.value)}><option value="">— Không gắn —</option>{brands?.items.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            <Field label="Trạng thái kết nối" hint="Chọn “Đã kết nối” chỉ để ghi nhận thủ công; chưa có connector thật."><Select value={form.connection_status} onChange={(e) => set('connection_status', e.target.value)}>{Object.entries(CONN_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Đối tượng mục tiêu" className="sm:col-span-2"><Textarea className="min-h-16" value={form.target_audience} maxLength={500} onChange={(e) => set('target_audience', e.target.value)} /></Field>
            <Field label="Trụ cột nội dung (phân cách bằng dấu phẩy)" className="sm:col-span-2" hint={brands?.items.find((b) => b.id === form.brand_id)?.pillars.length ? `Gợi ý từ thương hiệu: ${brands.items.find((b) => b.id === form.brand_id)?.pillars.map((p) => p.name).join(', ')}` : undefined}><Input value={form.pillars} onChange={(e) => set('pillars', e.target.value)} /></Field>
            <div className="grid grid-cols-3 gap-2 sm:col-span-2">
              <Field label="Bài/ngày"><Input type="number" min={0} max={50} step="any" value={form.posts_per_day} onChange={(e) => set('posts_per_day', e.target.value)} /></Field>
              <Field label="Video ngắn/ngày"><Input type="number" min={0} max={50} step="any" value={form.short_videos_per_day} onChange={(e) => set('short_videos_per_day', e.target.value)} /></Field>
              <Field label="Nội dung gốc/30 ngày"><Input type="number" min={0} max={5000} step="any" value={form.originals_per_30_days} onChange={(e) => set('originals_per_30_days', e.target.value)} /></Field>
            </div>
            <Field label="Tham chiếu thông tin xác thực (credentials_ref)" className="sm:col-span-2" hint={<span className="text-warn">Chỉ nhập TÊN/ID tham chiếu (ví dụ “meta-app-1”). TUYỆT ĐỐI không nhập mật khẩu, token hay mã 2FA của mạng xã hội vào đây.</span>}><Input value={form.credentials_ref} maxLength={200} autoComplete="off" onChange={(e) => set('credentials_ref', e.target.value)} /></Field>
            <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" className="mt-1" checked={form.is_satellite} onChange={(e) => set('is_satellite', e.target.checked)} /><span>Đây là kênh vệ tinh (kênh phụ hỗ trợ kênh chính; vẫn phải đăng nội dung thật, không spam).</span></label>
          </div>
        )}
      </Modal>
    </div>
  );
}

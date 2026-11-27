'use client';
import { useMemo, useState } from 'react';
import { ImageIcon, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/client';
import { Badge, Button, Empty, ErrorNote, Field, Input, Modal, Notice, Select, Textarea, useAction, useUi } from '@/components/ui';
import { MediaPickerModal, MediaThumb } from './media-bits';
import { KIND_LABEL, type Character, type MediaItem } from './types';

type Form = { id?: string; kind: Character['kind']; name: string; tag: string; description: string; reference_asset_id: string | null; consent_confirmed: boolean };
const blank: Form = { kind: 'character', name: '', tag: '', description: '', reference_asset_id: null, consent_confirmed: false };

export function Library({ characters, media, reload, reloadMedia }: { characters: Character[]; media: MediaItem[]; reload: () => void; reloadMedia: () => void }) {
  const { confirm } = useUi();
  const { busy, run } = useAction();
  const [kind, setKind] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [picker, setPicker] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const byId = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);
  const list = characters.filter((c) => !kind || c.kind === kind);
  const needsConsent = form && (form.kind === 'character' || form.kind === 'voice');

  async function submit() {
    if (!form) return;
    setErr(null);
    const body = { kind: form.kind, name: form.name.trim(), tag: form.tag.trim() || null, description: form.description, reference_asset_id: form.reference_asset_id, consent_confirmed: form.consent_confirmed };
    if (!body.name) { setErr('Cần nhập tên'); return; }
    const ok = await run('save', async () => { await api(form.id ? `/characters/${form.id}` : '/characters', { method: form.id ? 'PATCH' : 'POST', body }); return true; }, form.id ? 'Đã cập nhật' : 'Đã thêm vào thư viện');
    if (ok) { setForm(null); reload(); }
  }
  async function del(c: Character) {
    if (!(await confirm({ title: `Xoá “${c.name}”?`, body: 'Các cảnh đang dùng mục này sẽ không còn nhân vật/tài sản tham chiếu.', confirmLabel: 'Xoá', danger: true }))) return;
    await run('del', async () => { await api(`/characters/${c.id}`, { method: 'DELETE' }); reload(); }, 'Đã xoá');
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Lọc loại" value={kind} onChange={(e) => setKind(e.target.value)} className="max-w-48"><option value="">Mọi loại</option>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Button variant="primary" className="ml-auto" onClick={() => { setErr(null); setForm(blank); }}><Plus className="h-4 w-4" />Thêm mới</Button>
      </div>
      <Notice tone="blue">Chỉ dùng khuôn mặt/giọng nói khi đã có sự đồng ý của người đó. Tag @ chỉ có tác dụng nếu bạn đã tạo đúng tag trong Google Flow.</Notice>
      {list.length === 0 ? <Empty title="Thư viện trống" hint="Thêm nhân vật, sản phẩm, bối cảnh, logo, giọng nói hoặc trang phục để dùng nhất quán giữa các cảnh." /> : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((c) => {
            const a = c.reference_asset_id ? byId.get(c.reference_asset_id) : undefined;
            return (
              <li key={c.id} className="flex gap-3 rounded-xl border border-line bg-surface p-3">
                {a ? <MediaThumb item={a} className="h-16 w-16 shrink-0 rounded-lg" /> : <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-surface2 text-muted"><ImageIcon className="h-5 w-5" /></div>}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5"><p className="truncate text-sm font-semibold">{c.name}</p><Badge tone="blue">{KIND_LABEL[c.kind]}</Badge>{c.tag && <Badge tone="gold">{c.tag}</Badge>}</div>
                  {c.description && <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted">{c.description}</p>}
                  {(c.kind === 'character' || c.kind === 'voice') && <p className="mt-1"><Badge tone={c.consent_confirmed ? 'green' : 'red'}>{c.consent_confirmed ? 'Đã xác nhận quyền sử dụng' : 'Chưa xác nhận quyền'}</Badge></p>}
                  <div className="mt-2 flex gap-1.5">
                    <Button size="sm" onClick={() => { setErr(null); setForm({ id: c.id, kind: c.kind, name: c.name, tag: c.tag ?? '', description: c.description ?? '', reference_asset_id: c.reference_asset_id, consent_confirmed: c.consent_confirmed }); }}><Pencil className="h-3.5 w-3.5" />Sửa</Button>
                    <Button size="sm" variant="ghost" onClick={() => void del(c)} aria-label={`Xoá ${c.name}`}><Trash2 className="h-3.5 w-3.5 text-danger" /></Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Sửa mục thư viện' : 'Thêm vào thư viện'}
        footer={<><Button onClick={() => setForm(null)}>Huỷ</Button><Button variant="primary" busy={busy === 'save'} onClick={() => void submit()}>Lưu</Button></>}>
        {form && (
          <div className="space-y-3">
            <ErrorNote message={err} />
            <Field label="Loại"><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Character['kind'] })}>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Tên"><Input value={form.name} maxLength={200} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Tag @ (tuỳ chọn)" hint="Ví dụ @lyvan. Chỉ điền khi đã tạo tag này trong Google Flow."><Input value={form.tag} maxLength={60} onChange={(e) => setForm({ ...form, tag: e.target.value })} placeholder="@ten_nhan_vat" /></Field>
            <Field label="Mô tả (ngoại hình, phong cách…)"><Textarea value={form.description} maxLength={2000} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <div className="rounded-lg border border-line p-2">
              <p className="mb-1 text-xs font-medium text-muted">Ảnh tham chiếu</p>
              {form.reference_asset_id && byId.get(form.reference_asset_id) && <MediaThumb item={byId.get(form.reference_asset_id)!} className="mb-2 h-28 w-28 rounded-lg" />}
              <div className="flex gap-1.5"><Button size="sm" onClick={() => setPicker(true)}><ImageIcon className="h-3.5 w-3.5" />Chọn / tải ảnh</Button>{form.reference_asset_id && <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, reference_asset_id: null })}>Bỏ ảnh</Button>}</div>
            </div>
            {needsConsent && (
              <label className="flex items-start gap-2 rounded-lg bg-warn/10 p-3 text-sm">
                <input type="checkbox" className="mt-1" checked={form.consent_confirmed} onChange={(e) => setForm({ ...form, consent_confirmed: e.target.checked })} />
                <span>Tôi xác nhận đã có sự đồng ý/cấp quyền của chủ thể để dùng {form.kind === 'voice' ? 'giọng nói' : 'khuôn mặt'} này trong nội dung video.</span>
              </label>
            )}
          </div>
        )}
      </Modal>
      <MediaPickerModal open={picker} onClose={() => setPicker(false)} kinds={['image']} media={media} onUploaded={reloadMedia} onPick={(m) => setForm((f) => (f ? { ...f, reference_asset_id: m.id } : f))} />
    </div>
  );
}

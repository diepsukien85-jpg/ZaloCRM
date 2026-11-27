'use client';
import { useMemo, useRef, useState } from 'react';
import { Link2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { api, fmtDateTime, PRIVACY_LABEL, useApi } from '@/lib/client';
import { Badge, Button, Card, CopyButton, Empty, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Tabs, Textarea, useAction, useUi } from '@/components/ui';
import { fmtSize, MediaThumb, uploadMedia } from '@/components/video/media-bits';
import type { MediaItem } from '@/components/video/types';

type Resp = { items: MediaItem[]; allowed: string[] };
const KIND_FILTERS = [{ id: 'all', label: 'Tất cả' }, { id: 'image', label: 'Ảnh' }, { id: 'video', label: 'Video' }, { id: 'audio', label: 'Âm thanh' }, { id: 'document', label: 'Tài liệu' }];
const KIND_LABEL: Record<string, string> = { image: 'Ảnh', video: 'Video', audio: 'Âm thanh', document: 'Tài liệu' };
const PRIVACY_TONE: Record<string, string> = { private: 'red', internal: 'gray', public: 'green' };

/** Số giây còn lại của link đã ký (đọc tham số exp). */
function ttl(url: string) { const e = Number(new URL(url, 'http://x').searchParams.get('exp')); return e ? e - Math.floor(Date.now() / 1000) : 0; }
const fullUrl = (u: string) => (typeof window === 'undefined' ? u : location.origin + u);

type UpRes = { name: string; ok: boolean; msg: string };

function Detail({ item, onClose, onChanged, onDeleted, onUrl }: { item: MediaItem; onClose: () => void; onChanged: (p: Partial<MediaItem> & { id: string }) => void; onDeleted: () => void; onUrl: (id: string, url: string) => void }) {
  const { confirm } = useUi();
  const { busy, run } = useAction();
  const [privacy, setPrivacy] = useState(item.privacy);
  const [tags, setTags] = useState((item.tags ?? []).join(', '));
  const [transcript, setTranscript] = useState('');
  const [tChanged, setTChanged] = useState(false);
  const left = ttl(item.url);

  async function save() {
    const body: Record<string, unknown> = { privacy, tags: tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20) };
    if (tChanged) body.transcript = transcript;
    const r = await run('save', () => api<{ id: string; privacy: string; tags: string[] }>(`/media/${item.id}`, { method: 'PATCH', body }), 'Đã lưu');
    if (r) { onChanged({ id: item.id, privacy: r.privacy, tags: r.tags, ...(tChanged ? { has_transcript: transcript.length > 0 } : {}) }); onClose(); }
  }
  async function refresh() {
    const r = await run('url', () => api<{ url: string }>(`/media/${item.id}/url`), 'Đã làm mới liên kết (hiệu lực ~15 phút)');
    if (r) onUrl(item.id, r.url);
  }
  async function del() {
    if (!(await confirm({ title: `Xoá “${item.filename}”?`, body: 'File sẽ bị xoá vĩnh viễn khỏi máy chủ. Các cảnh video đang dùng file này sẽ mất tài sản gán.', confirmLabel: 'Xoá file', danger: true }))) return;
    const r = await run('del', () => api(`/media/${item.id}`, { method: 'DELETE' }), 'Đã xoá file');
    if (r) { onDeleted(); onClose(); }
  }
  return (
    <Modal open onClose={onClose} title={item.filename} wide footer={<><Button variant="danger" className="mr-auto" busy={busy === 'del'} onClick={() => void del()}><Trash2 className="h-4 w-4" />Xoá</Button><Button onClick={onClose}>Đóng</Button><Button variant="primary" busy={busy === 'save'} onClick={() => void save()}>Lưu thay đổi</Button></>}>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <MediaThumb item={item} controls className="aspect-video w-full rounded-lg" />
          <p className="text-xs text-muted">{KIND_LABEL[item.kind]} · {item.mime} · {fmtSize(item.size_bytes)} · tải lên {fmtDateTime(item.created_at)}</p>
          <div className="rounded-lg border border-line p-2">
            <p className="text-xs font-medium text-muted">Liên kết đã ký</p>
            <p className="text-xs text-muted">{left > 0 ? `Còn hiệu lực khoảng ${Math.ceil(left / 60)} phút.` : 'Liên kết đã hết hạn — hãy làm mới.'} Người có link xem được file mà không cần đăng nhập đến khi hết hạn.</p>
            <div className="mt-2 flex flex-wrap gap-1.5"><CopyButton text={fullUrl(item.url)} label="Sao chép link" /><Button size="sm" busy={busy === 'url'} onClick={() => void refresh()}><RefreshCw className="h-3.5 w-3.5" />Làm mới link</Button></div>
          </div>
        </div>
        <div className="space-y-3">
          <Field label="Quyền riêng tư"><Select value={privacy} onChange={(e) => setPrivacy(e.target.value)}>{Object.entries(PRIVACY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Tag (phân tách bằng dấu phẩy)"><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ví dụ: b-roll, cảnh quay, nhạc nền" /></Field>
          <Field label="Transcript / văn bản" hint="Dán văn bản lời nói vào đây. Chuyển giọng nói thành chữ tự động CHƯA được triển khai. Lưu sẽ ghi đè transcript đã có.">
            <Textarea rows={7} value={transcript} onChange={(e) => { setTranscript(e.target.value); setTChanged(true); }} placeholder={item.has_transcript ? 'File này đã có transcript (không hiển thị lại). Gõ để thay thế.' : 'Chưa có transcript'} />
          </Field>
          {item.has_transcript && <Badge tone="green">Đã có transcript</Badge>}
        </div>
      </div>
    </Modal>
  );
}

export default function MediaPage() {
  const { data, error, loading, reload, setData } = useApi<Resp>('/media');
  const { toast } = useUi();
  const [kind, setKind] = useState('all');
  const [privacy, setPrivacy] = useState('internal');
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<UpRes[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const items = useMemo(() => (data?.items ?? []).filter((i) => kind === 'all' || i.kind === kind), [data, kind]);
  const selected = data?.items.find((i) => i.id === sel) ?? null;
  const patchLocal = (p: Partial<MediaItem> & { id: string }) => setData((d) => (d ? { ...d, items: d.items.map((i) => (i.id === p.id ? { ...i, ...p } : i)) } : d));

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true); setResults([]);
    const out: UpRes[] = [];
    for (const f of Array.from(files)) {
      try { await uploadMedia(f, privacy); out.push({ name: f.name, ok: true, msg: 'Đã tải lên' }); }
      catch (e) { out.push({ name: f.name, ok: false, msg: (e as Error).message }); }
      setResults([...out]);
    }
    setUploading(false);
    if (input.current) input.current.value = '';
    const ok = out.filter((o) => o.ok).length;
    if (ok) toast(`Đã tải lên ${ok}/${out.length} file`, ok === out.length ? 'ok' : 'info');
    else toast('Không file nào được tải lên', 'err');
    reload();
  }

  return (
    <div>
      <PageHeader title="Thư viện tư liệu" desc="Ảnh, video, âm thanh và tài liệu dùng cho nội dung/video. File được kiểm tra loại và nội dung ở máy chủ trước khi lưu." />
      <Card title="Tải lên" className="mb-4">
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Quyền riêng tư mặc định" className="w-52"><Select value={privacy} onChange={(e) => setPrivacy(e.target.value)}>{Object.entries(PRIVACY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <input ref={input} type="file" multiple className="hidden" onChange={(e) => void onFiles(e.target.files)} />
            <Button variant="primary" busy={uploading} onClick={() => input.current?.click()}><Upload className="h-4 w-4" />Chọn file để tải lên</Button>
          </div>
          <p className="text-xs text-muted">Loại MIME được phép: {data ? data.allowed.join(', ') : '…'}. Giới hạn dung lượng mỗi file do máy chủ quy định (mặc định 25 MB); file vượt giới hạn hoặc sai định dạng sẽ bị từ chối kèm lý do.</p>
          {results.length > 0 && (
            <ul className="space-y-1 text-sm">{results.map((r, i) => <li key={i} className={r.ok ? 'text-ok' : 'text-danger'}>{r.ok ? '✓' : '✗'} <span className="break-all">{r.name}</span> — {r.msg}</li>)}</ul>
          )}
        </div>
      </Card>

      <div className="mb-3"><Tabs tabs={KIND_FILTERS} value={kind} onChange={setKind} /></div>
      <ErrorNote message={error} />
      {loading && !data ? <Spinner /> : items.length === 0 ? <Empty title={data?.items.length ? 'Không có file thuộc loại này' : 'Thư viện đang trống'} hint="Tải file lên để dùng làm ảnh tham chiếu, tài sản cảnh video hoặc tư liệu nội dung." /> : (
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {items.map((m) => (
            <li key={m.id} className="overflow-hidden rounded-xl border border-line bg-surface">
              <button onClick={() => setSel(m.id)} className="block w-full text-left">
                <MediaThumb item={m} className="aspect-video w-full" />
                <div className="space-y-1 p-2.5">
                  <p className="truncate text-sm font-medium" title={m.filename}>{m.filename}</p>
                  <p className="text-xs text-muted">{KIND_LABEL[m.kind]} · {fmtSize(m.size_bytes)}</p>
                  <div className="flex flex-wrap gap-1"><Badge tone={PRIVACY_TONE[m.privacy]}>{PRIVACY_LABEL[m.privacy] ?? m.privacy}</Badge>{m.has_transcript && <Badge tone="teal">Transcript</Badge>}{(m.tags ?? []).slice(0, 2).map((t) => <Badge key={t}>{t}</Badge>)}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4"><Notice tone="blue"><span className="inline-flex items-center gap-1"><Link2 className="h-3.5 w-3.5" />Link đã ký hết hạn sau khoảng 15 phút; mở chi tiết để làm mới.</span></Notice></div>

      {selected && <Detail key={selected.id} item={selected} onClose={() => setSel(null)} onChanged={patchLocal} onDeleted={reload} onUrl={(id, url) => patchLocal({ id, url })} />}
    </div>
  );
}

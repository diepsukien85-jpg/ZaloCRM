'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, GripVertical, ImageIcon, Plus, Trash2, Upload, X } from 'lucide-react';
import { api } from '@/lib/client';
import { Badge, Button, Card, Empty, Field, Input, Notice, Select, Textarea, useAction, useUi, clsx } from '@/components/ui';
import { MediaPickerModal, MediaThumb, uploadMedia } from './media-bits';
import { APPROVAL_LABEL, KIND_LABEL, type Character, type MediaItem, type Scene } from './types';

const TEXT_FIELDS: { key: 'shot_description' | 'dialogue' | 'voiceover' | 'camera' | 'lighting' | 'audio' | 'on_screen_text' | 'environment' | 'outfit'; label: string; area?: boolean }[] = [
  { key: 'shot_description', label: 'Mô tả cảnh quay', area: true }, { key: 'dialogue', label: 'Thoại', area: true }, { key: 'voiceover', label: 'Voiceover', area: true },
  { key: 'camera', label: 'Máy quay' }, { key: 'lighting', label: 'Ánh sáng' }, { key: 'audio', label: 'Âm thanh' },
  { key: 'on_screen_text', label: 'Chữ trên màn hình' }, { key: 'environment', label: 'Môi trường' }, { key: 'outfit', label: 'Trang phục' },
];
type Draft = Pick<Scene, 'duration_sec' | 'shot_description' | 'dialogue' | 'voiceover' | 'camera' | 'lighting' | 'audio' | 'on_screen_text' | 'environment' | 'outfit' | 'character_id' | 'reference_asset_id' | 'generated_asset_id' | 'approval_status'>;
const KEYS: (keyof Draft)[] = ['duration_sec', 'shot_description', 'dialogue', 'voiceover', 'camera', 'lighting', 'audio', 'on_screen_text', 'environment', 'outfit', 'character_id', 'reference_asset_id', 'generated_asset_id', 'approval_status'];
const toDraft = (s: Scene): Draft => ({
  duration_sec: s.duration_sec, shot_description: s.shot_description ?? '', dialogue: s.dialogue ?? '', voiceover: s.voiceover ?? '', camera: s.camera ?? '', lighting: s.lighting ?? '', audio: s.audio ?? '',
  on_screen_text: s.on_screen_text ?? '', environment: s.environment ?? '', outfit: s.outfit ?? '', character_id: s.character_id, reference_asset_id: s.reference_asset_id, generated_asset_id: s.generated_asset_id, approval_status: s.approval_status,
});
const APPROVAL_TONE: Record<string, string> = { draft: 'gray', approved: 'green', rejected: 'red' };

type CardProps = {
  scene: Scene; index: number; total: number; characters: Character[]; media: MediaItem[]; highlight: boolean;
  onSaved: (row: Scene) => void; onDelete: () => void; onDuplicate: () => void; onMove: (dir: -1 | 1) => void; reloadMedia: () => void;
  drag: { onStart: () => void; onDrop: () => void; over: boolean };
};

function SceneCard({ scene, index, total, characters, media, highlight, onSaved, onDelete, onDuplicate, onMove, reloadMedia, drag }: CardProps) {
  const { toast } = useUi();
  const [draft, setDraft] = useState<Draft>(() => toDraft(scene));
  const draftRef = useRef(draft);
  const savedRef = useRef<Draft>(toDraft(scene));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [picker, setPicker] = useState<null | 'reference_asset_id' | 'generated_asset_id'>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const onSavedRef = useRef(onSaved);
  useEffect(() => { onSavedRef.current = onSaved; });

  const save = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const cur = draftRef.current, base = savedRef.current;
    const diff: Record<string, unknown> = {};
    for (const k of KEYS) if (cur[k] !== base[k]) diff[k] = cur[k];
    if (!Object.keys(diff).length) { setState('idle'); return; }
    if ('duration_sec' in diff) {
      const d = diff.duration_sec as number;
      if (!Number.isInteger(d) || d < 1 || d > 60) { delete diff.duration_sec; setErr('Thời lượng cảnh phải là số nguyên 1–60 giây'); setState('error'); if (!Object.keys(diff).length) return; }
      else setErr(null);
    } else setErr(null);
    setState('saving');
    try {
      const row = await api<Scene>(`/video/scenes/${scene.id}`, { method: 'PATCH', body: diff });
      savedRef.current = { ...savedRef.current, ...diff } as Draft;
      onSavedRef.current(row);
      setState((s) => (s === 'error' ? s : 'saved'));
    } catch (e) { setErr((e as Error).message); setState('error'); }
  }, [scene.id]);
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; });

  // Lưu nốt thay đổi còn dở khi đổi tab/rời trang.
  useEffect(() => () => {
    if (timer.current) { clearTimeout(timer.current); void saveRef.current(); }
  }, []);

  function update(patch: Partial<Draft>, now = false) {
    draftRef.current = { ...draftRef.current, ...patch };
    setDraft(draftRef.current);
    setState('dirty');
    if (timer.current) clearTimeout(timer.current);
    if (now) void save(); else timer.current = setTimeout(() => void saveRef.current(), 1200);
  }

  const byId = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);
  const ref = draft.reference_asset_id ? byId.get(draft.reference_asset_id) : undefined;
  const gen = draft.generated_asset_id ? byId.get(draft.generated_asset_id) : undefined;
  const ch = characters.find((c) => c.id === draft.character_id);

  async function upload(slot: 'reference_asset_id' | 'generated_asset_id', f: File | undefined) {
    if (!f) return;
    setUploading(slot);
    try { const m = await uploadMedia(f); reloadMedia(); update({ [slot]: m.id }, true); toast('Đã tải lên và gán cho cảnh'); }
    catch (e) { toast((e as Error).message, 'err'); }
    finally { setUploading(null); }
  }
  const slotUi = (slot: 'reference_asset_id' | 'generated_asset_id', label: string, asset: MediaItem | undefined, id: string | null, kinds: MediaItem['kind'][]) => (
    <div className="rounded-lg border border-line p-2">
      <p className="mb-1 text-xs font-medium text-muted">{label}</p>
      {id ? (asset ? <MediaThumb item={asset} controls className="aspect-video w-full rounded" /> : <p className="rounded bg-surface2 p-2 text-xs text-muted">Tư liệu không còn trong danh sách (đã xoá hoặc chưa tải lại).</p>) : <p className="text-xs text-muted">Chưa gán</p>}
      {asset && <p className="mt-1 truncate text-xs" title={asset.filename}>{asset.filename}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <label className={clsx('inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-xs font-medium hover:bg-surface2', uploading === slot && 'opacity-50')}>
          <Upload className="h-3.5 w-3.5" />{uploading === slot ? 'Đang tải…' : 'Tải lên'}
          <input type="file" className="hidden" disabled={!!uploading} accept={kinds.includes('video') ? 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm' : 'image/jpeg,image/png,image/webp'} onChange={(e) => { void upload(slot, e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <Button size="sm" onClick={() => setPicker(slot)}><ImageIcon className="h-3.5 w-3.5" />Thư viện</Button>
        {id && <Button size="sm" variant="ghost" onClick={() => update({ [slot]: null }, true)} aria-label="Bỏ gán"><X className="h-3.5 w-3.5" /></Button>}
      </div>
      <MediaPickerModal open={picker === slot} onClose={() => setPicker(null)} kinds={kinds} media={media} onUploaded={reloadMedia} onPick={(m) => update({ [slot]: m.id }, true)} />
    </div>
  );

  return (
    <div id={`scene-${scene.id}`} onDragOver={(e) => e.preventDefault()} onDrop={drag.onDrop}
      className={clsx('rounded-xl border bg-surface transition', highlight ? 'border-brand ring-2 ring-brand/30' : 'border-line', drag.over && 'border-gold')}>
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', scene.id); drag.onStart(); }} title="Kéo để đổi thứ tự" className="hidden cursor-grab rounded p-1 text-muted hover:bg-surface2 md:block"><GripVertical className="h-4 w-4" /></span>
        <h3 className="text-sm font-semibold">Cảnh {scene.scene_no}</h3>
        <Badge tone={APPROVAL_TONE[draft.approval_status]}>{APPROVAL_LABEL[draft.approval_status]}</Badge>
        <span className="text-xs text-muted" aria-live="polite">{state === 'saving' ? 'Đang lưu…' : state === 'dirty' ? 'Chưa lưu' : state === 'saved' ? 'Đã lưu' : state === 'error' ? 'Lỗi lưu' : ''}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {state === 'dirty' && <Button size="sm" variant="primary" onClick={() => void save()}>Lưu ngay</Button>}
          <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Chuyển cảnh lên"><ArrowUp className="h-4 w-4" /></Button>
          <Button size="sm" variant="ghost" disabled={index === total - 1} onClick={() => onMove(1)} aria-label="Chuyển cảnh xuống"><ArrowDown className="h-4 w-4" /></Button>
          <Button size="sm" variant="ghost" onClick={onDuplicate} aria-label="Nhân bản cảnh"><Copy className="h-4 w-4" /></Button>
          <Button size="sm" variant="ghost" onClick={onDelete} aria-label="Xoá cảnh"><Trash2 className="h-4 w-4 text-danger" /></Button>
        </div>
      </header>
      <div className="space-y-3 p-3">
        {err && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Thời lượng (giây)"><Input type="number" min={1} max={60} value={draft.duration_sec} onChange={(e) => update({ duration_sec: Number(e.target.value) })} /></Field>
          <Field label="Trạng thái duyệt">
            <Select value={draft.approval_status} onChange={(e) => update({ approval_status: e.target.value as Draft['approval_status'] }, true)}>
              {Object.entries(APPROVAL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Nhân vật / tài sản thư viện" className="col-span-2">
            <Select value={draft.character_id ?? ''} onChange={(e) => update({ character_id: e.target.value || null }, true)}>
              <option value="">(Không chọn)</option>
              {characters.map((c) => <option key={c.id} value={c.id}>[{KIND_LABEL[c.kind]}] {c.name}{c.tag ? ` ${c.tag}` : ''}</option>)}
            </Select>
          </Field>
        </div>
        {ch && !ch.consent_confirmed && (ch.kind === 'character' || ch.kind === 'voice') && <Notice tone="amber">“{ch.name}” chưa xác nhận quyền sử dụng khuôn mặt/giọng nói. Hãy xác nhận ở tab Thư viện trước khi dùng cho video.</Notice>}
        <div className="grid gap-3 md:grid-cols-3">
          {TEXT_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} className={f.area ? 'md:col-span-1' : ''}>
              {f.area ? <Textarea rows={3} value={draft[f.key] ?? ""} onChange={(e) => update({ [f.key]: e.target.value })} /> : <Input value={draft[f.key] ?? ""} onChange={(e) => update({ [f.key]: e.target.value })} />}
            </Field>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {slotUi('reference_asset_id', 'Ảnh tham chiếu', ref, draft.reference_asset_id, ['image'])}
          {slotUi('generated_asset_id', 'Tài sản đã tạo (nhập thủ công, từ Google Flow hoặc nguồn khác)', gen, draft.generated_asset_id, ['image', 'video'])}
        </div>
      </div>
    </div>
  );
}

export function Storyboard({ projectId, scenes, characters, media, focusId, reload, reloadMedia, onSceneSaved }: {
  projectId: string; scenes: Scene[]; characters: Character[]; media: MediaItem[]; focusId: string | null;
  reload: () => void; reloadMedia: () => void; onSceneSaved: (row: Scene) => void;
}) {
  const { confirm, toast } = useUi();
  const { busy, run } = useAction();
  const sorted = useMemo(() => [...scenes].sort((a, b) => a.scene_no - b.scene_no), [scenes]);
  const dragId = useRef<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!focusId) return;
    setFlash(focusId);
    const t = setTimeout(() => document.getElementById(`scene-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    const t2 = setTimeout(() => setFlash(null), 2500);
    return () => { clearTimeout(t); clearTimeout(t2); };
  }, [focusId]);

  const reorder = (ids: string[]) => run('reorder', async () => { await api(`/video/projects/${projectId}/reorder`, { body: { scene_ids: ids } }); reload(); });
  function moveBy(i: number, dir: -1 | 1) {
    const ids = sorted.map((s) => s.id); const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void reorder(ids);
  }
  function dropOn(targetId: string) {
    const from = dragId.current; dragId.current = null; setOverId(null);
    if (!from || from === targetId) return;
    const ids = sorted.map((s) => s.id).filter((x) => x !== from);
    ids.splice(ids.indexOf(targetId) + (sorted.findIndex((s) => s.id === from) < sorted.findIndex((s) => s.id === targetId) ? 1 : 0), 0, from);
    void reorder(ids);
  }
  async function del(s: Scene) {
    if (!(await confirm({ title: `Xoá cảnh ${s.scene_no}?`, body: 'Cảnh và prompt của nó sẽ bị xoá vĩnh viễn; các cảnh sau được đánh số lại.', confirmLabel: 'Xoá cảnh', danger: true }))) return;
    await run('del', async () => { await api(`/video/scenes/${s.id}`, { method: 'DELETE' }); reload(); }, 'Đã xoá cảnh');
  }
  const dup = (s: Scene) => run('dup', async () => { await api(`/video/scenes/${s.id}/duplicate`, { method: 'POST', body: {} }); reload(); }, 'Đã nhân bản cảnh');
  const add = () => run('add', async () => { await api(`/video/projects/${projectId}/scenes`, { body: { duration_sec: 8 } }); reload(); toast('Đã thêm cảnh mới'); });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">Mọi chỉnh sửa tự lưu sau khi dừng gõ. Đổi thứ tự sẽ tạo lại prompt Google Flow của tất cả cảnh (prompt sửa tay sẽ bị thay thế).</p>
        <Button variant="primary" busy={busy === 'add'} onClick={add}><Plus className="h-4 w-4" />Thêm cảnh</Button>
      </div>
      {sorted.length === 0 ? <Empty title="Dự án chưa có cảnh nào" hint="Thêm cảnh đầu tiên để bắt đầu viết storyboard." action={<Button variant="primary" busy={busy === 'add'} onClick={add}><Plus className="h-4 w-4" />Thêm cảnh</Button>} /> : (
        <div className={clsx('space-y-3', busy === 'reorder' && 'pointer-events-none opacity-60')}>
          {sorted.map((s, i) => (
            <SceneCard key={s.id} scene={s} index={i} total={sorted.length} characters={characters} media={media} highlight={flash === s.id}
              onSaved={onSceneSaved} onDelete={() => void del(s)} onDuplicate={() => void dup(s)} onMove={(d) => moveBy(i, d)} reloadMedia={reloadMedia}
              drag={{ onStart: () => { dragId.current = s.id; }, onDrop: () => dropOn(s.id), over: overId === s.id }} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Timeline({ scenes, onJump }: { scenes: Scene[]; onJump: (id: string) => void }) {
  const sorted = useMemo(() => [...scenes].sort((a, b) => a.scene_no - b.scene_no), [scenes]);
  const total = sorted.reduce((s, x) => s + x.duration_sec, 0);
  if (!sorted.length) return <Empty title="Chưa có cảnh để dựng timeline" />;
  const starts = sorted.map((_, i) => sorted.slice(0, i).reduce((a, x) => a + x.duration_sec, 0));
  return (
    <Card title="Timeline theo thời lượng cảnh" actions={<Badge tone="blue">Tổng {total}s</Badge>}>
      <div className="overflow-x-auto pb-2">
        <div className="flex gap-1" style={{ minWidth: Math.max(sorted.length * 56, 0) }}>
          {sorted.map((s) => (
            <button key={s.id} onClick={() => onJump(s.id)} title={s.shot_description} style={{ flexGrow: s.duration_sec, flexBasis: 0, minWidth: 52 }}
              className={clsx('rounded-lg border px-2 py-2 text-left text-xs transition hover:brightness-95', s.approval_status === 'approved' ? 'border-ok bg-ok/10' : s.approval_status === 'rejected' ? 'border-danger bg-danger/10' : 'border-line bg-surface2')}>
              <p className="font-semibold">Cảnh {s.scene_no}</p><p className="text-muted">{s.duration_sec}s</p>
              <p className="mt-1 line-clamp-2 break-words text-[11px]">{s.shot_description || '—'}</p>
            </button>
          ))}
        </div>
        <div className="mt-1 flex gap-1" style={{ minWidth: Math.max(sorted.length * 56, 0) }}>
          {sorted.map((s, i) => <span key={s.id} style={{ flexGrow: s.duration_sec, flexBasis: 0, minWidth: 52 }} className="text-[11px] tabular-nums text-muted">{starts[i]}s</span>)}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">Chạm vào một cảnh để nhảy tới thẻ cảnh trong Storyboard. Xanh = đã duyệt, đỏ = từ chối, xám = nháp. Ghép video bằng FFmpeg chưa được triển khai.</p>
    </Card>
  );
}

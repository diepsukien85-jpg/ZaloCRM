'use client';
import { useRef, useState } from 'react';
import { FileText, Music, Upload } from 'lucide-react';
import { Button, Empty, Modal, useUi, clsx } from '@/components/ui';
import type { MediaItem } from './types';

export const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** Tải một file lên /api/media (FormData field 'file'). Ném lỗi với thông báo của server. */
export async function uploadMedia(file: File, privacy = 'internal'): Promise<MediaItem> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('privacy', privacy);
  const res = await fetch('/api/media', { method: 'POST', body: fd, credentials: 'same-origin' });
  const text = await res.text();
  let data: (MediaItem & { error?: string }) | null = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* không phải JSON */ }
  if (!res.ok || !data) throw new Error(data?.error ?? `Lỗi tải lên (${res.status})`);
  return data;
}

export function MediaThumb({ item, className, controls = false }: { item: Pick<MediaItem, 'kind' | 'url' | 'filename'>; className?: string; controls?: boolean }) {
  const box = clsx('flex items-center justify-center overflow-hidden bg-surface2 text-muted', className);
  if (item.kind === 'image') {
    // eslint-disable-next-line @next/next/no-img-element
    return <div className={box}><img src={item.url} alt={item.filename} loading="lazy" className="h-full w-full object-cover" /></div>;
  }
  if (item.kind === 'video') return <div className={box}><video src={item.url} preload="metadata" muted controls={controls} playsInline className="h-full w-full object-cover" /></div>;
  if (item.kind === 'audio') return <div className={clsx(box, 'flex-col gap-1 p-2')}><Music className="h-6 w-6" />{controls && <audio src={item.url} controls preload="none" className="w-full" />}</div>;
  return <div className={box}><FileText className="h-6 w-6" /></div>;
}

/** Hộp chọn file từ thư viện /media (có thể tải lên file mới ngay trong hộp). */
export function MediaPickerModal({ open, onClose, onPick, kinds, media, onUploaded, title = 'Chọn từ thư viện tư liệu' }: {
  open: boolean; onClose: () => void; onPick: (m: MediaItem) => void; kinds: MediaItem['kind'][]; media: MediaItem[]; onUploaded: () => void; title?: string;
}) {
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const items = media.filter((m) => kinds.includes(m.kind));
  const accept = kinds.map((k) => (k === 'image' ? 'image/jpeg,image/png,image/webp' : k === 'video' ? 'video/mp4,video/quicktime,video/webm' : k === 'audio' ? 'audio/*' : 'application/pdf,text/plain,text/csv')).join(',');
  async function onFile(f: File | undefined) {
    if (!f) return;
    setBusy(true);
    try { const m = await uploadMedia(f); toast('Đã tải lên'); onUploaded(); onPick(m); onClose(); }
    catch (e) { toast((e as Error).message, 'err'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  return (
    <Modal open={open} onClose={onClose} title={title} wide footer={<>
      <input ref={input} type="file" accept={accept} className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
      <Button busy={busy} onClick={() => input.current?.click()}><Upload className="h-4 w-4" />Tải file mới lên</Button><Button onClick={onClose}>Đóng</Button></>}>
      {items.length === 0 ? <Empty title="Chưa có tư liệu phù hợp" hint="Tải một file lên để dùng ngay." /> : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {items.map((m) => (
            <li key={m.id}>
              <button onClick={() => { onPick(m); onClose(); }} className="w-full overflow-hidden rounded-lg border border-line text-left hover:border-brand">
                <MediaThumb item={m} className="aspect-video w-full" />
                <p className="truncate px-2 py-1 text-xs" title={m.filename}>{m.filename}</p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

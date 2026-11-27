'use client';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Mic, Paperclip, Square } from 'lucide-react';
import { api, ApiError, fmtDate, PRIVACY_LABEL, useApi, vnDate } from '@/lib/client';
import { Badge, Button, Card, CopyButton, DemoBadge, Empty, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Tabs, Textarea, useAction, useUi } from '@/components/ui';
import { CopyBlock } from '@/components/lv-research-bits';

type Journal = { id: string; entry_date: string; title: string; body: string; source_type: string; privacy: 'private' | 'internal' | 'public'; tags: string[]; media_asset_id: string | null; story_count: number | string; created_at: string };
type Story = {
  id: string; journal_id: string | null; title: string; privacy: string; is_demo: boolean; created_at: string; lessons: string[];
  extracted: Partial<Record<'characters' | 'setting' | 'problem' | 'conflict' | 'decision' | 'action' | 'result' | 'lesson' | 'emotion' | 'viewer_value', string | string[]>> & { not_stated?: string[] };
  suggestions: { broad_keywords?: string[]; ideas?: { title: string; summary: string }[]; hooks?: string[]; facebook_post?: string; short_video_idea?: string };
};
type IdeaRes = { saved: { id: string; title: string }[]; duplicates: { title: string; of: string; similarity: number }[] };
type Uploaded = { id: string; filename: string; kind: string; url?: string };

const SRC: Record<string, string> = { text: 'Văn bản', chat: 'Đoạn chat', lesson: 'Bài học', customer_case: 'Ca khách hàng', audio: 'Âm thanh', video: 'Video', image: 'Hình ảnh' };
const FIELDS: [keyof Story['extracted'], string][] = [['characters', 'Nhân vật'], ['setting', 'Bối cảnh'], ['problem', 'Vấn đề'], ['conflict', 'Mâu thuẫn'], ['decision', 'Quyết định'], ['action', 'Hành động'], ['result', 'Kết quả'], ['lesson', 'Bài học'], ['emotion', 'Cảm xúc'], ['viewer_value', 'Giá trị cho người xem']];
const PRIV_TONE: Record<string, string> = { private: 'red', internal: 'amber', public: 'green' };
const dayOf = (s: string) => String(s).slice(0, 10);

const noop = () => () => {};
const detectRec = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

async function uploadMedia(file: File, privacy: string): Promise<Uploaded> {
  const fd = new FormData();
  fd.append('file', file); fd.append('privacy', privacy);
  const res = await fetch('/api/media', { method: 'POST', body: fd, credentials: 'same-origin' });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.error ?? `Tải lên thất bại (${res.status})`);
  return j as Uploaded;
}

export default function StoriesPage() {
  const { toast, confirm } = useUi();
  const { busy, run } = useAction();
  const [tab, setTab] = useState<'journal' | 'story'>('journal');

  // ---- danh sách nhật ký
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [privF, setPrivF] = useState('');
  const jPath = useMemo(() => { const p = new URLSearchParams(); if (q) p.set('q', q); if (privF) p.set('privacy', privF); return `/journals${p.size ? `?${p}` : ''}`; }, [q, privF]);
  const journals = useApi<{ items: Journal[] }>(jPath);
  const stories = useApi<{ items: Story[] }>('/stories');

  // ---- form thêm
  const blank = { title: '', body: '', source_type: 'text', entry_date: vnDate(), privacy: 'private', tags: '' };
  const [nf, setNf] = useState(blank);
  const [media, setMedia] = useState<Uploaded | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const addJournal = () => run('add', async () => {
    await api('/journals', { body: { title: nf.title.trim(), body: nf.body, source_type: nf.source_type, entry_date: nf.entry_date || undefined, privacy: nf.privacy, tags: nf.tags.split(',').map((s) => s.trim()).filter(Boolean), media_asset_id: media?.id ?? null } });
    setNf({ ...blank, entry_date: nf.entry_date }); setMedia(null); journals.reload();
  }, 'Đã lưu nhật ký');

  // ---- upload file
  const onFile = (file: File | undefined) => {
    if (!file) return;
    run('upload', async () => {
      const m = await uploadMedia(file, nf.privacy);
      setMedia(m);
      if (m.kind === 'audio' || m.kind === 'video' || m.kind === 'image') setNf((x) => ({ ...x, source_type: m.kind }));
    }, 'Đã tải tệp lên và gắn vào nhật ký');
    if (fileRef.current) fileRef.current.value = '';
  };

  // ---- ghi âm
  const canRecord = useSyncExternalStore(noop, detectRec, () => false);
  const [rec, setRec] = useState<{ state: 'idle' | 'recording' | 'done'; secs: number; blob?: Blob; url?: string; mime?: string }>({ state: 'idle', secs: 0 });
  const mrRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); streamRef.current?.getTracks().forEach((t) => t.stop()); }, []);
  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m));
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: BlobPart[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = () => {
        const base = (mr.mimeType || mime || 'audio/webm').split(';')[0];
        const blob = new Blob(chunks, { type: base });
        stream.getTracks().forEach((t) => t.stop());
        if (timerRef.current) clearInterval(timerRef.current);
        setRec((r) => ({ ...r, state: 'done', blob, url: URL.createObjectURL(blob), mime: base }));
      };
      mrRef.current = mr; mr.start();
      setRec({ state: 'recording', secs: 0 });
      timerRef.current = setInterval(() => setRec((r) => ({ ...r, secs: r.secs + 1 })), 1000);
    } catch (e) { toast(`Không thể ghi âm: ${(e as Error).message || 'chưa được cấp quyền micro'}`, 'err'); }
  };
  const stopRec = () => mrRef.current?.state === 'recording' && mrRef.current.stop();
  const uploadRec = () => {
    if (!rec.blob || !rec.mime) return;
    const ext = ({ 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' } as Record<string, string>)[rec.mime] ?? 'webm';
    const file = new File([rec.blob], `ghi-am-${Date.now()}.${ext}`, { type: rec.mime });
    run('upload', async () => { const m = await uploadMedia(file, nf.privacy); setMedia(m); setNf((x) => ({ ...x, source_type: 'audio' })); setRec({ state: 'idle', secs: 0 }); }, 'Đã tải bản ghi âm lên và gắn vào nhật ký');
  };

  // ---- sửa / xoá
  const [edit, setEdit] = useState<(Journal & { tagsTxt: string }) | null>(null);
  const saveEdit = () => edit && run('edit', async () => {
    await api(`/journals/${edit.id}`, { method: 'PATCH', body: { title: edit.title, body: edit.body, privacy: edit.privacy, tags: edit.tagsTxt.split(',').map((s) => s.trim()).filter(Boolean) } });
    setEdit(null); journals.reload();
  }, 'Đã cập nhật nhật ký');
  const delJournal = async (j: Journal) => {
    if (!(await confirm({ title: 'Xoá nhật ký?', body: 'Nhật ký sẽ bị xoá vĩnh viễn. Các câu chuyện đã trích xuất vẫn được giữ.', danger: true, confirmLabel: 'Xoá' }))) return;
    run('del' + j.id, async () => { await api(`/journals/${j.id}`, { method: 'DELETE' }); journals.reload(); }, 'Đã xoá');
  };

  // ---- trích xuất
  const [view, setView] = useState<{ story: Story; demo: boolean } | null>(null);
  const [ideaRes, setIdeaRes] = useState<IdeaRes | null>(null);
  const extract = (j: Journal) => run('x' + j.id, async () => {
    let r: { story: Story; meta: { demo: boolean } };
    try { r = await api(`/journals/${j.id}/extract`, { body: {} }); }
    catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) throw e;
      const ok = await confirm({ title: 'Gửi nhật ký riêng tư ra dịch vụ AI bên ngoài?', body: <><p>{e.message}</p><p className="mt-2 text-muted">Nội dung sẽ được gửi tới nhà cung cấp AI. SĐT/email được ẩn tự động nhưng nội dung khác thì không.</p></>, confirmLabel: 'Đồng ý gửi' });
      if (!ok) return;
      r = await api(`/journals/${j.id}/extract`, { body: { confirm_external: true } });
    }
    setIdeaRes(null); setView({ story: r.story, demo: r.meta?.demo ?? r.story.is_demo }); stories.reload(); journals.reload();
  });
  const saveIdeas = (s: Story) => run('ideas' + s.id, async () => { setIdeaRes(await api<IdeaRes>(`/stories/${s.id}/ideas`, { body: {} })); });
  const delStory = async (s: Story) => {
    if (!(await confirm({ title: 'Xoá câu chuyện?', body: `Xoá “${s.title}”.`, danger: true, confirmLabel: 'Xoá' }))) return;
    run('ds' + s.id, async () => { await api(`/stories/${s.id}`, { method: 'DELETE' }); setView(null); stories.reload(); journals.reload(); }, 'Đã xoá');
  };

  // ---- nhóm theo ngày
  const groups = useMemo(() => {
    const m = new Map<string, Journal[]>();
    for (const j of journals.data?.items ?? []) { const d = dayOf(j.entry_date); m.set(d, [...(m.get(d) ?? []), j]); }
    return [...m.entries()];
  }, [journals.data]);
  const [openBody, setOpenBody] = useState<Set<string>>(new Set());
  const [audioUrl, setAudioUrl] = useState<Record<string, string>>({});
  const loadAudio = (id: string) => run('au' + id, async () => { const r = await api<{ url: string }>(`/media/${id}/url`); setAudioUrl((a) => ({ ...a, [id]: r.url })); });

  return (
    <div>
      <PageHeader title="Ngân hàng câu chuyện" desc="Ghi nhật ký kinh doanh hằng ngày, rồi để AI trích xuất câu chuyện, bài học và ý tưởng nội dung. AI không được tự bịa chi tiết bạn không kể." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'journal', label: 'Nhật ký' }, { id: 'story', label: `Câu chuyện đã trích xuất${stories.data ? ` (${stories.data.items.length})` : ''}` }]} />

      {tab === 'journal' && (
        <div className="mt-4 space-y-4">
          <Card title="Thêm nhật ký">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Tiêu đề"><Input value={nf.title} maxLength={200} onChange={(e) => setNf({ ...nf, title: e.target.value })} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Ngày"><Input type="date" value={nf.entry_date} onChange={(e) => setNf({ ...nf, entry_date: e.target.value })} /></Field>
                <Field label="Loại nguồn"><Select value={nf.source_type} onChange={(e) => setNf({ ...nf, source_type: e.target.value })}>{Object.entries(SRC).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
              </div>
              <Field label="Nội dung * (kể lại sự việc thật; nếu có ghi âm, hãy dán transcript vào đây)" className="sm:col-span-2"><Textarea className="min-h-36" value={nf.body} maxLength={30000} onChange={(e) => setNf({ ...nf, body: e.target.value })} /></Field>
              <Field label="Chế độ riêng tư" hint="Riêng tư: cần bạn xác nhận trước khi gửi ra dịch vụ AI ngoài."><Select value={nf.privacy} onChange={(e) => setNf({ ...nf, privacy: e.target.value })}>{Object.entries(PRIVACY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
              <Field label="Thẻ (phân tách bằng dấu phẩy)"><Input value={nf.tags} onChange={(e) => setNf({ ...nf, tags: e.target.value })} /></Field>
            </div>

            <div className="mt-4 space-y-3 rounded-lg border border-line p-3">
              <p className="text-sm font-medium">Đính kèm âm thanh / hình ảnh / video</p>
              <Notice tone="amber">Chuyển giọng nói thành văn bản <b>chưa được triển khai</b>. Hệ thống chỉ lưu tệp; bạn cần tự dán transcript vào ô nội dung để AI phân tích.</Notice>
              <div className="flex flex-wrap items-center gap-2">
                <input ref={fileRef} type="file" className="hidden" id="journal-file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/mp4,audio/ogg,audio/webm,.m4a,.mp3" onChange={(e) => onFile(e.target.files?.[0])} />
                <Button busy={busy === 'upload'} onClick={() => fileRef.current?.click()}><Paperclip className="h-4 w-4" />Chọn tệp để tải lên</Button>
                {canRecord && rec.state === 'idle' && <Button onClick={startRec}><Mic className="h-4 w-4" />Ghi âm</Button>}
                {canRecord && rec.state === 'recording' && <Button variant="danger" onClick={stopRec}><Square className="h-4 w-4" />Dừng ({rec.secs}s)</Button>}
              </div>
              {!canRecord && <p className="text-xs text-muted">Trình duyệt này không hỗ trợ ghi âm trực tiếp (thiếu MediaRecorder hoặc quyền micro), nên nút ghi âm bị ẩn. Bạn vẫn có thể tải tệp ghi âm lên.</p>}
              {rec.state === 'done' && rec.url && (
                <div className="space-y-2 rounded-lg bg-surface2 p-3">
                  <audio controls src={rec.url} className="w-full" />
                  <div className="flex gap-2"><Button variant="primary" busy={busy === 'upload'} onClick={uploadRec}>Tải bản ghi lên và gắn vào nhật ký</Button><Button onClick={() => setRec({ state: 'idle', secs: 0 })}>Bỏ bản ghi</Button></div>
                </div>
              )}
              {media && <p className="flex flex-wrap items-center gap-2 text-sm"><Badge tone="green">Đã gắn</Badge>{media.filename} <Button size="sm" variant="ghost" onClick={() => setMedia(null)}>Gỡ</Button></p>}
            </div>

            <div className="mt-4"><Button variant="primary" size="lg" busy={busy === 'add'} disabled={!nf.body.trim()} onClick={addJournal}>Lưu nhật ký</Button></div>
          </Card>

          <form className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_12rem_auto]" onSubmit={(e) => { e.preventDefault(); setQ(qInput.trim()); }}>
            <Input aria-label="Tìm nhật ký" className="col-span-2 sm:col-span-1" placeholder="Tìm trong tiêu đề, nội dung…" value={qInput} onChange={(e) => setQInput(e.target.value)} />
            <Select aria-label="Lọc riêng tư" value={privF} onChange={(e) => setPrivF(e.target.value)}><option value="">Mọi chế độ</option>{Object.entries(PRIVACY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            <Button type="submit">Tìm</Button>
          </form>

          <ErrorNote message={journals.error} />
          {journals.loading && !journals.data && <Spinner />}
          {journals.data && groups.length === 0 && <Empty title={q || privF ? 'Không có nhật ký khớp' : 'Chưa có nhật ký nào'} hint="Hãy ghi lại một sự việc thật trong ngày: khách hàng, quyết định, sai lầm, bài học…" />}
          <div className="space-y-5">
            {groups.map(([day, list]) => (
              <section key={day}>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><span className="h-2 w-2 rounded-full bg-brand" />{fmtDate(day + 'T12:00:00')}</h3>
                <div className="space-y-3 border-l border-line pl-4">
                  {list.map((j) => {
                    const long = j.body.length > 280; const exp = openBody.has(j.id);
                    return (
                      <article key={j.id} className="rounded-xl border border-line bg-surface p-4">
                        <div className="flex flex-wrap items-center gap-1.5"><Badge tone={PRIV_TONE[j.privacy]}>{PRIVACY_LABEL[j.privacy]}</Badge><Badge>{SRC[j.source_type] ?? j.source_type}</Badge>{Number(j.story_count) > 0 && <Badge tone="teal">{j.story_count} câu chuyện</Badge>}{j.tags.map((t) => <Badge key={t} tone="blue">{t}</Badge>)}</div>
                        {j.title && <h4 className="mt-2 font-semibold">{j.title}</h4>}
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm">{long && !exp ? j.body.slice(0, 280) + '…' : j.body}</p>
                        {long && <button className="text-xs text-brand underline" onClick={() => setOpenBody((s) => { const n = new Set(s); if (n.has(j.id)) n.delete(j.id); else n.add(j.id); return n; })}>{exp ? 'Thu gọn' : 'Xem hết'}</button>}
                        {j.media_asset_id && (audioUrl[j.media_asset_id] ? <audio controls src={audioUrl[j.media_asset_id]} className="mt-2 w-full" /> : <Button size="sm" className="mt-2" busy={busy === 'au' + j.media_asset_id} onClick={() => loadAudio(j.media_asset_id!)}>Mở tệp đính kèm</Button>)}
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button size="sm" variant="primary" busy={busy === 'x' + j.id} disabled={!!busy && busy !== 'x' + j.id} onClick={() => extract(j)}>Trích xuất câu chuyện</Button>
                          <Button size="sm" onClick={() => setEdit({ ...j, tagsTxt: j.tags.join(', ') })}>Sửa</Button>
                          <Button size="sm" variant="ghost" className="text-danger" onClick={() => delJournal(j)}>Xoá</Button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}

      {tab === 'story' && (
        <div className="mt-4">
          <ErrorNote message={stories.error} />
          {stories.loading && !stories.data && <Spinner />}
          {stories.data && stories.data.items.length === 0 && <Empty title="Chưa có câu chuyện nào" hint="Vào tab Nhật ký và bấm “Trích xuất câu chuyện” trên một nhật ký." action={<Button onClick={() => setTab('journal')}>Đến nhật ký</Button>} />}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {stories.data?.items.map((s) => (
              <article key={s.id} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex flex-wrap gap-1.5"><Badge tone={PRIV_TONE[s.privacy]}>{PRIVACY_LABEL[s.privacy]}</Badge><DemoBadge show={s.is_demo} /></div>
                <h3 className="mt-2 font-semibold">{s.title}</h3>
                <p className="mt-1 line-clamp-3 text-sm text-muted">{(s.extracted.problem as string) || '—'}</p>
                <p className="mt-1 text-xs text-muted">{fmtDate(s.created_at)}</p>
                <div className="mt-3 flex gap-2"><Button size="sm" variant="primary" onClick={() => { setIdeaRes(null); setView({ story: s, demo: s.is_demo }); }}>Xem</Button><Button size="sm" variant="ghost" className="text-danger" onClick={() => delStory(s)}>Xoá</Button></div>
              </article>
            ))}
          </div>
        </div>
      )}

      {/* Sửa nhật ký */}
      <Modal open={!!edit} onClose={() => setEdit(null)} title="Sửa nhật ký" footer={<><Button onClick={() => setEdit(null)}>Huỷ</Button><Button variant="primary" busy={busy === 'edit'} disabled={!edit?.body.trim()} onClick={saveEdit}>Lưu</Button></>}>
        {edit && (
          <div className="space-y-3">
            <Field label="Tiêu đề"><Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label="Nội dung"><Textarea className="min-h-40" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
            <Field label="Chế độ riêng tư"><Select value={edit.privacy} onChange={(e) => setEdit({ ...edit, privacy: e.target.value as Journal['privacy'] })}>{Object.entries(PRIVACY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Thẻ (dấu phẩy)"><Input value={edit.tagsTxt} onChange={(e) => setEdit({ ...edit, tagsTxt: e.target.value })} /></Field>
          </div>
        )}
      </Modal>

      {/* Xem câu chuyện */}
      <Modal open={!!view} onClose={() => setView(null)} title={view?.story.title ?? ''} wide>
        {view && (() => {
          const s = view.story; const sg = s.suggestions ?? {};
          return (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5"><Badge tone={PRIV_TONE[s.privacy]}>{PRIVACY_LABEL[s.privacy]}</Badge><DemoBadge show={view.demo} /></div>
              {view.demo && <Notice tone="amber">Chế độ demo: nội dung là dữ liệu mẫu, không phản ánh nhật ký của bạn.</Notice>}
              <div className="grid gap-3 md:grid-cols-2">
                {FIELDS.map(([k, label]) => { const v = s.extracted[k]; const t = Array.isArray(v) ? v.join(', ') : v ?? ''; return <CopyBlock key={k} label={label} text={t} />; })}
              </div>
              <Card title="Chưa được nhắc tới trong nhật ký (AI không được bịa)">
                {s.extracted.not_stated?.length ? <ul className="list-disc space-y-1 pl-5 text-sm">{s.extracted.not_stated.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="text-sm text-muted">—</p>}
              </Card>
              <CopyBlock label="3 bài học" text={(s.lessons ?? []).map((x, i) => `${i + 1}. ${x}`).join('\n')}>
                {s.lessons?.length ? <ol className="list-decimal space-y-1 pl-5 text-sm">{s.lessons.map((x, i) => <li key={i}>{x}</li>)}</ol> : <p className="text-sm">—</p>}
              </CopyBlock>
              <CopyBlock label="5 từ khoá rộng" text={(sg.broad_keywords ?? []).join(', ')}>
                <div className="flex flex-wrap gap-1">{sg.broad_keywords?.length ? sg.broad_keywords.map((k) => <Badge key={k} tone="blue">{k}</Badge>) : '—'}</div>
              </CopyBlock>
              <Card title="5 ý tưởng nội dung" actions={<Button size="sm" variant="primary" busy={busy === 'ideas' + s.id} onClick={() => saveIdeas(s)}>Lưu vào ngân hàng ý tưởng</Button>}>
                <ul className="space-y-2">{sg.ideas?.map((i, k) => <li key={k} className="flex items-start justify-between gap-2 rounded-lg border border-line p-3"><div><p className="font-medium">{k + 1}. {i.title}</p><p className="text-sm text-muted">{i.summary || '—'}</p></div><CopyButton text={`${i.title}\n${i.summary}`} /></li>) ?? <li className="text-sm text-muted">—</li>}</ul>
                {ideaRes && (
                  <div className="mt-3 rounded-lg bg-surface2 p-3 text-sm">
                    <p>Đã lưu <b>{ideaRes.saved.length}</b> ý tưởng · loại {ideaRes.duplicates.length} do trùng. Điểm là mặc định, hãy chấm lại.</p>
                    {ideaRes.duplicates.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-muted">{ideaRes.duplicates.map((d, i) => <li key={i}>“{d.title}” trùng “{d.of}” ({Math.round(d.similarity * 100)}%)</li>)}</ul>}
                    <Link className="mt-1 inline-block text-brand underline" href="/ideas">Mở ngân hàng ý tưởng →</Link>
                  </div>
                )}
              </Card>
              <CopyBlock label="3 hook" text={(sg.hooks ?? []).join('\n')}>
                {sg.hooks?.length ? <ul className="list-disc space-y-1 pl-5 text-sm">{sg.hooks.map((h, i) => <li key={i}>{h}</li>)}</ul> : <p className="text-sm">—</p>}
              </CopyBlock>
              <CopyBlock label="Bài Facebook" text={sg.facebook_post} />
              <CopyBlock label="Ý tưởng video ngắn" text={sg.short_video_idea} />
              <div className="flex justify-end"><Button variant="danger" onClick={() => delStory(s)}>Xoá câu chuyện</Button></div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}

'use client';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Bold, Italic, List, ListOrdered, Plus, Save, Trash2, WrapText, Video } from 'lucide-react';
import { api, fmtDateTime, PLATFORM_LABEL, PRIVACY_LABEL, TYPE_LABEL, useApi } from '@/lib/client';
import { Badge, Button, Card, DemoBadge, ErrorNote, Field, Input, Modal, Notice, Select, Spinner, StatusBadge, Tabs, Textarea, useAction, useUi, clsx } from '@/components/ui';
import { AiPanel } from '@/components/content/ai-panel';
import { VariantsPanel, type Variant } from '@/components/content/variants-panel';
import { VersionsPanel, type Version } from '@/components/content/versions-panel';
import { WorkflowPanel, type Approval } from '@/components/content/workflow-panel';

type ContentRow = {
  id: string; title: string; body: string; hooks: string[]; caption: string; hashtags: string[]; cta: string; platform: string; pillar: string; channel_id: string | null; campaign_id: string | null;
  keyword_ids: string[]; references_text: string; privacy: string; status: string; content_type: string; scheduled_at: string | null; published_at: string | null; current_version: number; is_demo: boolean; ai_generated: boolean;
  parent_content_id: string | null; updated_at: string;
};
type Detail = { content: ContentRow; versions: Version[]; variants: Variant[]; approvals: Approval[]; video_project: { id: string; title: string } | null; statuses: string[] };
type Form = { title: string; body: string; hooks: string[]; caption: string; hashtags: string; cta: string; platform: string; pillar: string; channel_id: string; campaign_id: string; keyword_ids: string[]; references_text: string; privacy: string };
type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: Date } | { kind: 'error'; msg: string };

const MAX_HOOKS = 10;
const parseTags = (s: string) => s.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
const toForm = (c: ContentRow): Form => ({
  title: c.title, body: c.body, hooks: c.hooks.length >= 3 ? c.hooks : [...c.hooks, ...Array(3 - c.hooks.length).fill('')], caption: c.caption, hashtags: c.hashtags.join(' '), cta: c.cta,
  platform: c.platform, pillar: c.pillar, channel_id: c.channel_id ?? '', campaign_id: c.campaign_id ?? '', keyword_ids: c.keyword_ids ?? [], references_text: c.references_text, privacy: c.privacy,
});
/** Payload gửi lên API (lọc hook rỗng, tách hashtag) — cũng dùng để so sánh "có thay đổi chưa lưu". */
const toPayload = (f: Form) => ({
  title: f.title, body: f.body, hooks: f.hooks.map((h) => h.trim()).filter(Boolean), caption: f.caption, hashtags: parseTags(f.hashtags), cta: f.cta, platform: f.platform, pillar: f.pillar,
  channel_id: f.channel_id || null, campaign_id: f.campaign_id || null, keyword_ids: f.keyword_ids, references_text: f.references_text, privacy: f.privacy,
});
const hhmm = (d: Date) => d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });

type TabId = 'edit' | 'variants' | 'versions' | 'workflow';

export default function ContentEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { toast } = useUi();
  const { data, error, loading, setData } = useApi<Detail>(`/contents/${id}`);
  const { data: me } = useApi<{ role: string }>('/auth/me');
  const { data: chData } = useApi<{ items: { id: string; name: string }[] }>('/channels');
  const { data: cpData } = useApi<{ items: { id: string; name: string }[] }>('/campaigns');
  const { data: kwData } = useApi<{ items: { id: string; keyword: string }[] }>('/keywords');
  const { data: brands } = useApi<{ items: { pillars: { name: string }[] }[] }>('/brands');

  const [tab, setTab] = useState<TabId>('edit');
  const [f, setF] = useState<Form | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [kwFilter, setKwFilter] = useState('');
  const [convDur, setConvDur] = useState(30);
  const { busy, run } = useAction();

  const savedRef = useRef('');           // JSON payload của bản đã lưu trên server (ref cho handler, state để render)
  const [savedJson, setSavedJson] = useState('');
  const markSaved = useCallback((json: string) => { savedRef.current = json; setSavedJson(json); }, []);
  const fRef = useRef<Form | null>(null);
  const savingRef = useRef(false);
  const failedRef = useRef('');
  const [tick, setTick] = useState(0);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { fRef.current = f; }, [f]);

  const payloadJson = useMemo(() => (f ? JSON.stringify(toPayload(f)) : ''), [f]);
  const dirty = !!f && payloadJson !== savedJson;
  const status = data?.content.status ?? '';
  const readOnly = status === 'published' || status === 'archived';
  const isAdmin = me?.role === 'admin' || me?.role === 'owner';

  const hydrate = useCallback((c: ContentRow) => { const nf = toForm(c); setF(nf); markSaved(JSON.stringify(toPayload(nf))); }, [markSaved]);
  useEffect(() => { if (data && f === null) hydrate(data.content); }, [data, f, hydrate]);

  const reloadDetail = useCallback(async (rehydrate: boolean) => {
    const d = await api<Detail>(`/contents/${id}`);
    setData(d);
    if (rehydrate) hydrate(d.content);
    return d;
  }, [id, setData, hydrate]);

  /** Lưu lên server. Trả true nếu thành công hoặc không có gì để lưu. */
  const save = useCallback(async (opts: { autosave: boolean; note?: string }): Promise<boolean> => {
    const cur = fRef.current;
    if (!cur) return false;
    const payload = toPayload(cur);
    const json = JSON.stringify(payload);
    if (!opts.autosave) failedRef.current = '';
    if (!opts.autosave && json === savedRef.current && !opts.note) return true;
    if (!payload.title.trim()) { setSaveState({ kind: 'error', msg: 'Tiêu đề không được để trống' }); return false; }
    if (savingRef.current) return false;
    savingRef.current = true; setSaveState({ kind: 'saving' });
    try {
      const row = await api<ContentRow>(`/contents/${id}`, { method: 'PATCH', body: { ...payload, autosave: opts.autosave, ...(opts.note ? { note: opts.note } : {}) } });
      markSaved(json);
      setSaveState({ kind: 'saved', at: new Date() });
      setData((d) => (d ? { ...d, content: { ...d.content, status: row.status, current_version: row.current_version, updated_at: row.updated_at } } : d));
      if (data && row.status !== data.content.status) toast(`Trạng thái đã đổi sang “${row.status === 'draft' ? 'Bản nháp' : row.status}” do sửa nội dung sau khi duyệt — cần duyệt lại.`, 'info');
      const d = await reloadDetail(false);
      if (opts.note && d.versions[0]?.change_note !== opts.note) toast('Nội dung đã được tự động lưu trước đó nên ghi chú không gắn được vào phiên bản mới.', 'info');
      return true;
    } catch (e) { failedRef.current = json; setSaveState({ kind: 'error', msg: (e as Error).message }); return false; }
    finally { savingRef.current = false; setTick((t) => t + 1); }
  }, [id, data, setData, reloadDetail, toast, markSaved]);

  // Autosave: debounce 2 giây sau lần gõ cuối.
  useEffect(() => {
    if (!dirty || readOnly || savingRef.current) return;
    if (payloadJson === failedRef.current) return; // đã lỗi với đúng nội dung này — chờ người dùng sửa tiếp hoặc bấm Lưu
    if (!f?.title.trim()) return;
    const t = setTimeout(() => { void save({ autosave: true }); }, 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadJson, tick, readOnly]);

  // Chặn rời trang khi còn thay đổi chưa lưu.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const ensureSaved = useCallback(async () => {
    if (!fRef.current || JSON.stringify(toPayload(fRef.current)) === savedRef.current) return true;
    while (savingRef.current) await new Promise((r) => setTimeout(r, 100));
    return save({ autosave: true });
  }, [save]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => (x ? { ...x, [k]: v } : x));

  // ---- thanh công cụ markdown ----
  const edit = (fn: (sel: string, before: string, after: string) => { text: string; selStart: number; selEnd: number }) => {
    const ta = bodyRef.current; if (!ta || !f || readOnly) return;
    const s = ta.selectionStart; const e = ta.selectionEnd;
    const r = fn(f.body.slice(s, e), f.body.slice(0, s), f.body.slice(e));
    set('body', r.text);
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(r.selStart, r.selEnd); });
  };
  const wrap = (mark: string) => edit((sel, b, a) => ({ text: `${b}${mark}${sel || 'văn bản'}${mark}${a}`, selStart: b.length + mark.length, selEnd: b.length + mark.length + (sel || 'văn bản').length }));
  const prefixLines = (ordered: boolean) => edit((sel, b, a) => {
    const src = sel || 'mục';
    const out = src.split('\n').map((l, i) => `${ordered ? `${i + 1}.` : '-'} ${l}`).join('\n');
    return { text: `${b}${out}${a}`, selStart: b.length, selEnd: b.length + out.length };
  });
  const newline = () => edit((sel, b, a) => ({ text: `${b}${sel}\n\n${a}`, selStart: b.length + sel.length + 2, selEnd: b.length + sel.length + 2 }));

  const convert = (to: 'video' | 'post' | 'carousel') => run(`conv-${to}`, async () => {
    if (!(await ensureSaved())) throw new Error('Chưa lưu được thay đổi hiện tại');
    const r = await api<{ id: string }>(`/contents/${id}/convert`, { body: { to, duration_sec: convDur } });
    toast('Đã tạo nội dung mới — đang mở');
    router.push(`/content/${r.id}`);
  });

  const restore = async (version: number) => {
    await run('restore', async () => {
      await api(`/contents/${id}/restore`, { body: { version } });
      await reloadDetail(true); setSaveState({ kind: 'saved', at: new Date() }); setTab('edit');
    }, `Đã khôi phục phiên bản ${version}`);
  };

  if (error && !data) return <div className="space-y-3"><Link href="/content" className="inline-flex items-center gap-1 text-sm text-brand"><ArrowLeft className="h-4 w-4" />Content Factory</Link><ErrorNote message={error} /></div>;
  if (loading && !data) return <Spinner />;
  if (!data || !f) return <Spinner />;

  const c = data.content;
  const pillars = brands?.items[0]?.pillars.map((p) => p.name) ?? [];
  const channels = chData?.items ?? [];
  const keywords = kwData?.items ?? [];
  const words = f.body.trim() ? f.body.trim().split(/\s+/).length : 0;
  const kwShown = keywords.filter((k) => !kwFilter.trim() || k.keyword.toLowerCase().includes(kwFilter.trim().toLowerCase())).slice(0, 60);
  const hooksFilled = f.hooks.filter((h) => h.trim()).length;
  const saveText = saveState.kind === 'saving' ? 'Đang lưu…' : saveState.kind === 'error' ? `Lỗi lưu: ${saveState.msg}` : dirty ? 'Có thay đổi chưa lưu' : saveState.kind === 'saved' ? `Đã lưu lúc ${hhmm(saveState.at)}` : `Đã lưu · cập nhật ${fmtDateTime(c.updated_at)}`;

  return (
    <div>
      <Link href="/content" className="mb-2 inline-flex items-center gap-1 text-sm text-brand"><ArrowLeft className="h-4 w-4" />Content Factory</Link>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <h1 className="break-words text-xl font-semibold sm:text-2xl">{f.title || '(chưa có tiêu đề)'}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={c.status} /><DemoBadge show={c.is_demo} /><Badge>{TYPE_LABEL[c.content_type] ?? c.content_type}</Badge><Badge tone="gray">v{c.current_version}</Badge>
            {c.parent_content_id && <Badge tone="blue">Biến thể</Badge>}
            {data.video_project && <Link href={`/video?p=${data.video_project.id}`} className="inline-flex items-center gap-1 text-sm text-brand hover:underline"><Video className="h-4 w-4" />Dự án video</Link>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" aria-live="polite" className={clsx('text-xs', saveState.kind === 'error' ? 'text-danger' : dirty || saveState.kind === 'saving' ? 'text-warn' : 'text-muted')}>{saveText}</span>
          <Button variant="primary" disabled={readOnly} busy={saveState.kind === 'saving'} onClick={() => { setNote(''); setNoteOpen(true); }}><Save className="h-4 w-4" />Lưu phiên bản</Button>
        </div>
      </div>

      {c.is_demo && <div className="mb-3"><Notice tone="amber">Nội dung DEMO do hệ thống sinh khi chưa có khoá AI thật. Hãy viết lại bằng trải nghiệm thật của bạn trước khi duyệt.</Notice></div>}
      {readOnly && <div className="mb-3"><Notice tone="blue">Nội dung đã {status === 'published' ? 'đăng' : 'lưu trữ'} nên không thể sửa. {status === 'archived' ? 'Chuyển về bản nháp ở tab “Duyệt & đăng” để sửa tiếp.' : 'Muốn sửa, hãy lưu trữ rồi chuyển về bản nháp.'}</Notice></div>}
      {['approved', 'ready_to_publish'].includes(c.status) && <div className="mb-3"><Notice tone="amber">Lưu ý: sửa nội dung sau khi đã duyệt sẽ đưa bài về “Bản nháp” để duyệt lại.</Notice></div>}
      {saveState.kind === 'error' && <div className="mb-3"><ErrorNote message={`Không lưu được: ${saveState.msg}`} /></div>}

      <Tabs<TabId> value={tab} onChange={setTab} tabs={[{ id: 'edit', label: 'Soạn thảo' }, { id: 'variants', label: `Biến thể & chuyển đổi (${data.variants.length})` }, { id: 'versions', label: `Phiên bản (${data.versions.length})` }, { id: 'workflow', label: 'Duyệt & đăng' }]} />

      <div className="mt-4">
        {tab === 'edit' && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="space-y-4">
              <Card>
                <fieldset disabled={readOnly} className="space-y-4">
                  <Field label="Tiêu đề"><Input value={f.title} maxLength={300} onChange={(e) => set('title', e.target.value)} /></Field>

                  <div>
                    <div className="mb-1 flex items-center justify-between"><span className="text-xs font-medium text-muted">Hook (phương án mở đầu) — nên có ít nhất 3</span><span className={clsx('text-xs', hooksFilled < 3 ? 'text-warn' : 'text-muted')}>{hooksFilled} phương án</span></div>
                    <div className="space-y-2">
                      {f.hooks.map((h, i) => (
                        <div key={i} className="flex gap-2">
                          <Input aria-label={`Hook ${i + 1}`} placeholder={`Hook ${i + 1}`} value={h} maxLength={500} onChange={(e) => set('hooks', f.hooks.map((x, j) => (j === i ? e.target.value : x)))} />
                          <Button type="button" variant="ghost" aria-label={`Xoá hook ${i + 1}`} onClick={() => set('hooks', f.hooks.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
                        </div>
                      ))}
                    </div>
                    <Button type="button" size="sm" className="mt-2" disabled={f.hooks.length >= MAX_HOOKS} onClick={() => set('hooks', [...f.hooks, ''])}><Plus className="h-4 w-4" />Thêm hook</Button>
                  </div>

                  <div>
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-medium text-muted">Thân bài (Markdown)</span>
                      <div className="flex gap-1" role="toolbar" aria-label="Định dạng">
                        <Button type="button" size="sm" aria-label="In đậm" title="In đậm" onClick={() => wrap('**')}><Bold className="h-4 w-4" /></Button>
                        <Button type="button" size="sm" aria-label="In nghiêng" title="In nghiêng" onClick={() => wrap('*')}><Italic className="h-4 w-4" /></Button>
                        <Button type="button" size="sm" aria-label="Danh sách" title="Danh sách gạch đầu dòng" onClick={() => prefixLines(false)}><List className="h-4 w-4" /></Button>
                        <Button type="button" size="sm" aria-label="Danh sách số" title="Danh sách đánh số" onClick={() => prefixLines(true)}><ListOrdered className="h-4 w-4" /></Button>
                        <Button type="button" size="sm" aria-label="Xuống dòng" title="Chèn dòng trống" onClick={newline}><WrapText className="h-4 w-4" /></Button>
                      </div>
                    </div>
                    <textarea ref={bodyRef} aria-label="Thân bài" className="min-h-[320px] w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm leading-relaxed text-ink disabled:opacity-60" maxLength={60000} value={f.body} onChange={(e) => set('body', e.target.value)} />
                    <p className="mt-1 text-right text-xs text-muted tabular-nums">{f.body.length.toLocaleString('vi-VN')} ký tự · {words.toLocaleString('vi-VN')} từ</p>
                  </div>

                  <Field label="Caption"><Textarea value={f.caption} maxLength={5000} onChange={(e) => set('caption', e.target.value)} /></Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Hashtag" hint="Cách nhau bằng dấu cách hoặc dấu phẩy"><Input value={f.hashtags} onChange={(e) => set('hashtags', e.target.value)} /></Field>
                    <Field label="CTA (kêu gọi hành động)"><Input value={f.cta} maxLength={500} onChange={(e) => set('cta', e.target.value)} /></Field>
                  </div>
                </fieldset>
              </Card>

              <Card title="Thông tin & phân loại">
                <fieldset disabled={readOnly} className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Nền tảng"><Select value={f.platform} onChange={(e) => set('platform', e.target.value)}>{!PLATFORM_LABEL[f.platform] && <option value={f.platform}>{f.platform}</option>}{Object.entries(PLATFORM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
                    <Field label="Trụ cột nội dung"><Select value={f.pillar} onChange={(e) => set('pillar', e.target.value)}><option value="">— Chưa chọn —</option>{f.pillar && !pillars.includes(f.pillar) && <option value={f.pillar}>{f.pillar}</option>}{pillars.map((n) => <option key={n}>{n}</option>)}</Select></Field>
                    <Field label="Kênh"><Select value={f.channel_id} onChange={(e) => set('channel_id', e.target.value)}><option value="">— Chưa chọn —</option>{channels.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
                    <Field label="Chiến dịch"><Select value={f.campaign_id} onChange={(e) => set('campaign_id', e.target.value)}><option value="">— Không thuộc chiến dịch —</option>{(cpData?.items ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
                    <Field label="Quyền riêng tư"><Select value={f.privacy} onChange={(e) => set('privacy', e.target.value)}>{Object.entries(PRIVACY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
                  </div>
                  <div>
                    <span className="text-xs font-medium text-muted">Từ khoá liên kết ({f.keyword_ids.length} đã chọn)</span>
                    {keywords.length === 0 ? <p className="mt-1 text-xs text-muted">Chưa có từ khoá — thêm ở Phòng từ khoá.</p> : (
                      <>
                        <Input className="mt-1" aria-label="Lọc từ khoá" placeholder="Lọc từ khoá…" value={kwFilter} onChange={(e) => setKwFilter(e.target.value)} />
                        <div className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                          {kwShown.map((k) => {
                            const on = f.keyword_ids.includes(k.id);
                            return <button key={k.id} type="button" aria-pressed={on} onClick={() => set('keyword_ids', on ? f.keyword_ids.filter((x) => x !== k.id) : [...f.keyword_ids, k.id])} className={clsx('rounded-full border px-2.5 py-1 text-xs', on ? 'border-brand bg-brand/10 text-brand' : 'border-line hover:bg-surface2')}>{k.keyword}</button>;
                          })}
                          {f.keyword_ids.filter((kid) => !keywords.some((k) => k.id === kid)).map((kid) => <button key={kid} type="button" aria-pressed onClick={() => set('keyword_ids', f.keyword_ids.filter((x) => x !== kid))} className="rounded-full border border-brand bg-brand/10 px-2.5 py-1 text-xs text-brand">(đã xoá) ✕</button>)}
                        </div>
                      </>
                    )}
                  </div>
                  <Field label="Nguồn tham khảo" hint="Ghi rõ nguồn của số liệu/trích dẫn để kiểm chứng trước khi duyệt."><Textarea value={f.references_text} maxLength={5000} onChange={(e) => set('references_text', e.target.value)} /></Field>
                </fieldset>
              </Card>
            </div>

            <div className="space-y-4">
              <AiPanel contentId={id} body={f.body} disabled={readOnly}
                onApplyBody={(t) => { set('body', t); toast('Đã đưa đề xuất vào thân bài — nhớ kiểm tra lại trước khi duyệt', 'info'); }}
                onApplyHooks={(h) => { const hs = h.slice(0, MAX_HOOKS); set('hooks', hs.length >= 3 ? hs : [...hs, ...Array(3 - hs.length).fill('')]); toast('Đã thay danh sách hook', 'info'); }} />
            </div>
          </div>
        )}

        {tab === 'variants' && (
          <div className="space-y-4">
            <VariantsPanel contentId={id} variants={data.variants} readOnly={false} onChanged={() => void reloadDetail(false)} />
            <Card title="Chuyển đổi định dạng">
              <p className="mb-2 text-xs text-muted">Tạo một nội dung MỚI từ nội dung này bằng AI (nội dung hiện tại giữ nguyên) rồi mở nó để chỉnh sửa.</p>
              <div className="flex flex-wrap items-end gap-2">
                {c.content_type !== 'video_script' && (
                  <>
                    <Field label="Thời lượng video (giây)" className="w-40"><Input type="number" min={15} max={1800} value={convDur} onChange={(e) => setConvDur(Math.max(15, Math.min(1800, Number(e.target.value) || 30)))} /></Field>
                    <Button busy={busy === 'conv-video'} disabled={!!busy} onClick={() => void convert('video')}>Bài → Kịch bản video</Button>
                  </>
                )}
                {c.content_type === 'video_script' && <Button busy={busy === 'conv-post'} disabled={!!busy} onClick={() => void convert('post')}>Video → Bài viết</Button>}
                {c.content_type !== 'video_script' && c.content_type !== 'carousel' && <Button busy={busy === 'conv-carousel'} disabled={!!busy} onClick={() => void convert('carousel')}>Bài → Carousel</Button>}
                {c.content_type === 'carousel' && <Button busy={busy === 'conv-post'} disabled={!!busy} onClick={() => void convert('post')}>Carousel → Bài viết</Button>}
              </div>
              {data.video_project && <p className="mt-3 text-sm">Đã có dự án video: <Link className="text-brand underline" href={`/video?p=${data.video_project.id}`}>{data.video_project.title}</Link></p>}
            </Card>
          </div>
        )}

        {tab === 'versions' && <VersionsPanel versions={data.versions} current={c.current_version} readOnly={readOnly} onRestore={restore} />}

        {tab === 'workflow' && (
          <WorkflowPanel id={id} status={c.status} scheduledAt={c.scheduled_at} publishedAt={c.published_at} channelId={c.channel_id} isAdmin={isAdmin} channels={channels} approvals={data.approvals}
            parts={{ title: f.title, hooks: f.hooks, body: f.body, caption: f.caption, hashtags: parseTags(f.hashtags), cta: f.cta }} dirty={dirty} ensureSaved={ensureSaved}
            onChanged={async () => { await reloadDetail(true); }} onDeleted={() => router.push('/content')} />
        )}
      </div>

      <Modal open={noteOpen} onClose={() => setNoteOpen(false)} title="Lưu phiên bản"
        footer={<><Button onClick={() => setNoteOpen(false)}>Huỷ</Button><Button variant="primary" busy={saveState.kind === 'saving'} onClick={async () => { const ok = await save({ autosave: false, note: note.trim() || undefined }); if (ok) { setNoteOpen(false); toast('Đã lưu'); } }}>Lưu</Button></>}>
        <Field label="Ghi chú thay đổi (tuỳ chọn)"><Input value={note} maxLength={300} placeholder="Ví dụ: đổi hook, thêm CTA" onChange={(e) => setNote(e.target.value)} autoFocus /></Field>
        <p className="mt-2 text-xs text-muted">Hệ thống cũng tự lưu sau khoảng 2 giây kể từ lần gõ cuối. Mỗi lần nội dung chữ thay đổi sẽ tạo/cập nhật một phiên bản.</p>
        {saveState.kind === 'error' && <div className="mt-2"><ErrorNote message={saveState.msg} /></div>}
      </Modal>
    </div>
  );
}

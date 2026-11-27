'use client';
import { Suspense, useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Film, Plus, Settings2, Trash2 } from 'lucide-react';
import { api, fmtDate, useApi } from '@/lib/client';
import { Badge, Button, Card, DemoBadge, Empty, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Tabs, Textarea, useAction, useUi, clsx } from '@/components/ui';
import { Storyboard, Timeline } from '@/components/video/storyboard';
import { ExportPanel, PromptsPanel, ScriptPanel } from '@/components/video/panels';
import { Library } from '@/components/video/library';
import { ASPECTS, PROJECT_STATUS, type Character, type MediaItem, type Project, type Scene } from '@/components/video/types';

type Tab = 'storyboard' | 'timeline' | 'script' | 'prompts' | 'library' | 'export';
const TABS: { id: Tab; label: string }[] = [
  { id: 'storyboard', label: 'Storyboard' }, { id: 'timeline', label: 'Timeline' }, { id: 'script', label: 'Kịch bản' },
  { id: 'prompts', label: 'Prompt Google Flow' }, { id: 'library', label: 'Thư viện' }, { id: 'export', label: 'Phụ đề / Xuất' },
];
const STATUS_TONE: Record<string, string> = { planning: 'gray', scripted: 'blue', in_production: 'amber', done: 'green', archived: 'gray' };

function CreateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { busy, run } = useAction();
  const [title, setTitle] = useState('');
  const [dur, setDur] = useState(30);
  const [aspect, setAspect] = useState<string>('9:16');
  const [err, setErr] = useState<string | null>(null);
  async function submit() {
    setErr(null);
    if (!title.trim()) { setErr('Cần nhập tiêu đề'); return; }
    if (!Number.isInteger(dur) || dur < 5 || dur > 1800) { setErr('Thời lượng phải từ 5 đến 1800 giây'); return; }
    const p = await run('create', () => api<Project>('/video/projects', { body: { title: title.trim(), duration_sec: dur, aspect_ratio: aspect } }), 'Đã tạo dự án video');
    if (p) { setTitle(''); onCreated(p.id); onClose(); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Dự án video mới" footer={<><Button onClick={onClose}>Huỷ</Button><Button variant="primary" busy={busy === 'create'} onClick={() => void submit()}>Tạo dự án</Button></>}>
      <div className="space-y-3">
        <ErrorNote message={err} />
        <Field label="Tiêu đề"><Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Thời lượng dự kiến (giây)"><Input type="number" min={5} max={1800} value={dur} onChange={(e) => setDur(Number(e.target.value))} /></Field>
          <Field label="Tỷ lệ khung hình"><Select value={aspect} onChange={(e) => setAspect(e.target.value)}>{ASPECTS.map((a) => <option key={a}>{a}</option>)}</Select></Field>
        </div>
        <p className="text-xs text-muted">Dự án được tạo trống (chưa có cảnh). Bạn tự thêm cảnh ở tab Storyboard.</p>
      </div>
    </Modal>
  );
}

function ProjectSettings({ p, open, onClose, onSaved, onDeleted }: { p: Project; open: boolean; onClose: () => void; onSaved: (p: Project) => void; onDeleted: () => void }) {
  const { confirm } = useUi();
  const { busy, run } = useAction();
  const [title, setTitle] = useState(p.title);
  const [status, setStatus] = useState(p.status);
  const [aspect, setAspect] = useState(p.aspect_ratio);
  const [notes, setNotes] = useState(p.notes ?? '');
  async function save() {
    const r = await run('save', () => api<Project>(`/video/projects/${p.id}`, { method: 'PATCH', body: { title: title.trim(), status, aspect_ratio: aspect, notes } }), 'Đã lưu dự án');
    if (r) { onSaved(r); onClose(); }
  }
  async function del() {
    if (!(await confirm({ title: `Xoá dự án “${p.title}”?`, body: 'Toàn bộ cảnh và prompt của dự án sẽ bị xoá vĩnh viễn. Tư liệu đã tải lên vẫn nằm trong thư viện.', confirmLabel: 'Xoá dự án', danger: true }))) return;
    const r = await run('del', () => api(`/video/projects/${p.id}`, { method: 'DELETE' }), 'Đã xoá dự án');
    if (r) { onClose(); onDeleted(); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Cài đặt dự án" footer={<><Button variant="danger" className="mr-auto" busy={busy === 'del'} onClick={() => void del()}><Trash2 className="h-4 w-4" />Xoá dự án</Button><Button onClick={onClose}>Huỷ</Button><Button variant="primary" disabled={!title.trim()} busy={busy === 'save'} onClick={() => void save()}>Lưu</Button></>}>
      <div className="space-y-3">
        <Field label="Tiêu đề"><Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Trạng thái"><Select value={status} onChange={(e) => setStatus(e.target.value)}>{Object.entries(PROJECT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Tỷ lệ"><Select value={aspect} onChange={(e) => setAspect(e.target.value)}>{ASPECTS.map((a) => <option key={a}>{a}</option>)}</Select></Field>
        </div>
        <Field label="Ghi chú"><Textarea value={notes} maxLength={5000} onChange={(e) => setNotes(e.target.value)} /></Field>
        <p className="text-xs text-muted">Đổi tỷ lệ chỉ áp dụng cho prompt khi bạn bấm “Tạo lại prompt”.</p>
      </div>
    </Modal>
  );
}

function Studio() {
  const sp = useSearchParams();
  const router = useRouter();
  const pid = sp.get('p');
  const list = useApi<{ items: Project[] }>('/video/projects');
  const detail = useApi<{ p: Project; scenes: Scene[] }>(pid ? `/video/projects/${pid}` : null);
  const chars = useApi<{ items: Character[] }>('/characters');
  const media = useApi<{ items: MediaItem[] }>('/media');
  const [tab, setTab] = useState<Tab>('storyboard');
  const [focus, setFocus] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState(false);

  const select = (id: string | null) => { setTab('storyboard'); setFocus(null); router.replace(id ? `/video?p=${id}` : '/video'); };
  const { setData: setDetail, reload: reloadDetail } = detail;
  const reloadList = list.reload;
  const reloadAll = useCallback(() => { reloadDetail(); reloadList(); }, [reloadDetail, reloadList]);
  const onSceneSaved = useCallback((row: Scene) => setDetail((d) => (d ? { ...d, scenes: d.scenes.map((s) => (s.id === row.id ? { ...s, ...row } : s)) } : d)), [setDetail]);

  const d = detail.data && detail.data.p.id === pid ? detail.data : null;
  const projects = list.data?.items ?? [];
  const mediaItems = media.data?.items ?? [];
  const characters = chars.data?.items ?? [];
  const totalSec = d ? d.scenes.reduce((s, x) => s + x.duration_sec, 0) : 0;

  return (
    <div>
      <PageHeader title="Video Studio" desc="Lập storyboard, dựng prompt Google Flow và xuất gói sản xuất. Hệ thống không tự tạo video: chưa kết nối Google Flow, bạn sao chép prompt sang đó rồi tải kết quả lên lại."
        actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />Dự án mới</Button>} />
      <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside>
          <Card title="Dự án video" pad={false}>
            <ErrorNote message={list.error} />
            {list.loading && !list.data ? <div className="px-4"><Spinner /></div> : projects.length === 0 ? <div className="p-4"><Empty title="Chưa có dự án" hint="Tạo dự án mới hoặc chạy AI Agent hôm nay ở Tổng quan để có dự án mẫu (DEMO)." /></div> : (
              <ul className="max-h-60 divide-y divide-line overflow-y-auto lg:max-h-[70vh]">
                {projects.map((p) => (
                  <li key={p.id}>
                    <button onClick={() => select(p.id)} className={clsx('block w-full px-4 py-2.5 text-left hover:bg-surface2', p.id === pid && 'bg-brand/10')}>
                      <p className="line-clamp-2 break-words text-sm font-medium">{p.title}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted"><Badge tone={STATUS_TONE[p.status]}>{PROJECT_STATUS[p.status] ?? p.status}</Badge><DemoBadge show={p.is_demo} />{p.aspect_ratio} · {Number(p.scene_count ?? 0)} cảnh</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>

        <div className="min-w-0">
          {!pid ? <Empty title="Chọn một dự án để bắt đầu" hint="Chọn dự án ở danh sách hoặc tạo mới." action={<Button variant="primary" onClick={() => setCreating(true)}><Film className="h-4 w-4" />Tạo dự án video</Button>} /> :
            detail.error && !d ? <div className="space-y-2"><ErrorNote message={detail.error} /><Button onClick={() => detail.reload()}>Thử lại</Button></div> :
            !d ? <Spinner /> : (
              <div className="space-y-4">
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="break-words text-lg font-semibold">{d.p.title}</h2>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted"><Badge tone={STATUS_TONE[d.p.status]}>{PROJECT_STATUS[d.p.status] ?? d.p.status}</Badge><DemoBadge show={d.p.is_demo} /><span>{d.p.aspect_ratio}</span><span>· {d.scenes.length} cảnh</span><span>· {totalSec}s (dự kiến {d.p.duration_sec}s)</span>{d.p.created_at && <span>· tạo {fmtDate(d.p.created_at)}</span>}</p>
                      {d.p.notes && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted">{d.p.notes}</p>}
                    </div>
                    <Button onClick={() => setSettings(true)}><Settings2 className="h-4 w-4" />Cài đặt</Button>
                  </div>
                  <div className="mt-3"><Notice tone="amber">Chưa kết nối Google Flow và chưa triển khai ghép video bằng FFmpeg: video thật do bạn tự tạo/dựng bên ngoài rồi tải tài sản lên cho từng cảnh.</Notice></div>
                </Card>
                <Tabs tabs={TABS} value={tab} onChange={setTab} />
                {tab === 'storyboard' && <Storyboard projectId={d.p.id} scenes={d.scenes} characters={characters} media={mediaItems} focusId={focus} reload={reloadAll} reloadMedia={media.reload} onSceneSaved={onSceneSaved} />}
                {tab === 'timeline' && <Timeline scenes={d.scenes} onJump={(id) => { setFocus(id); setTab('storyboard'); }} />}
                {tab === 'script' && <ScriptPanel project={d.p} />}
                {tab === 'prompts' && <PromptsPanel project={d.p} scenes={d.scenes} reload={reloadAll} onSceneSaved={onSceneSaved} />}
                {tab === 'library' && <Library characters={characters} media={mediaItems} reload={chars.reload} reloadMedia={media.reload} />}
                {tab === 'export' && <ExportPanel projectId={d.p.id} />}
                <ProjectSettings key={d.p.id + d.p.status} p={d.p} open={settings} onClose={() => setSettings(false)}
                  onSaved={(np) => { setDetail((x) => (x ? { ...x, p: { ...x.p, ...np } } : x)); reloadList(); }} onDeleted={() => { reloadList(); select(null); }} />
              </div>
            )}
        </div>
      </div>
      <CreateModal open={creating} onClose={() => setCreating(false)} onCreated={(id) => { reloadList(); select(id); }} />
    </div>
  );
}

export default function VideoPage() {
  return <Suspense fallback={<Spinner />}><Studio /></Suspense>;
}

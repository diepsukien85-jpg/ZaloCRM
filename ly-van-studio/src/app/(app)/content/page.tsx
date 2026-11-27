'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Download, KanbanSquare, List, Plus, Search } from 'lucide-react';
import { api, fmtDateTime, PLATFORM_LABEL, STATUS_LABEL, TYPE_LABEL, useApi } from '@/lib/client';
import { Badge, Button, Card, DemoBadge, Empty, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, StatusBadge, Table, Td, useAction, useUi, clsx } from '@/components/ui';

type Item = {
  id: string; title: string; content_type: string; platform: string; pillar: string; status: string; scheduled_at: string | null; published_at: string | null;
  channel_name: string | null; assignee_name: string | null; is_demo: boolean; ai_generated: boolean; updated_at: string; current_version: number; variant_count: number | string;
};

const ALL_STATUSES = Object.keys(STATUS_LABEL);
// Phải khớp NEXT trong src/lib/services/content.ts (backend vẫn là nơi kiểm tra cuối cùng).
const NEXT: Record<string, string[]> = {
  idea: ['researching', 'writing', 'draft', 'archived'], researching: ['writing', 'draft', 'archived'], writing: ['draft', 'archived'], draft: ['pending_review', 'archived'],
  pending_review: ['approved', 'changes_requested', 'draft', 'archived'], changes_requested: ['draft', 'pending_review', 'archived'],
  approved: ['in_production', 'ready_to_publish', 'scheduled', 'draft', 'archived'], in_production: ['ready_to_publish', 'scheduled', 'draft', 'archived'],
  ready_to_publish: ['scheduled', 'published', 'draft', 'archived'], scheduled: ['published', 'failed', 'ready_to_publish', 'archived'], published: ['archived'],
  failed: ['ready_to_publish', 'scheduled', 'draft', 'archived'], archived: ['draft'],
};
// Các trạng thái cần thông tin bổ sung -> phải xử lý trong trang chi tiết, không đổi nhanh ở danh sách.
const NEEDS_DETAIL = new Set(['scheduled', 'published', 'changes_requested']);

export default function ContentList() {
  const router = useRouter();
  const { toast } = useUi();
  const [view, setView] = useState<'list' | 'kanban'>('list');
  const [status, setStatus] = useState('');
  const [platform, setPlatform] = useState('');
  const [type, setType] = useState('');
  const [pillar, setPillar] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [nf, setNf] = useState({ title: '', content_type: 'post', platform: 'facebook_profile', pillar: '' });
  const [dragId, setDragId] = useState<string | null>(null);
  const [moveErr, setMoveErr] = useState<string | null>(null);
  const { busy, run } = useAction();

  const path = useMemo(() => {
    const p = new URLSearchParams({ originals: 'true' });
    if (status) p.set('status', status);
    if (platform) p.set('platform', platform);
    if (type) p.set('content_type', type);
    if (pillar) p.set('pillar', pillar);
    if (search.trim()) p.set('q', search.trim());
    return `/contents?${p}`;
  }, [status, platform, type, pillar, search]);
  const { data, error, loading, reload } = useApi<{ items: Item[] }>(path);
  const { data: brands } = useApi<{ items: { pillars: { name: string }[] }[] }>('/brands');
  const pillars = brands?.items[0]?.pillars.map((p) => p.name) ?? [];
  const items = data?.items ?? [];

  const create = () => run('create', async () => {
    const r = await api<{ id: string }>('/contents', { body: { title: nf.title.trim(), content_type: nf.content_type, platform: nf.platform, pillar: nf.pillar } });
    setOpen(false);
    router.push(`/content/${r.id}`);
  });

  const move = async (it: Item, to: string) => {
    setMoveErr(null);
    if (to === it.status) return;
    if (NEEDS_DETAIL.has(to)) {
      toast(`Chuyển sang “${STATUS_LABEL[to]}” cần thêm thông tin (ghi chú/ngày giờ/xác nhận) — mở trang chi tiết để thực hiện.`, 'info');
      router.push(`/content/${it.id}`);
      return;
    }
    await run(`mv-${it.id}`, async () => {
      try { await api(`/contents/${it.id}/transition`, { body: { to } }); }
      catch (e) { setMoveErr(`“${it.title}”: ${(e as Error).message}`); throw e; }
      await reload();
    }, `Đã chuyển sang “${STATUS_LABEL[to]}”`);
  };

  const cols = status ? [status] : ALL_STATUSES;

  return (
    <div>
      <PageHeader title="Content Factory" desc="Mọi nội dung gốc từ ý tưởng đến khi đăng. Hệ thống không tự đăng bài — bạn đăng thủ công rồi đánh dấu “Đã đăng”."
        actions={<>
          <a href="/api/contents/export.csv" className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 text-sm font-medium hover:bg-surface2"><Download className="h-4 w-4" />Xuất CSV</a>
          <Button variant="primary" onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Tạo nội dung mới</Button>
        </>} />

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <div className="relative col-span-2 lg:col-span-2">
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted" aria-hidden />
          <Input aria-label="Tìm kiếm" className="pl-9" placeholder="Tìm theo tiêu đề / nội dung" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select aria-label="Trạng thái" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Mọi trạng thái</option>{ALL_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</Select>
        <Select aria-label="Nền tảng" value={platform} onChange={(e) => setPlatform(e.target.value)}><option value="">Mọi nền tảng</option>{Object.entries(PLATFORM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select aria-label="Loại" value={type} onChange={(e) => setType(e.target.value)}><option value="">Mọi loại</option>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select aria-label="Trụ cột" value={pillar} onChange={(e) => setPillar(e.target.value)}><option value="">Mọi trụ cột</option>{pillars.map((n) => <option key={n}>{n}</option>)}</Select>
      </div>

      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="inline-flex overflow-hidden rounded-lg border border-line" role="group" aria-label="Kiểu hiển thị">
          <button onClick={() => setView('list')} aria-pressed={view === 'list'} className={clsx('inline-flex h-9 items-center gap-1.5 px-3 text-sm', view === 'list' ? 'bg-brand text-white' : 'bg-surface hover:bg-surface2')}><List className="h-4 w-4" />Danh sách</button>
          <button onClick={() => setView('kanban')} aria-pressed={view === 'kanban'} className={clsx('inline-flex h-9 items-center gap-1.5 px-3 text-sm', view === 'kanban' ? 'bg-brand text-white' : 'bg-surface hover:bg-surface2')}><KanbanSquare className="h-4 w-4" />Kanban</button>
        </div>
        <p className="text-xs text-muted">{data ? `${items.length} nội dung gốc` : ''}</p>
      </div>

      <ErrorNote message={error} />
      {moveErr && <div className="mb-3"><ErrorNote message={moveErr} /></div>}
      {loading && !data && <Spinner />}

      {data && view === 'list' && (
        <Table head={['Tiêu đề', 'Trạng thái', 'Loại', 'Nền tảng', 'Biến thể', 'Phiên bản', 'Phụ trách', 'Dự kiến đăng', 'Cập nhật']}
          empty={items.length === 0 ? <div className="p-4"><Empty title="Chưa có nội dung nào" hint="Tạo nội dung mới hoặc chạy AI Agent hôm nay ở Tổng quan." action={<Button variant="primary" onClick={() => setOpen(true)}>Tạo nội dung mới</Button>} /></div> : undefined}>
          {items.map((it) => (
            <tr key={it.id} className="hover:bg-surface2/50">
              <Td className="max-w-[320px]">
                <Link href={`/content/${it.id}`} className="font-medium hover:underline">{it.title || '(chưa có tiêu đề)'}</Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-1"><DemoBadge show={it.is_demo} />{it.pillar && <span className="text-xs text-muted">{it.pillar}</span>}</div>
              </Td>
              <Td><StatusBadge status={it.status} /></Td>
              <Td>{TYPE_LABEL[it.content_type] ?? it.content_type}</Td>
              <Td>{PLATFORM_LABEL[it.platform] ?? it.platform}</Td>
              <Td className="tabular-nums">{Number(it.variant_count)}</Td>
              <Td className="tabular-nums">v{it.current_version}</Td>
              <Td>{it.assignee_name ?? '—'}</Td>
              <Td className="whitespace-nowrap">{it.status === 'published' ? <span>Đã đăng {fmtDateTime(it.published_at)}</span> : fmtDateTime(it.scheduled_at)}</Td>
              <Td className="whitespace-nowrap text-xs text-muted">{fmtDateTime(it.updated_at)}</Td>
            </tr>
          ))}
        </Table>
      )}

      {data && view === 'kanban' && (
        items.length === 0 ? <Empty title="Chưa có nội dung nào" hint="Thay đổi bộ lọc hoặc tạo nội dung mới." /> : (
          <div className="-mx-4 overflow-x-auto px-4 pb-3 sm:mx-0 sm:px-0">
            <div className="flex gap-3">
              {cols.map((s) => {
                const list = items.filter((i) => i.status === s);
                return (
                  <div key={s} className="w-72 shrink-0 rounded-xl border border-line bg-surface2/50 p-2"
                    onDragOver={(e) => { if (dragId) e.preventDefault(); }}
                    onDrop={(e) => { e.preventDefault(); const it = items.find((i) => i.id === dragId); setDragId(null); if (it) void move(it, s); }}>
                    <div className="mb-2 flex items-center justify-between px-1"><StatusBadge status={s} /><span className="text-xs text-muted tabular-nums">{list.length}</span></div>
                    <div className="space-y-2">
                      {list.map((it) => (
                        <div key={it.id} draggable onDragStart={() => setDragId(it.id)} onDragEnd={() => setDragId(null)} className={clsx('rounded-lg border border-line bg-surface p-2.5 text-sm shadow-sm', dragId === it.id && 'opacity-50')}>
                          <Link href={`/content/${it.id}`} className="line-clamp-2 font-medium hover:underline">{it.title || '(chưa có tiêu đề)'}</Link>
                          <div className="mt-1.5 flex flex-wrap gap-1"><DemoBadge show={it.is_demo} /><Badge>{TYPE_LABEL[it.content_type] ?? it.content_type}</Badge><Badge tone="blue">{PLATFORM_LABEL[it.platform] ?? it.platform}</Badge></div>
                          <p className="mt-1.5 text-xs text-muted">v{it.current_version} · {Number(it.variant_count)} biến thể{it.assignee_name ? ` · ${it.assignee_name}` : ''}{it.scheduled_at ? ` · ${fmtDateTime(it.scheduled_at)}` : ''}</p>
                          <Select aria-label={`Đổi trạng thái: ${it.title}`} className="mt-2 !h-8 text-xs" value="" disabled={busy === `mv-${it.id}`} onChange={(e) => { if (e.target.value) void move(it, e.target.value); }}>
                            <option value="">Chuyển trạng thái…</option>
                            {(NEXT[it.status] ?? []).map((n) => <option key={n} value={n}>{STATUS_LABEL[n]}{NEEDS_DETAIL.has(n) ? ' (mở chi tiết)' : ''}</option>)}
                          </Select>
                        </div>
                      ))}
                      {list.length === 0 && <p className="px-1 py-3 text-center text-xs text-muted">Trống</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )
      )}
      {data && view === 'kanban' && <Card className="mt-3"><p className="text-xs text-muted">Kéo thả hoặc dùng menu để đổi trạng thái — mọi thay đổi đi qua kiểm tra của hệ thống. Duyệt/Yêu cầu sửa chỉ dành cho quản trị viên; Lên lịch và Đã đăng cần xác nhận ở trang chi tiết.</p></Card>}

      <Modal open={open} onClose={() => setOpen(false)} title="Tạo nội dung mới"
        footer={<><Button onClick={() => setOpen(false)}>Huỷ</Button><Button variant="primary" busy={busy === 'create'} disabled={!nf.title.trim()} onClick={create}>Tạo và mở trình soạn</Button></>}>
        <div className="space-y-3">
          <Field label="Tiêu đề"><Input value={nf.title} maxLength={300} onChange={(e) => setNf({ ...nf, title: e.target.value })} autoFocus /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Loại"><Select value={nf.content_type} onChange={(e) => setNf({ ...nf, content_type: e.target.value })}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Nền tảng"><Select value={nf.platform} onChange={(e) => setNf({ ...nf, platform: e.target.value })}>{Object.entries(PLATFORM_LABEL).filter(([k]) => k !== 'other' && k !== 'youtube').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          </div>
          <Field label="Trụ cột nội dung"><Select value={nf.pillar} onChange={(e) => setNf({ ...nf, pillar: e.target.value })}><option value="">— Chưa chọn —</option>{pillars.map((n) => <option key={n}>{n}</option>)}</Select></Field>
        </div>
      </Modal>
    </div>
  );
}

'use client';
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { CalendarPlus, ChevronLeft, ChevronRight } from 'lucide-react';
import { api, ApiError, fmtDateTime, PLATFORM_LABEL, STATUS_LABEL, useApi } from '@/lib/client';
import { Badge, Button, DemoBadge, Empty, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, StatusBadge, Table, Td, Tabs, useAction, useUi } from '@/components/ui';
import { addDays, addMonths, dayKey, dayLabel, fromLocalInput, monthLabel, startOfWeek, todayKey, toLocalInput, vnToIso } from '@/components/calendar/date-utils';
import { DayView, KanbanView, MonthView, WeekView, typeLabel, type CalItem, type ContentRow } from '@/components/calendar/views';
import { KpiPanel } from '@/components/calendar/kpi-panel';

type Mode = 'month' | 'week' | 'day' | 'kanban' | 'list';
const MODES: { id: Mode; label: string }[] = [{ id: 'month', label: 'Tháng' }, { id: 'week', label: 'Tuần' }, { id: 'day', label: 'Ngày' }, { id: 'kanban', label: 'Kanban' }, { id: 'list', label: 'Danh sách' }];

function rangeFor(mode: Mode, a: string): { from: string; to: string } | null {
  if (mode === 'month') { const s = startOfWeek(a.slice(0, 8) + '01'); return { from: vnToIso(s, '00:00'), to: vnToIso(addDays(s, 42), '00:00') }; }
  if (mode === 'week') { const s = startOfWeek(a); return { from: vnToIso(s, '00:00'), to: vnToIso(addDays(s, 7), '00:00') }; }
  if (mode === 'day') return { from: vnToIso(a, '00:00'), to: vnToIso(addDays(a, 1), '00:00') };
  return null;
}

function DetailModal({ item, onClose, onMove }: { item: CalItem; onClose: () => void; onMove: (i: CalItem, iso: string) => Promise<boolean> }) {
  const [when, setWhen] = useState(toLocalInput(item.scheduled_at));
  const [busy, setBusy] = useState(false);
  const locked = item.status === 'published';
  return (
    <Modal open onClose={onClose} title="Chi tiết lịch đăng" footer={<><Button onClick={onClose}>Đóng</Button><Link href={`/content/${item.id}`} className="inline-flex h-10 items-center rounded-lg border border-line bg-surface px-3.5 text-sm font-medium hover:bg-surface2">Mở nội dung</Link>
      <Button variant="primary" disabled={locked || !when} busy={busy} onClick={async () => { setBusy(true); const ok = await onMove(item, fromLocalInput(when)); setBusy(false); if (ok) onClose(); }}>Lưu ngày giờ</Button></>}>
      <div className="space-y-3 text-sm">
        <p className="break-words text-base font-semibold">{item.title}</p>
        <p className="flex flex-wrap items-center gap-1.5"><StatusBadge status={item.status} /><DemoBadge show={item.is_demo} /><Badge>{PLATFORM_LABEL[item.platform] ?? item.platform}</Badge><Badge>{typeLabel(item.content_type)}</Badge></p>
        <dl className="grid grid-cols-2 gap-2 text-xs"><div><dt className="text-muted">Kênh</dt><dd>{item.channel_name ?? '—'}</dd></div><div><dt className="text-muted">Người phụ trách</dt><dd>{item.assignee_name ?? '—'}</dd></div><div className="col-span-2"><dt className="text-muted">Lịch hiện tại</dt><dd>{fmtDateTime(item.scheduled_at)} (giờ Việt Nam)</dd></div></dl>
        {locked ? <Notice tone="blue">Nội dung đã đăng, không thể đổi lịch.</Notice> : (
          <Field label="Đổi ngày giờ (giờ Việt Nam)" hint={item.status === 'scheduled' ? 'Lịch này đã được xác nhận: đổi sẽ cần bạn xác nhận thêm một lần.' : undefined}>
            <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
        )}
        <p className="text-xs text-muted">Việc lên lịch/duyệt thực hiện ở trang nội dung; hệ thống không tự đăng bài.</p>
      </div>
    </Modal>
  );
}

function SchedulePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const a = useApi<{ items: ContentRow[] }>(open ? '/contents?status=approved&originals=true' : null);
  const b = useApi<{ items: ContentRow[] }>(open ? '/contents?status=ready_to_publish&originals=true' : null);
  const rows = [...(a.data?.items ?? []), ...(b.data?.items ?? [])].filter((r) => !r.scheduled_at);
  return (
    <Modal open={open} onClose={onClose} title="Lên lịch nội dung" footer={<Button onClick={onClose}>Đóng</Button>}>
      <p className="mb-3 text-xs text-muted">Chọn nội dung đã duyệt, chưa có lịch. Bạn sẽ được chuyển tới trang nội dung để lên lịch đúng quy trình duyệt — lịch không được tạo tại đây.</p>
      <ErrorNote message={a.error ?? b.error} />
      {(a.loading || b.loading) && !rows.length ? <Spinner /> : rows.length === 0 ? <Empty title="Không có nội dung đã duyệt nào đang chờ lịch" hint="Duyệt nội dung ở Content Factory trước, rồi quay lại đây." /> : (
        <ul className="divide-y divide-line">
          {rows.map((r) => <li key={r.id}><Link href={`/content/${r.id}`} className="flex items-center justify-between gap-2 py-2.5 hover:bg-surface2"><span className="min-w-0"><span className="block truncate text-sm font-medium">{r.title}</span><span className="text-xs text-muted">{PLATFORM_LABEL[r.platform] ?? r.platform} · {typeLabel(r.content_type)}</span></span><span className="flex shrink-0 items-center gap-1.5"><DemoBadge show={r.is_demo} /><StatusBadge status={r.status} /></span></Link></li>)}
        </ul>
      )}
    </Modal>
  );
}

function ListView({ rows }: { rows: ContentRow[] }) {
  const [status, setStatus] = useState('');
  const [platform, setPlatform] = useState('');
  const [q, setQ] = useState('');
  const shown = rows.filter((r) => (!status || r.status === status) && (!platform || r.platform === platform) && (!q || r.title.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Input aria-label="Tìm theo tiêu đề" placeholder="Tìm theo tiêu đề…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label="Trạng thái" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Mọi trạng thái</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select aria-label="Nền tảng" value={platform} onChange={(e) => setPlatform(e.target.value)}><option value="">Mọi nền tảng</option>{Object.entries(PLATFORM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
      </div>
      <Table head={['Tiêu đề', 'Nền tảng', 'Kênh', 'Định dạng', 'Trạng thái', 'Phụ trách', 'Lịch đăng']} empty={shown.length ? undefined : <div className="p-3"><Empty title="Không có nội dung phù hợp" /></div>}>
        {shown.map((r) => (
          <tr key={r.id}>
            <Td className="max-w-72"><Link href={`/content/${r.id}`} className="line-clamp-2 break-words font-medium hover:underline">{r.title}</Link><DemoBadge show={r.is_demo} /></Td>
            <Td>{PLATFORM_LABEL[r.platform] ?? r.platform}</Td><Td>{r.channel_name ?? '—'}</Td><Td>{typeLabel(r.content_type)}</Td><Td><StatusBadge status={r.status} /></Td><Td>{r.assignee_name ?? '—'}</Td>
            <Td className="whitespace-nowrap">{r.scheduled_at ? fmtDateTime(r.scheduled_at) : '—'}</Td>
          </tr>
        ))}
      </Table>
      <p className="text-xs text-muted">{shown.length}/{rows.length} nội dung gốc (tối đa 500 nội dung mới cập nhật gần nhất).</p>
    </div>
  );
}

export default function CalendarPage() {
  const { toast, confirm } = useUi();
  const { run } = useAction();
  const [mode, setMode] = useState<Mode>('month');
  const [anchor, setAnchor] = useState(todayKey());
  const [selDay, setSelDay] = useState(todayKey());
  const [open, setOpen] = useState<CalItem | null>(null);
  const [picker, setPicker] = useState(false);
  const [kpiKey, setKpiKey] = useState(0);

  const range = rangeFor(mode, anchor);
  const cal = useApi<{ items: CalItem[] }>(range ? `/calendar?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : null);
  const all = useApi<{ items: ContentRow[] }>(mode === 'kanban' || mode === 'list' ? '/contents?originals=true' : null);
  const items = useMemo(() => cal.data?.items ?? [], [cal.data]);
  const { reload: reloadCal } = cal;

  /** Đổi lịch. Lịch đã xác nhận (scheduled) luôn hỏi xác nhận rồi gửi confirm:true. Trả true nếu đã đổi. */
  const move = useCallback(async (item: CalItem, iso: string): Promise<boolean> => {
    if (item.status === 'published') { toast('Nội dung đã đăng, không thể đổi lịch', 'err'); return false; }
    const ask = () => confirm({ title: 'Đổi lịch đã xác nhận?', body: <>“{item.title}” đang ở trạng thái <b>Đã lên lịch</b>. Dời từ <b>{fmtDateTime(item.scheduled_at)}</b> sang <b>{fmtDateTime(iso)}</b>?</>, confirmLabel: 'Xác nhận đổi lịch' });
    let confirmed = false;
    if (item.status === 'scheduled') { if (!(await ask())) return false; confirmed = true; }
    const call = (c: boolean) => api(`/calendar/${item.id}/move`, { method: 'PATCH', body: { scheduled_at: iso, confirm: c } });
    const r = await run('move', async () => {
      try { await call(confirmed); }
      catch (e) { if (e instanceof ApiError && e.status === 409 && !confirmed) { if (!(await ask())) return false; await call(true); } else throw e; }
      return true;
    }, 'Đã đổi lịch');
    if (r) { reloadCal(); setKpiKey((k) => k + 1); }
    return !!r;
  }, [confirm, reloadCal, run, toast]);

  const step = (n: number) => { const next = mode === 'month' ? addMonths(anchor, n) : addDays(anchor, mode === 'week' ? 7 * n : n); setAnchor(next); if (mode === 'month') setSelDay(next); };
  const title = mode === 'month' ? monthLabel(anchor) : mode === 'week' ? `${dayLabel(startOfWeek(anchor))} – ${dayLabel(addDays(startOfWeek(anchor), 6))}` : dayLabel(anchor) + ` (${anchor.slice(0, 4)})`;
  const calMode = mode === 'month' || mode === 'week' || mode === 'day';
  const err = calMode ? cal.error : all.error;

  return (
    <div className="space-y-4">
      <PageHeader title="Lịch nội dung" desc="Lịch theo giờ Việt Nam (Asia/Ho_Chi_Minh), chỉ gồm nội dung gốc đã có lịch. Hệ thống không tự đăng bài."
        actions={<Button variant="primary" onClick={() => setPicker(true)}><CalendarPlus className="h-4 w-4" />Lên lịch nội dung</Button>} />
      <KpiPanel refreshKey={kpiKey} />
      <Tabs tabs={MODES} value={mode} onChange={setMode} />
      {calMode && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => step(-1)} aria-label="Trước"><ChevronLeft className="h-4 w-4" /></Button>
          <Button size="sm" onClick={() => { setAnchor(todayKey()); setSelDay(todayKey()); }}>Hôm nay</Button>
          <Button size="sm" onClick={() => step(1)} aria-label="Sau"><ChevronRight className="h-4 w-4" /></Button>
          <h2 className="ml-1 text-sm font-semibold">{title}</h2>
          <span className="ml-auto text-xs text-muted">{cal.loading ? 'Đang tải…' : `${items.length} nội dung`}</span>
        </div>
      )}
      <ErrorNote message={err} />
      {calMode && !cal.data && cal.loading && <Spinner />}
      {calMode && (cal.data || cal.error) && (
        <>
          {cal.data && items.length === 0 && <Notice tone="blue">Chưa có nội dung nào được lên lịch trong khoảng này. Dùng “Lên lịch nội dung” để chọn nội dung đã duyệt.</Notice>}
          {mode === 'month' && <MonthView anchor={anchor} items={items} onOpen={setOpen} onMove={(i, iso) => void move(i, iso)} selected={selDay} onSelect={setSelDay} />}
          {mode === 'week' && <WeekView anchor={anchor} items={items} onOpen={setOpen} onMove={(i, iso) => void move(i, iso)} />}
          {mode === 'day' && <DayView anchor={anchor} items={items} onOpen={setOpen} onMove={(i, iso) => void move(i, iso)} />}
        </>
      )}
      {!calMode && (all.loading && !all.data ? <Spinner /> : all.data && (all.data.items.length === 0 ? <Empty title="Chưa có nội dung gốc nào" hint="Chạy AI Agent hôm nay ở Tổng quan hoặc tạo nội dung ở Content Factory." /> : mode === 'kanban' ? <KanbanView rows={all.data.items} /> : <ListView rows={all.data.items} />))}
      {open && <DetailModal key={open.id} item={items.find((i) => i.id === open.id) ?? open} onClose={() => setOpen(null)} onMove={move} />}
      <SchedulePicker open={picker} onClose={() => setPicker(false)} />
    </div>
  );
}

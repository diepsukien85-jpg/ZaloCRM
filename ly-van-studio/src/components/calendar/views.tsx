'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { FORMAT_LABEL, PLATFORM_LABEL, TYPE_LABEL } from '@/lib/client';
import { Badge, DemoBadge, StatusBadge, clsx } from '@/components/ui';
import { addDays, dayKey, dayLabel, startOfWeek, timeOf, todayKey, vnToIso, WEEKDAYS } from './date-utils';

export type CalItem = {
  id: string; title: string; platform: string; content_type: string; status: string; scheduled_at: string; assignee_id: string | null; assignee_name: string | null; channel_name: string | null; is_demo: boolean;
};
export type ContentRow = {
  id: string; title: string; content_type: string; platform: string; pillar: string | null; status: string; scheduled_at: string | null; channel_name: string | null; assignee_name: string | null; is_demo: boolean; updated_at: string;
};
export const typeLabel = (t: string) => TYPE_LABEL[t] ?? FORMAT_LABEL[t] ?? t;

type Handlers = { onOpen: (i: CalItem) => void; onMove: (i: CalItem, iso: string) => void; items: CalItem[] };

function useDnd(items: CalItem[], onMove: Handlers['onMove']) {
  const [over, setOver] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const find = (id: string) => items.find((i) => i.id === id);
  return {
    over, drag,
    cardProps: (i: CalItem) => ({ draggable: i.status !== 'published', onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/plain', i.id); e.dataTransfer.effectAllowed = 'move'; setDrag(i.id); }, onDragEnd: () => { setDrag(null); setOver(null); } }),
    zoneProps: (zone: string, target: (i: CalItem) => string) => ({
      onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOver(zone); },
      onDragLeave: () => setOver((o) => (o === zone ? null : o)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault(); setOver(null);
        const it = find(e.dataTransfer.getData('text/plain') || drag || '');
        setDrag(null);
        if (!it) return;
        const iso = target(it);
        if (new Date(iso).getTime() !== new Date(it.scheduled_at).getTime()) onMove(it, iso);
      },
    }),
  };
}

export function CalCard({ item, compact, onOpen, dnd }: { item: CalItem; compact?: boolean; onOpen: (i: CalItem) => void; dnd: ReturnType<typeof useDnd> }) {
  return (
    <div {...dnd.cardProps(item)} onClick={(e) => { e.stopPropagation(); onOpen(item); }} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(item)}
      title={item.status === 'published' ? 'Đã đăng — không thể đổi lịch' : 'Kéo để đổi lịch, bấm để xem chi tiết'}
      className={clsx('cursor-pointer rounded-lg border border-line bg-surface text-left shadow-sm hover:border-brand', item.status === 'published' ? 'opacity-80' : 'cursor-grab', dnd.drag === item.id && 'opacity-40', compact ? 'px-1.5 py-1 text-[11px]' : 'p-2 text-xs')}>
      <p className="flex items-center gap-1"><span className="font-semibold tabular-nums">{timeOf(item.scheduled_at)}</span><span className="min-w-0 flex-1 truncate font-medium">{item.title}</span></p>
      {!compact && (
        <div className="mt-1 space-y-1">
          <p className="truncate text-muted">{PLATFORM_LABEL[item.platform] ?? item.platform}{item.channel_name ? ` · ${item.channel_name}` : ''} · {typeLabel(item.content_type)}</p>
          <p className="flex flex-wrap items-center gap-1"><StatusBadge status={item.status} /><DemoBadge show={item.is_demo} />{item.assignee_name && <span className="text-muted">{item.assignee_name}</span>}</p>
        </div>
      )}
    </div>
  );
}

const byTime = (a: CalItem, b: CalItem) => a.scheduled_at.localeCompare(b.scheduled_at);
function group(items: CalItem[]) { const m = new Map<string, CalItem[]>(); for (const i of [...items].sort(byTime)) { const k = dayKey(i.scheduled_at); m.set(k, [...(m.get(k) ?? []), i]); } return m; }

export function MonthView({ anchor, items, onOpen, onMove, selected, onSelect }: Handlers & { anchor: string; selected: string; onSelect: (k: string) => void }) {
  const dnd = useDnd(items, onMove);
  const by = useMemo(() => group(items), [items]);
  const first = startOfWeek(anchor.slice(0, 8) + '01');
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const today = todayKey();
  return (
    <div>
      <div className="grid grid-cols-7 text-center text-xs text-muted">{WEEKDAYS.map((w) => <div key={w} className="py-1">{w}</div>)}</div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-line bg-line">
        {days.map((k) => {
          const list = by.get(k) ?? []; const inMonth = k.slice(0, 7) === anchor.slice(0, 7);
          return (
            <div key={k} onClick={() => onSelect(k)} {...dnd.zoneProps(k, (it) => vnToIso(k, timeOf(it.scheduled_at)))}
              className={clsx('min-h-14 cursor-pointer bg-surface p-1 md:min-h-28', !inMonth && 'bg-surface2/60 text-muted', dnd.over === k && 'ring-2 ring-inset ring-gold', selected === k && 'outline outline-2 -outline-offset-2 outline-brand')}>
              <p className={clsx('mb-1 text-xs tabular-nums', k === today && 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand font-semibold text-white')}>{Number(k.slice(8))}</p>
              <div className="hidden space-y-1 md:block">
                {list.slice(0, 3).map((i) => <CalCard key={i.id} item={i} compact onOpen={onOpen} dnd={dnd} />)}
                {list.length > 3 && <p className="text-[11px] text-muted">+{list.length - 3} nữa</p>}
              </div>
              {list.length > 0 && <p className="md:hidden"><Badge tone="blue">{list.length}</Badge></p>}
            </div>
          );
        })}
      </div>
      <div className="mt-3">
        <h3 className="mb-2 text-sm font-semibold">Ngày {dayLabel(selected)}</h3>
        {(by.get(selected) ?? []).length === 0 ? <p className="text-sm text-muted">Không có nội dung nào lên lịch trong ngày này.</p> : <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{(by.get(selected) ?? []).map((i) => <CalCard key={i.id} item={i} onOpen={onOpen} dnd={dnd} />)}</div>}
        <p className="mt-2 text-xs text-muted">Kéo thẻ sang ô ngày khác để đổi ngày (giữ nguyên giờ). Trên điện thoại hãy mở thẻ và đổi ngày giờ trong chi tiết.</p>
      </div>
    </div>
  );
}

export function WeekView({ anchor, items, onOpen, onMove }: Handlers & { anchor: string }) {
  const dnd = useDnd(items, onMove);
  const by = useMemo(() => group(items), [items]);
  const start = startOfWeek(anchor);
  const today = todayKey();
  return (
    <div>
      <div className="grid gap-2 md:grid-cols-7">
        {Array.from({ length: 7 }, (_, i) => addDays(start, i)).map((k) => (
          <div key={k} {...dnd.zoneProps(k, (it) => vnToIso(k, timeOf(it.scheduled_at)))} className={clsx('min-h-24 rounded-lg border border-line bg-surface p-2', dnd.over === k && 'ring-2 ring-gold')}>
            <p className={clsx('mb-2 text-xs font-semibold', k === today && 'text-brand')}>{dayLabel(k)}</p>
            <div className="space-y-1.5">{(by.get(k) ?? []).map((i) => <CalCard key={i.id} item={i} onOpen={onOpen} dnd={dnd} />)}{!(by.get(k) ?? []).length && <p className="text-xs text-muted">—</p>}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">Kéo thẻ sang cột ngày khác để đổi ngày (giữ nguyên giờ); mở thẻ để chỉnh giờ cụ thể.</p>
    </div>
  );
}

export function DayView({ anchor, items, onOpen, onMove }: Handlers & { anchor: string }) {
  const dnd = useDnd(items, onMove);
  const list = useMemo(() => items.filter((i) => dayKey(i.scheduled_at) === anchor).sort(byTime), [items, anchor]);
  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-line">
        {Array.from({ length: 24 }, (_, h) => {
          const hh = String(h).padStart(2, '0'); const zone = `h${hh}`;
          const here = list.filter((i) => timeOf(i.scheduled_at).slice(0, 2) === hh);
          return (
            <div key={h} {...dnd.zoneProps(zone, (it) => vnToIso(anchor, `${hh}:${timeOf(it.scheduled_at).slice(3)}`))} className={clsx('flex gap-2 border-b border-line bg-surface last:border-b-0', here.length ? 'min-h-14 p-1.5' : 'min-h-8 px-1.5 py-1', dnd.over === zone && 'bg-gold/20')}>
              <span className="w-12 shrink-0 pt-1 text-xs tabular-nums text-muted">{hh}:00</span>
              <div className="grid min-w-0 flex-1 gap-1.5 sm:grid-cols-2">{here.map((i) => <CalCard key={i.id} item={i} onOpen={onOpen} dnd={dnd} />)}</div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted">Kéo thẻ sang khung giờ khác để đổi giờ (giữ nguyên phút).</p>
    </div>
  );
}

export function KanbanView({ rows }: { rows: ContentRow[] }) {
  const cols: [string, string][] = [['draft', 'Bản nháp'], ['pending_review', 'Chờ duyệt'], ['changes_requested', 'Yêu cầu sửa'], ['approved', 'Đã duyệt'], ['in_production', 'Đang sản xuất'], ['ready_to_publish', 'Sẵn sàng đăng'], ['scheduled', 'Đã lên lịch'], ['published', 'Đã đăng'], ['failed', 'Thất bại']];
  return (
    <div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {cols.map(([st, label]) => {
          const list = rows.filter((r) => r.status === st);
          return (
            <div key={st} className="w-64 shrink-0 rounded-xl border border-line bg-surface2/50 p-2">
              <p className="mb-2 flex items-center justify-between px-1 text-xs font-semibold">{label}<Badge>{list.length}</Badge></p>
              <div className="space-y-2">
                {list.map((r) => (
                  <Link key={r.id} href={`/content/${r.id}`} className="block rounded-lg border border-line bg-surface p-2 text-xs hover:border-brand">
                    <p className="line-clamp-2 break-words font-medium">{r.title}</p>
                    <p className="mt-1 truncate text-muted">{PLATFORM_LABEL[r.platform] ?? r.platform} · {typeLabel(r.content_type)}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-1"><DemoBadge show={r.is_demo} />{r.scheduled_at && <span className="text-muted">{dayLabel(dayKey(r.scheduled_at))} {timeOf(r.scheduled_at)}</span>}</p>
                  </Link>
                ))}
                {!list.length && <p className="px-1 text-xs text-muted">Trống</p>}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-muted">Chỉ gồm nội dung gốc (không gồm biến thể). Đổi trạng thái ở trang chi tiết nội dung để đúng quy trình duyệt.</p>
    </div>
  );
}

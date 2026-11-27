'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Play } from 'lucide-react';
import { api, fmtNum, fmtPct, fmtRatio, fmtUsd, fmtVnd, PLATFORM_LABEL, useApi, vnDate } from '@/lib/client';
import { Badge, Button, Card, DemoBadge, Empty, ErrorNote, Modal, Notice, PageHeader, Select, Spinner, Stat, useAction } from '@/components/ui';
import { RunProgress } from '@/components/run-progress';

type Dash = {
  range: { from: string; to: string }; production: Record<string, number>; today: Record<string, number>; videos_made: number; leads_in_range: number;
  totals: { views: number; reach: number; leads: number; orders: number; revenue: number; ad_spend: number; ai_cost: number; gross_profit: number }; followers: number; snapshots: number; ai_cost_usd: number;
  metrics: { engagement_rate: number | null; cpl: number | null; roas: number | null; marketing_roi: number | null; profit_after_marketing: number };
  top: { id: string; title: string; views: number; engagement_rate: number | null }[]; pillars: { label: string; views: number; leads: number }[]; trend: { label: string; views: number }[];
  kpi: { posts_per_day: number; short_videos_per_day: number; originals_per_30_days: number }; budgets: { scope: string; limit: number; spent: number; pct: number; warn: boolean; exceeded: boolean }[];
  last_daily_run: { id: string; status: string; is_demo: boolean; finished_at: string | null } | null;
};
const daysAgo = (n: number) => vnDate(new Date(Date.now() - n * 86400000));

function KpiBar({ label, value, target }: { label: string; value: number; target: number }) {
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs"><span>{label}</span><span className="tabular-nums">{value}/{target}</span></div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface2"><div className="h-full bg-teal" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export default function Dashboard() {
  const [days, setDays] = useState(30);
  const [platform, setPlatform] = useState('');
  const [pillar, setPillar] = useState('');
  const [contentType, setContentType] = useState('');
  const path = useMemo(() => {
    const p = new URLSearchParams({ from: daysAgo(days - 1), to: vnDate() });
    if (platform) p.set('platform', platform);
    if (pillar) p.set('pillar', pillar);
    if (contentType) p.set('content_type', contentType);
    return `/dashboard?${p}`;
  }, [days, platform, pillar, contentType]);
  const { data: d, error, loading, reload } = useApi<Dash>(path);
  const { data: brands } = useApi<{ items: { pillars: { name: string }[] }[] }>('/brands');
  const [runId, setRunId] = useState<string | null>(null);
  const { busy, run } = useAction();

  const start = () => run('daily', async () => { const r = await api<{ run_id: string }>('/workflows/daily/run', { body: {} }); setRunId(r.run_id); });
  const pillarNames = brands?.items[0]?.pillars.map((p) => p.name) ?? [];

  return (
    <div>
      <PageHeader title="Tổng quan" desc="Số liệu hiệu quả chỉ gồm dữ liệu bạn đã nhập/import hoặc đồng bộ từ API; chưa nhập thì hiển thị “—”."
        actions={<Button variant="gold" size="lg" busy={busy === 'daily'} onClick={start}><Play className="h-5 w-5" />CHẠY AI AGENT HÔM NAY</Button>} />

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Select aria-label="Khoảng thời gian" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>7 ngày</option><option value={30}>30 ngày</option><option value={90}>90 ngày</option></Select>
        <Select aria-label="Nền tảng" value={platform} onChange={(e) => setPlatform(e.target.value)}><option value="">Mọi nền tảng</option>{Object.entries(PLATFORM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select aria-label="Nhóm chủ đề" value={pillar} onChange={(e) => setPillar(e.target.value)}><option value="">Mọi chủ đề</option>{pillarNames.map((n) => <option key={n}>{n}</option>)}</Select>
        <Select aria-label="Định dạng" value={contentType} onChange={(e) => setContentType(e.target.value)}><option value="">Mọi định dạng</option><option value="post">Bài đăng</option><option value="video_script">Video</option><option value="carousel">Carousel</option></Select>
      </div>

      <ErrorNote message={error} />
      {loading && !d && <Spinner />}
      {d && (
        <div className="space-y-4">
          {d.snapshots === 0 && <Notice tone="blue">Chưa có số liệu hiệu quả nào. Vào <Link className="underline" href="/analytics">Phân tích hiệu quả</Link> để nhập thủ công hoặc import CSV — hệ thống không tự bịa số liệu.</Notice>}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Nội dung gốc đã sản xuất" value={fmtNum(d.production.originals)} hint={`${d.production.posts} bài · ${d.production.videos} kịch bản video`} />
            <Stat label="Đang chờ duyệt" value={fmtNum(d.production.pending)} />
            <Stat label="Đã lên lịch" value={fmtNum(d.production.scheduled)} />
            <Stat label="Đã đăng" value={fmtNum(d.production.published)} />
            <Stat label="Dự án video" value={fmtNum(d.videos_made)} />
            <Stat label="Tổng lượt xem (đã nhập)" value={d.snapshots ? fmtNum(d.totals.views) : '—'} />
            <Stat label="Người theo dõi mới" value={d.snapshots ? fmtNum(d.followers) : '—'} />
            <Stat label="Khách hàng tiềm năng" value={fmtNum(d.leads_in_range)} hint="Lead trong module Khách hàng" />
            <Stat label="Đơn hàng ghi nhận" value={d.snapshots ? fmtNum(d.totals.orders) : '—'} />
            <Stat label="Doanh thu từ nội dung" value={d.snapshots ? fmtVnd(d.totals.revenue) : '—'} hint={d.snapshots ? `Lợi nhuận sau MKT: ${fmtVnd(d.metrics.profit_after_marketing)}` : undefined} />
            <Stat label="Chi phí AI" value={fmtVnd(Math.round(d.totals.ai_cost))} hint={`${fmtUsd(d.ai_cost_usd)} (ước tính)`} />
            <Stat label="Chi phí quảng cáo" value={d.snapshots ? fmtVnd(d.totals.ad_spend) : '—'} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Lượt xem theo ngày" className="lg:col-span-2">
              {d.trend.length ? (
                <div className="h-56"><ResponsiveContainer width="100%" height="100%"><LineChart data={d.trend}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="label" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} width={48} /><Tooltip /><Line type="monotone" dataKey="views" name="Lượt xem" stroke="var(--brand)" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer></div>
              ) : <Empty title="Chưa có dữ liệu lượt xem" hint="Nhập số liệu ở mục Phân tích hiệu quả." />}
            </Card>
            <Card title="Tiến độ KPI">
              <div className="space-y-3">
                <KpiBar label="Bài đăng hôm nay" value={Math.min(d.today.posts, 999)} target={d.kpi.posts_per_day} />
                <KpiBar label="Video ngắn hôm nay" value={d.today.videos} target={d.kpi.short_videos_per_day} />
                <KpiBar label={`Nội dung gốc (${days} ngày)`} value={d.production.originals} target={Math.round((d.kpi.originals_per_30_days / 30) * days)} />
                <p className="text-xs text-muted">Chỉ đếm nội dung gốc, không đếm biến thể phân phối. KPI chỉnh trong Lịch nội dung.</p>
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Nội dung hiệu quả nhất">
              {d.top.length ? <ul className="space-y-2 text-sm">{d.top.map((t) => <li key={t.id} className="flex justify-between gap-2"><Link href={`/content/${t.id}`} className="truncate hover:underline">{t.title}</Link><span className="shrink-0 tabular-nums text-muted">{fmtNum(t.views)} views</span></li>)}</ul> : <Empty title="Chưa có dữ liệu" />}
            </Card>
            <Card title="Chủ đề hiệu quả nhất">
              {d.pillars.length ? <ul className="space-y-2 text-sm">{d.pillars.slice(0, 5).map((p) => <li key={p.label} className="flex justify-between gap-2"><span className="truncate">{p.label}</span><span className="tabular-nums text-muted">{fmtNum(p.views)}</span></li>)}</ul> : <Empty title="Chưa có dữ liệu" />}
            </Card>
            <Card title="Hiệu quả marketing" actions={<Badge tone="gray">tương quan, không nhân quả</Badge>}>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between"><dt>Tương tác/Views</dt><dd>{fmtPct(d.metrics.engagement_rate)}</dd></div>
                <div className="flex justify-between"><dt>CPL</dt><dd>{d.metrics.cpl == null ? '—' : fmtVnd(d.metrics.cpl)}</dd></div>
                <div className="flex justify-between"><dt>ROAS</dt><dd>{fmtRatio(d.metrics.roas)}</dd></div>
                <div className="flex justify-between"><dt>Marketing ROI</dt><dd>{fmtPct(d.metrics.marketing_roi)}</dd></div>
              </dl>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Daily Agent gần nhất" actions={<Link className="text-xs text-brand" href="/agents">Chi tiết →</Link>}>
              {d.last_daily_run ? <p className="text-sm">Trạng thái: <Badge tone={d.last_daily_run.status === 'succeeded' ? 'green' : 'red'}>{d.last_daily_run.status}</Badge> <DemoBadge show={d.last_daily_run.is_demo} /></p> : <p className="text-sm text-muted">Chưa chạy lần nào. Bấm “CHẠY AI AGENT HÔM NAY”.</p>}
            </Card>
            <Card title="Ngân sách AI">
              {d.budgets.length ? d.budgets.map((b) => <div key={b.scope} className="mb-2"><div className="flex justify-between text-xs"><span>{b.scope === 'daily' ? 'Ngày' : 'Tháng'}</span><span>{fmtUsd(b.spent, 3)} / {fmtUsd(b.limit, 2)}</span></div><div className="mt-1 h-2 overflow-hidden rounded-full bg-surface2"><div className={b.exceeded ? 'h-full bg-danger' : b.warn ? 'h-full bg-warn' : 'h-full bg-teal'} style={{ width: `${Math.min(100, b.pct)}%` }} /></div></div>) : <p className="text-sm text-muted">Chưa đặt ngân sách.</p>}
            </Card>
          </div>
        </div>
      )}

      <Modal open={!!runId} onClose={() => { setRunId(null); reload(); }} title="Daily Content Agent — tiến độ" wide>
        {runId && <RunProgress runId={runId} onDone={() => reload()} />}
        <p className="mt-3 text-xs text-muted">Kết quả là bản nháp chờ bạn duyệt tại <Link className="underline" href="/content">Content Factory</Link>. Hệ thống không tự đăng bài.</p>
      </Modal>
    </div>
  );
}

'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Download, Sparkles } from 'lucide-react';
import { api, fmtNum, fmtPct, fmtRatio, fmtVnd, PLATFORM_LABEL, TYPE_LABEL, useApi, vnDate } from '@/lib/client';
import { Badge, Button, Card, Empty, ErrorNote, Input, Notice, PageHeader, Select, Spinner, Stat, Table, Tabs, Td, useAction, useUi } from '@/components/ui';
import { ATTRIBUTION_LABEL, DataEntry, SOURCE_LABEL, type Snapshot } from '@/components/analytics/data-entry';

type Totals = { views: number; reach: number; likes: number; comments: number; shares: number; saves: number; leads: number; orders: number; revenue: number; gross_profit: number; ad_spend: number; ai_cost: number };
type Summary = {
  totals: Totals; followers: number; snapshots: number; ai_cost_usd: number; usd_to_vnd: number; pricing_verified?: boolean;
  metrics: { lead_conversion_rate: number | null; sales_conversion_rate: number | null; cpl: number | null; cost_per_order: number | null; cac: number | null; roas: number | null; marketing_roi: number | null; profit_after_marketing: number; marketing_cost: number };
};
type Group = { label: string; views: number; reach: number; likes: number; comments: number; shares: number; saves: number; leads: number; orders: number; revenue: number; gross_profit: number; ad_spend: number; engagement_rate: number | null };
type Top = { id: string; title: string; platform: string; pillar: string | null; views: number; reach: number; leads: number; orders: number; revenue: number; engagement_rate: number | null };
type Brand = { pillars: { name: string }[] };
type Ch = { id: string; name: string };
type Wf = { key: string; implemented: boolean };

const daysAgo = (n: number) => vnDate(new Date(Date.now() - n * 86400000));
const ratio = (num: number, den: number) => (den > 0 ? num / den : null);
const er = (t: Pick<Totals, 'likes' | 'comments' | 'shares' | 'saves'>, den: number) => { const r = ratio(t.likes + t.comments + t.shares + t.saves, den); return r == null ? null : r * 100; };

type Dim = 'pillar' | 'platform' | 'content_type' | 'channel' | 'hook' | 'top';
const DIM_TABS: { id: Dim; label: string }[] = [{ id: 'pillar', label: 'Chủ đề' }, { id: 'platform', label: 'Nền tảng' }, { id: 'content_type', label: 'Định dạng' }, { id: 'channel', label: 'Kênh' }, { id: 'hook', label: 'Hook' }, { id: 'top', label: 'Top nội dung' }];
const TREND_METRICS: Record<string, string> = { views: 'Views', reach: 'Reach', likes: 'Like', leads: 'Lead', orders: 'Đơn', revenue: 'Doanh thu (VND)' };

type StatP = React.ComponentProps<typeof Stat>;
function KStat({ tip, hint, ...p }: StatP & { tip: string }) { return <Stat {...p} hint={<>{hint}{hint ? ' ' : ''}<Tip text={tip} /></>} />; }
function Tip({ text }: { text: string }) { return <span title={text} className="cursor-help underline decoration-dotted">{'ⓘ'}</span>; }

export default function AnalyticsPage() {
  const router = useRouter();
  const { confirm } = useUi();
  const { busy, run } = useAction();
  const [from, setFrom] = useState(() => daysAgo(29));
  const [to, setTo] = useState(() => vnDate());
  const [platform, setPlatform] = useState('');
  const [channel, setChannel] = useState('');
  const [pillar, setPillar] = useState('');
  const [ctype, setCtype] = useState('');
  const [base, setBase] = useState<'views' | 'reach'>('views');
  const [dim, setDim] = useState<Dim>('pillar');
  const [metric, setMetric] = useState('views');

  const qs = useMemo(() => {
    const p = new URLSearchParams({ from, to });
    if (platform) p.set('platform', platform);
    if (channel) p.set('channel_id', channel);
    if (pillar) p.set('pillar', pillar);
    if (ctype) p.set('content_type', ctype);
    return p.toString();
  }, [from, to, platform, channel, pillar, ctype]);
  const rangeOk = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

  const sum = useApi<Summary>(rangeOk ? `/analytics/summary?${qs}` : null);
  const trend = useApi<{ items: (Group)[] }>(rangeOk ? `/analytics/groups?dim=date&${qs}` : null);
  const grp = useApi<{ items: Group[] }>(rangeOk && dim !== 'top' ? `/analytics/groups?dim=${dim}&${qs}` : null);
  const top = useApi<{ items: Top[] }>(rangeOk && dim === 'top' ? `/analytics/top?${qs}` : null);
  const snaps = useApi<{ items: Snapshot[] }>('/analytics/snapshots');
  const { data: brands } = useApi<{ items: Brand[] }>('/brands');
  const { data: chs } = useApi<{ items: Ch[] }>('/channels');
  const { data: wfs } = useApi<{ items: Wf[] }>('/workflows');
  const { data: me } = useApi<{ role: string }>('/auth/me');
  const canWrite = me ? me.role !== 'viewer' : false;

  const reloadAll = () => { sum.reload(); trend.reload(); grp.reload(); top.reload(); snaps.reload(); };
  const pillarNames = Array.from(new Set(brands?.items.flatMap((b) => b.pillars.map((p) => p.name)) ?? []));
  const weeklyOk = wfs?.items.find((w) => w.key === 'weekly')?.implemented;

  const s = sum.data;
  const t = s?.totals;
  const m = s?.metrics;
  const empty = !!s && s.snapshots === 0;
  const den = t ? t[base] : 0;
  const baseLabel = base === 'views' ? 'Views' : 'Reach';
  const dash = (n: string) => (empty ? '—' : n);
  const vnd = (n: number | null | undefined) => (empty || n == null ? '—' : fmtVnd(Math.round(n)));
  const roiTone = m?.marketing_roi != null ? (m.marketing_roi >= 0 ? 'text-ok' : 'text-danger') : undefined;

  const snapItems = useMemo(() => snaps.data?.items ?? [], [snaps.data]);
  const bySource = useMemo(() => countBy(snapItems, (x) => x.data_source), [snapItems]);
  const byMethod = useMemo(() => countBy(snapItems, (x) => x.attribution_method), [snapItems]);

  const aiInsight = async () => {
    if (!(await confirm({ title: 'Chạy nhận định AI hàng tuần?', body: 'Workflow “weekly” sẽ chạy AI trên số liệu đã nhập và có thể phát sinh chi phí AI. Kết quả chỉ là nhận định tham khảo, dựa trên tương quan.', confirmLabel: 'Chạy' }))) return;
    const r = await run('ai', () => api<{ run_id: string }>('/workflows/weekly/run', { body: {} }));
    if (r?.run_id) router.push(`/agents?run=${r.run_id}`);
  };

  const trendData = (trend.data?.items ?? []).map((g) => ({ label: g.label, value: Number((g as unknown as Record<string, number>)[metric] ?? 0) }));
  const label = (g: string) => (dim === 'platform' ? PLATFORM_LABEL[g] ?? g : dim === 'content_type' ? TYPE_LABEL[g] ?? g : g);

  return (
    <div>
      <PageHeader title="Phân tích hiệu quả" desc="Chỉ gồm số liệu bạn đã nhập tay, import CSV hoặc (sau này) đồng bộ API. Chưa có số liệu thì hiển thị “—”, hệ thống không tự bịa."
        actions={<>
          <a href="/api/analytics/export.csv" className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 text-sm font-medium hover:bg-surface2"><Download className="h-4 w-4" />Xuất CSV</a>
          <Button variant="gold" busy={busy === 'ai'} disabled={!canWrite || weeklyOk === false} title={weeklyOk === false ? 'Workflow tuần chưa được triển khai' : undefined} onClick={aiInsight}><Sparkles className="h-4 w-4" />Nhận định AI</Button>
        </>} />

      <Notice tone="blue">Các chỉ số dưới đây chỉ cho thấy <strong>tương quan</strong> giữa nội dung và kết quả, không chứng minh nhân quả. Doanh thu ≠ lợi nhuận: ROI tính trên lợi nhuận gộp.</Notice>

      <div className="my-4 grid grid-cols-2 gap-2 lg:grid-cols-6">
        <Input type="date" aria-label="Từ ngày" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <Input type="date" aria-label="Đến ngày" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        <Select aria-label="Nền tảng" value={platform} onChange={(e) => setPlatform(e.target.value)}><option value="">Mọi nền tảng</option>{Object.entries(PLATFORM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select aria-label="Kênh" value={channel} onChange={(e) => setChannel(e.target.value)}><option value="">Mọi kênh</option>{chs?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Select aria-label="Nhóm chủ đề" value={pillar} onChange={(e) => setPillar(e.target.value)}><option value="">Mọi chủ đề</option>{pillarNames.map((n) => <option key={n}>{n}</option>)}</Select>
        <Select aria-label="Định dạng" value={ctype} onChange={(e) => setCtype(e.target.value)}><option value="">Mọi định dạng</option>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
      </div>
      {!rangeOk && <Notice tone="red">Khoảng ngày không hợp lệ (cần Từ ngày ≤ Đến ngày).</Notice>}
      <p className="mb-3 text-xs text-muted">Bộ lọc chủ đề/định dạng chỉ áp dụng cho số liệu đã gắn với nội dung cụ thể. Chi phí AI luôn tính theo toàn bộ khoảng ngày (không lọc theo nền tảng/kênh/chủ đề).</p>

      <ErrorNote message={sum.error} />
      {sum.loading && !s && <Spinner />}
      {empty && <div className="mb-3"><Notice tone="amber">Chưa có số liệu trong khoảng/bộ lọc này. Hãy nhập tay hoặc import CSV ở phần “Nhập dữ liệu” bên dưới.</Notice></div>}

      {s && t && m && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm"><span className="text-muted">Mẫu số Engagement rate:</span>
            <Select aria-label="Mẫu số engagement" className="w-auto" value={base} onChange={(e) => setBase(e.target.value as 'views' | 'reach')}><option value="views">Views</option><option value="reach">Reach</option></Select>
            <Badge>{s.snapshots} bản ghi</Badge>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Views" value={dash(fmtNum(t.views))} />
            <Stat label="Reach" value={dash(fmtNum(t.reach))} />
            <Stat label="Tương tác" value={dash(fmtNum(t.likes + t.comments + t.shares + t.saves))} hint={`${fmtNum(t.likes)} like · ${fmtNum(t.comments)} cmt · ${fmtNum(t.shares)} share · ${fmtNum(t.saves)} save`} />
            <KStat label="Engagement rate" tip={`(like+comment+share+save) / ${baseLabel} × 100`} value={empty ? '—' : fmtPct(er(t, den))} hint={`Mẫu số: ${baseLabel}`} />
            <KStat label="Lead conversion" tip="Lead / Views × 100" value={empty ? '—' : fmtPct(m.lead_conversion_rate)} hint="Lead/Views" />
            <Stat label="Lead" value={dash(fmtNum(t.leads))} />
            <Stat label="Đơn hàng" value={dash(fmtNum(t.orders))} />
            <KStat label="Sales conversion" tip="Đơn / Lead đủ điều kiện × 100. Số liệu hiện chưa tách lead đủ điều kiện nên dùng tổng Lead làm mẫu số." value={empty ? '—' : fmtPct(m.sales_conversion_rate)} hint="Đơn/Lead (chưa tách lead đủ điều kiện)" />
            <Stat label="Doanh thu quy thuộc" value={vnd(t.revenue)} hint="Theo phương pháp ghi ở từng bản ghi" />
            <Stat label="Lợi nhuận gộp" value={vnd(t.gross_profit)} hint="Khác doanh thu" />
            <Stat label="Chi phí quảng cáo" value={vnd(t.ad_spend)} />
            <Stat label="Chi phí AI (quy đổi VND)" value={fmtVnd(Math.round(t.ai_cost))} hint={`$${s.ai_cost_usd.toFixed(4)} × ${fmtNum(s.usd_to_vnd)}${s.pricing_verified === false ? ' · giá chưa xác minh' : ''}`} />
            <KStat label="Chi phí MKT" tip="Chi phí MKT = chi phí quảng cáo + chi phí AI (đã quy đổi VND)" value={fmtVnd(Math.round(m.marketing_cost))} />
            <KStat label="CPL" tip="CPL = Chi phí MKT / Lead" value={vnd(m.cpl)} />
            <KStat label="Chi phí / đơn" tip="Chi phí MKT / Đơn" value={vnd(m.cost_per_order)} />
            <KStat label="CAC" tip="CAC = Chi phí MKT / Khách hàng mới. Chưa có số khách mới riêng nên dùng số đơn thay thế." value={vnd(m.cac)} hint="Dùng số đơn thay khách mới" />
            <KStat label="ROAS" tip="ROAS = Doanh thu quy thuộc QC / Chi phí QC. Hiện dùng toàn bộ doanh thu trong bộ lọc nên có thể cao hơn thực tế." value={empty ? '—' : fmtRatio(m.roas)} hint="Doanh thu/Chi phí QC" />
            <KStat label="Marketing ROI" tip="(Lợi nhuận gộp quy thuộc − Chi phí MKT) / Chi phí MKT × 100" value={empty ? '—' : fmtPct(m.marketing_roi)} tone={roiTone} />
            <Stat label="Lợi nhuận sau MKT" value={vnd(m.profit_after_marketing)} hint="Lợi nhuận gộp − Chi phí MKT" tone={!empty && m.profit_after_marketing < 0 ? 'text-danger' : undefined} />
          </div>
        </div>
      )}

      <Card className="mt-4" title="Công thức">
        <ul className="grid gap-1 text-xs text-muted sm:grid-cols-2">
          <li>Engagement rate = (like + comment + share + save) / Views (hoặc Reach) × 100</li>
          <li>Lead conversion = Lead / Views × 100</li>
          <li>Sales conversion = Đơn / Lead đủ điều kiện × 100</li>
          <li>CPL = Chi phí MKT / Lead</li>
          <li>CAC = Chi phí MKT / Khách hàng mới</li>
          <li>ROAS = Doanh thu quy thuộc QC / Chi phí QC</li>
          <li>Marketing ROI = (Lợi nhuận gộp quy thuộc − Chi phí MKT) / Chi phí MKT × 100</li>
          <li>Chi phí MKT = Chi phí quảng cáo + Chi phí AI (đã quy đổi VND). Mẫu số bằng 0 → “—”.</li>
        </ul>
      </Card>

      <Card className="mt-4" title="Xu hướng theo ngày" actions={<Select aria-label="Chỉ số biểu đồ" className="h-8 w-auto text-xs" value={metric} onChange={(e) => setMetric(e.target.value)}>{Object.entries(TREND_METRICS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}>
        <ErrorNote message={trend.error} />
        {trend.loading && !trend.data && <Spinner />}
        {trend.data && (trendData.length ? (
          <div className="h-60"><ResponsiveContainer width="100%" height="100%"><LineChart data={trendData}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="label" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} width={52} /><Tooltip /><Line type="monotone" dataKey="value" name={TREND_METRICS[metric]} stroke="var(--brand)" strokeWidth={2} dot={trendData.length < 40} /></LineChart></ResponsiveContainer></div>
        ) : <Empty title="Chưa có dữ liệu để vẽ biểu đồ" />)}
      </Card>

      <Card className="mt-4" title="Báo cáo xếp hạng">
        <div className="space-y-3">
          <Tabs tabs={DIM_TABS} value={dim} onChange={setDim} />
          <ErrorNote message={dim === 'top' ? top.error : grp.error} />
          {(dim === 'top' ? top.loading && !top.data : grp.loading && !grp.data) && <Spinner />}
          {dim !== 'top' && grp.data && (grp.data.items.length ? (
            <Table head={[DIM_TABS.find((x) => x.id === dim)?.label ?? '', 'Views', 'Reach', `Engagement (/${baseLabel})`, 'Lead', 'Đơn', 'Doanh thu', 'Lợi nhuận gộp', 'Chi phí QC']}>
              {grp.data.items.map((g) => (
                <tr key={g.label}><Td className="max-w-64 break-words font-medium">{label(g.label)}</Td><Td className="tabular-nums">{fmtNum(g.views)}</Td><Td className="tabular-nums">{fmtNum(g.reach)}</Td><Td className="tabular-nums">{fmtPct(er(g, g[base]))}</Td><Td className="tabular-nums">{fmtNum(g.leads)}</Td><Td className="tabular-nums">{fmtNum(g.orders)}</Td><Td className="tabular-nums">{fmtVnd(g.revenue)}</Td><Td className="tabular-nums">{fmtVnd(g.gross_profit)}</Td><Td className="tabular-nums">{fmtVnd(g.ad_spend)}</Td></tr>
              ))}
            </Table>
          ) : <Empty title="Chưa có dữ liệu" />)}
          {dim === 'top' && top.data && (top.data.items.length ? (
            <Table head={['#', 'Nội dung', 'Nền tảng', 'Views', 'Engagement (/Views)', 'Lead', 'Đơn', 'Doanh thu']}>
              {top.data.items.map((c, i) => (
                <tr key={c.id}><Td>{i + 1}</Td><Td className="max-w-72"><Link href={`/content/${c.id}`} className="font-medium text-brand hover:underline">{c.title}</Link>{c.pillar && <p className="text-xs text-muted">{c.pillar}</p>}</Td><Td>{PLATFORM_LABEL[c.platform] ?? c.platform}</Td><Td className="tabular-nums">{fmtNum(c.views)}</Td><Td className="tabular-nums">{fmtPct(c.engagement_rate)}</Td><Td className="tabular-nums">{fmtNum(c.leads)}</Td><Td className="tabular-nums">{fmtNum(c.orders)}</Td><Td className="tabular-nums">{fmtVnd(c.revenue)}</Td></tr>
              ))}
            </Table>
          ) : <Empty title="Chưa có nội dung nào có số liệu" hint="Chỉ bản ghi gắn với một nội dung cụ thể mới được xếp hạng." />)}
        </div>
      </Card>

      <Card className="mt-4" title="Nhập dữ liệu">
        <DataEntry snapshots={snapItems} loading={snaps.loading} error={snaps.error} canWrite={canWrite} onChanged={reloadAll} />
      </Card>

      <Card className="mt-4" title="Nguồn dữ liệu & phương pháp quy thuộc">
        <div className="grid gap-4 sm:grid-cols-2">
          <div><p className="mb-1 text-xs font-medium text-muted">Nguồn dữ liệu (data_source)</p>{bySource.length ? <ul className="space-y-1 text-sm">{bySource.map(([k, n]) => <li key={k} className="flex justify-between"><span>{SOURCE_LABEL[k] ?? k}</span><span className="tabular-nums text-muted">{n} bản ghi</span></li>)}</ul> : <p className="text-sm text-muted">—</p>}</div>
          <div><p className="mb-1 text-xs font-medium text-muted">Phương pháp quy thuộc doanh thu</p>{byMethod.length ? <ul className="space-y-1 text-sm">{byMethod.map(([k, n]) => <li key={k} className="flex justify-between"><span>{ATTRIBUTION_LABEL[k] ?? k}</span><span className="tabular-nums text-muted">{n} bản ghi</span></li>)}</ul> : <p className="text-sm text-muted">—</p>}</div>
        </div>
        <p className="mt-3 text-xs text-muted">Thống kê trên tối đa 300 bản ghi gần nhất (không phụ thuộc bộ lọc). Chưa có kết nối API nền tảng nên không có nguồn “API”. Các con số chỉ cho thấy tương quan; một đơn hàng có thể chịu ảnh hưởng của nhiều nội dung/kênh, phương pháp quy thuộc chỉ là quy ước.</p>
      </Card>
    </div>
  );
}

function countBy<T>(arr: T[], key: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const x of arr) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
}

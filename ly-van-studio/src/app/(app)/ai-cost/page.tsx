'use client';
import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, fmtDateTime, fmtNum, fmtUsd, fmtVnd, useApi } from '@/lib/client';
import { Badge, Button, Card, DemoBadge, Empty, ErrorNote, Field, Input, Notice, PageHeader, Spinner, Stat, Table, Td, useAction } from '@/components/ui';

type Log = { id: string; provider: string; model: string; agent_key: string | null; task: string | null; input_tokens: number; output_tokens: number; est_cost_usd: number | string; status: string; error: string | null; cache_hit: boolean; is_demo: boolean; created_at: string };
type Budget = { scope: 'daily' | 'monthly'; limit: number | string; spent: number | string; pct: number | string; warn: boolean; exceeded: boolean; hard_stop: boolean };
type PriceRow = { provider: string; model: string; input_per_m: number; output_per_m: number };
type Pricing = { updated_at: string; verified: boolean; usd_to_vnd: number; rows: PriceRow[] };
type Usage = {
  items: Log[]; by_model: { provider: string; model: string; calls: string | number; input_tokens: string | number | null; output_tokens: string | number | null; cost: string | number | null; cache_hits: string | number }[];
  by_agent: { agent: string; calls: string | number; cost: string | number | null }[]; by_day: { day: string; cost: string | number | null; calls: string | number }[]; budgets: Budget[]; pricing: Pricing; pricing_default: string;
};
type Me = { role: 'owner' | 'admin' | 'editor' | 'viewer' };
const n = (v: unknown) => Number(v ?? 0) || 0;
const SCOPE = { daily: 'Ngày', monthly: 'Tháng' } as const;

function BudgetForm({ budgets, canAdmin, onSaved }: { budgets: Budget[]; canAdmin: boolean; onSaved: () => Promise<void> }) {
  const init = (s: 'daily' | 'monthly') => { const b = budgets.find((x) => x.scope === s); return { amount: String(n(b?.limit)), warn: '80', hard: b?.hard_stop ?? true }; };
  const [f, setF] = useState({ daily: init('daily'), monthly: init('monthly') });
  const { busy, run } = useAction();
  const valid = (['daily', 'monthly'] as const).every((s) => Number(f[s].amount) >= 0 && f[s].amount !== '' && Number(f[s].warn) >= 1 && Number(f[s].warn) <= 100);
  const save = () => run('b', async () => {
    const body = Object.fromEntries((['daily', 'monthly'] as const).map((s) => [s, { amount_usd: Number(f[s].amount), warn_pct: Math.round(Number(f[s].warn)), hard_stop: f[s].hard }]));
    await api('/budgets', { method: 'PUT', body }); await onSaved();
  }, 'Đã lưu ngân sách');
  return (
    <Card title="Ngân sách AI">
      <div className="grid gap-4 sm:grid-cols-2">
        {(['daily', 'monthly'] as const).map((s) => {
          const b = budgets.find((x) => x.scope === s); const pct = n(b?.pct);
          return (
            <div key={s} className="space-y-2 rounded-lg border border-line p-3">
              <div className="flex items-center justify-between text-sm"><b>Ngân sách {SCOPE[s]}</b>{b?.exceeded ? <Badge tone="red">Vượt ngân sách</Badge> : b?.warn ? <Badge tone="amber">Sắp chạm</Badge> : <Badge tone="green">Trong hạn mức</Badge>}</div>
              <div className="h-2 overflow-hidden rounded-full bg-surface2"><div className={`h-full ${b?.exceeded ? 'bg-danger' : b?.warn ? 'bg-warn' : 'bg-ok'}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>
              <p className="text-xs text-muted">Đã dùng {fmtUsd(n(b?.spent))} / {fmtUsd(n(b?.limit), 2)} ({pct.toFixed(1)}%)</p>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Hạn mức (USD)"><Input type="number" min={0} step="0.5" value={f[s].amount} disabled={!canAdmin} onChange={(e) => setF({ ...f, [s]: { ...f[s], amount: e.target.value } })} /></Field>
                <Field label="Cảnh báo ở (%)"><Input type="number" min={1} max={100} value={f[s].warn} disabled={!canAdmin} onChange={(e) => setF({ ...f, [s]: { ...f[s], warn: e.target.value } })} /></Field>
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={f[s].hard} disabled={!canAdmin} onChange={(e) => setF({ ...f, [s]: { ...f[s], hard: e.target.checked } })} />Dừng cứng khi vượt (chặn mọi lời gọi AI)</label>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted">Lưu ý: API chưa trả về ngưỡng cảnh báo hiện tại nên ô “Cảnh báo ở” mặc định 80% và sẽ ghi đè khi lưu.</p>
      {canAdmin ? <div className="mt-3"><Button variant="primary" disabled={!valid} busy={busy === 'b'} onClick={save}>Lưu ngân sách</Button></div> : <p className="mt-2 text-xs text-muted">Chỉ admin/owner được đổi ngân sách.</p>}
    </Card>
  );
}

function PricingForm({ pricing, canAdmin, onSaved }: { pricing: Pricing; canAdmin: boolean; onSaved: () => Promise<void> }) {
  const [rows, setRows] = useState<{ provider: string; model: string; input: string; output: string }[]>(() => pricing.rows.map((r) => ({ provider: r.provider, model: r.model, input: String(r.input_per_m), output: String(r.output_per_m) })));
  const [fx, setFx] = useState(String(pricing.usd_to_vnd));
  const { busy, run } = useAction();
  const upd = (i: number, p: Partial<(typeof rows)[number]>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const valid = Number(fx) >= 1000 && Number(fx) <= 100000 && rows.every((r) => r.provider.trim() && r.model.trim() && r.input !== '' && r.output !== '' && Number(r.input) >= 0 && Number(r.output) >= 0);
  const save = () => run('p', async () => {
    await api('/settings/pricing', { method: 'PUT', body: { usd_to_vnd: Number(fx), rows: rows.map((r) => ({ provider: r.provider.trim(), model: r.model.trim(), input_per_m: Number(r.input), output_per_m: Number(r.output) })) } });
    await onSaved();
  }, 'Đã lưu bảng giá');
  return (
    <Card title="Bảng giá model (USD / 1 triệu token)" actions={<><Badge tone={pricing.verified ? 'green' : 'amber'}>{pricing.verified ? 'Đã được người dùng xác nhận' : 'Chưa xác minh'}</Badge><Badge>Cập nhật {pricing.updated_at}</Badge></>}>
      <div className="mb-3"><Notice tone="amber">Giá mặc định chỉ là <b>ước tính ban đầu</b>, không phải giá chính thức. Hãy đối chiếu với bảng giá của nhà cung cấp và cập nhật. Chi phí hiển thị trong trang này là <b>ước tính</b> theo bảng giá này, không phải hoá đơn thật.</Notice></div>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-line p-2 sm:grid-cols-[110px_1fr_110px_110px_auto]">
            <Input aria-label="Provider" value={r.provider} disabled={!canAdmin} onChange={(e) => upd(i, { provider: e.target.value })} placeholder="provider" />
            <Input aria-label="Model" value={r.model} disabled={!canAdmin} onChange={(e) => upd(i, { model: e.target.value })} placeholder="model" />
            <Input aria-label="Giá input" type="number" min={0} step="0.01" value={r.input} disabled={!canAdmin} onChange={(e) => upd(i, { input: e.target.value })} placeholder="input $/M" />
            <Input aria-label="Giá output" type="number" min={0} step="0.01" value={r.output} disabled={!canAdmin} onChange={(e) => upd(i, { output: e.target.value })} placeholder="output $/M" />
            {canAdmin && <Button variant="ghost" aria-label="Xoá dòng" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>}
          </div>
        ))}
        {rows.length === 0 && <Empty title="Chưa có dòng giá" hint="Không có giá thì chi phí ước tính sẽ là 0." />}
      </div>
      <div className="mt-3 max-w-xs"><Field label="Tỷ giá USD → VND" hint="Chỉ dùng để quy đổi hiển thị."><Input type="number" min={1000} value={fx} disabled={!canAdmin} onChange={(e) => setFx(e.target.value)} /></Field></div>
      {canAdmin ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => setRows((r) => [...r, { provider: '', model: '', input: '0', output: '0' }])}><Plus className="h-4 w-4" />Thêm dòng</Button>
          <Button variant="primary" disabled={!valid} busy={busy === 'p'} onClick={save}>Lưu bảng giá (đánh dấu đã xác nhận)</Button>
        </div>
      ) : <p className="mt-2 text-xs text-muted">Chỉ admin/owner được sửa bảng giá.</p>}
    </Card>
  );
}

export default function AiCostPage() {
  const { data: me } = useApi<Me>('/auth/me');
  const canAdmin = me?.role === 'owner' || me?.role === 'admin';
  const { data, error, loading, reload } = useApi<Usage>('/ai/usage');
  const stat = useMemo(() => {
    if (!data) return null;
    const calls = data.by_model.reduce((s, r) => s + n(r.calls), 0);
    const hits = data.by_model.reduce((s, r) => s + n(r.cache_hits), 0);
    return { calls, hits, day: data.budgets.find((b) => b.scope === 'daily'), month: data.budgets.find((b) => b.scope === 'monthly') };
  }, [data]);
  const chart = useMemo(() => (data?.by_day ?? []).map((d) => ({ day: d.day.slice(5), cost: n(d.cost) })), [data]);
  const fx = data?.pricing.usd_to_vnd;

  return (
    <div>
      <PageHeader title="Quản lý chi phí AI" desc="Chi phí là ước tính từ số token × bảng giá bạn cấu hình (không phải hoá đơn). Lời gọi ở chế độ demo có chi phí 0." />
      {loading && !data && <Spinner />}<ErrorNote message={error} />
      {data && stat && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Chi phí hôm nay (ước tính)" value={fmtUsd(n(stat.day?.spent))} hint={fx ? fmtVnd(n(stat.day?.spent) * fx) : undefined} />
            <Stat label="Chi phí tháng này (ước tính)" value={fmtUsd(n(stat.month?.spent))} hint={fx ? fmtVnd(n(stat.month?.spent) * fx) : undefined} />
            <Stat label="Số lần gọi AI (tổng)" value={fmtNum(stat.calls)} />
            <Stat label="Cache hit" value={stat.calls ? `${((stat.hits / stat.calls) * 100).toFixed(0)}%` : '—'} hint={`${fmtNum(stat.hits)} lần`} />
          </div>
          {(stat.day?.exceeded || stat.month?.exceeded) && <Notice tone="red">Đã vượt ngân sách {stat.day?.exceeded ? 'ngày' : 'tháng'}{(stat.day?.exceeded ? stat.day : stat.month)?.hard_stop ? ' — các lời gọi AI đang bị chặn.' : '.'}</Notice>}
          {!stat.day?.exceeded && !stat.month?.exceeded && (stat.day?.warn || stat.month?.warn) && <Notice tone="amber">Sắp chạm ngân sách {stat.day?.warn ? 'ngày' : 'tháng'}.</Notice>}
          <Card title="Chi phí theo ngày (30 ngày, USD ước tính)">
            {chart.length === 0 ? <Empty title="Chưa có lời gọi AI nào" hint="Chi phí sẽ hiện sau khi có lần chạy agent." /> : (
              <div className="h-60"><ResponsiveContainer width="100%" height="100%"><BarChart data={chart}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="day" fontSize={11} /><YAxis fontSize={11} width={48} /><Tooltip formatter={(v) => fmtUsd(Number(v))} /><Bar dataKey="cost" name="Chi phí" fill="var(--brand)" /></BarChart></ResponsiveContainer></div>
            )}
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Theo model">
              <Table head={['Provider / model', 'Lần gọi', 'Input', 'Output', 'Chi phí']} empty={data.by_model.length === 0 ? <div className="p-3"><Empty title="Chưa có dữ liệu" /></div> : undefined}>
                {data.by_model.map((r) => <tr key={r.provider + r.model}><Td>{r.provider}/{r.model}</Td><Td className="tabular-nums">{fmtNum(n(r.calls))}</Td><Td className="tabular-nums">{fmtNum(n(r.input_tokens))}</Td><Td className="tabular-nums">{fmtNum(n(r.output_tokens))}</Td><Td className="tabular-nums">{fmtUsd(n(r.cost))}</Td></tr>)}
              </Table>
            </Card>
            <Card title="Theo agent">
              <Table head={['Agent', 'Lần gọi', 'Chi phí']} empty={data.by_agent.length === 0 ? <div className="p-3"><Empty title="Chưa có dữ liệu" /></div> : undefined}>
                {data.by_agent.map((r) => <tr key={r.agent}><Td>{r.agent === '-' ? '(không gắn agent)' : r.agent}</Td><Td className="tabular-nums">{fmtNum(n(r.calls))}</Td><Td className="tabular-nums">{fmtUsd(n(r.cost))}</Td></tr>)}
              </Table>
            </Card>
          </div>
          <Card title="Nhật ký gọi AI (200 lần gần nhất)">
            <Table head={['Thời gian', 'Provider / model', 'Agent', 'Input', 'Output', 'Chi phí ước tính', 'Trạng thái', 'Ghi chú']} empty={data.items.length === 0 ? <div className="p-3"><Empty title="Chưa có nhật ký" /></div> : undefined}>
              {data.items.map((l) => (
                <tr key={l.id}>
                  <Td className="whitespace-nowrap text-xs">{fmtDateTime(l.created_at)}</Td><Td className="text-xs">{l.provider}/{l.model}</Td><Td className="text-xs">{l.agent_key ?? '—'}</Td>
                  <Td className="tabular-nums">{fmtNum(l.input_tokens)}</Td><Td className="tabular-nums">{fmtNum(l.output_tokens)}</Td><Td className="tabular-nums">{fmtUsd(n(l.est_cost_usd))}</Td>
                  <Td><Badge tone={l.status === 'ok' || l.status === 'success' ? 'green' : 'red'}>{l.status}</Badge></Td>
                  <Td><DemoBadge show={l.is_demo} /> {l.cache_hit && <Badge tone="teal">Cache</Badge>} {l.error && <span className="text-xs text-danger">{l.error}</span>}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          <BudgetForm key={data.budgets.map((b) => `${b.scope}${b.limit}${b.hard_stop}`).join()} budgets={data.budgets} canAdmin={canAdmin} onSaved={reload} />
          <PricingForm key={data.pricing.updated_at + data.pricing.usd_to_vnd + data.pricing.rows.length} pricing={data.pricing} canAdmin={canAdmin} onSaved={reload} />
        </div>
      )}
    </div>
  );
}

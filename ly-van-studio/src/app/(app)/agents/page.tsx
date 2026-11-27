'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Play } from 'lucide-react';
import { api, fmtDateTime, fmtNum, useApi } from '@/lib/client';
import { Badge, Button, Card, DemoBadge, Empty, ErrorNote, Field, Input, Notice, PageHeader, Spinner, Table, Tabs, Td, Textarea, useAction, useUi } from '@/components/ui';
import { RunProgress } from '@/components/run-progress';

type Agent = { key: string; name: string; enabled: boolean; provider: string | null; model: string | null; stats: { runs: number | string; failed: number | string; last_run: string; avg_ms: number | null } | null };
type AgentRun = { id: string; agent_key: string; task: string; status: string; provider: string | null; model: string | null; cache_hit: boolean; is_demo: boolean; error: string | null; duration_ms: number | null; created_at: string };
type AgentsData = { agents: Agent[]; runs: AgentRun[] };
type PromptVersion = { version: number; active: boolean; system_prompt: string; notes: string; created_at: string };
type Prompt = { id: string; agent_key: string; name: string; description: string; versions: PromptVersion[] | null };
type Me = { role: 'owner' | 'admin' | 'editor' | 'viewer' };

const RUN_STATUS: Record<string, { label: string; tone: string }> = {
  succeeded: { label: 'Thành công', tone: 'green' }, success: { label: 'Thành công', tone: 'green' }, failed: { label: 'Thất bại', tone: 'red' }, running: { label: 'Đang chạy', tone: 'blue' }, cached: { label: 'Từ cache', tone: 'teal' },
};

function Inner() {
  const sp = useSearchParams();
  const runParam = sp.get('run');
  const { data: me } = useApi<Me>('/auth/me');
  const canAdmin = me?.role === 'owner' || me?.role === 'admin';
  const canRun = !!me && me.role !== 'viewer';
  const agents = useApi<AgentsData>('/agents');
  const prompts = useApi<{ items: Prompt[] }>('/prompts');
  const [tab, setTab] = useState<'agents' | 'runs' | 'prompt'>('agents');
  const [runId, setRunId] = useState<string | null>(runParam);
  const { busy, run } = useAction();
  const { toast } = useUi();
  useEffect(() => { if (runParam) setRunId(runParam); }, [runParam]);

  const start = () => run('daily', async () => {
    const r = await api<{ run_id: string }>('/workflows/daily/run', { body: {} });
    setRunId(r.run_id);
  });
  const toggle = (a: Agent) => run('t' + a.key, async () => {
    await api(`/agents/${a.key}`, { method: 'PUT', body: { enabled: !a.enabled, provider: a.provider, model: a.model } });
    await agents.reload();
    toast(`${a.name}: đã ${a.enabled ? 'tắt' : 'bật'}`);
  });

  return (
    <div>
      <PageHeader title="AI Agent Center" desc="12 agent phối hợp trong Daily Agent. Kết quả sinh ở chế độ demo luôn được gắn nhãn DEMO; điểm AI chỉ là ước tính."
        actions={canRun ? <Button variant="gold" size="lg" busy={busy === 'daily'} onClick={start}><Play className="h-5 w-5" />Chạy Daily Agent</Button> : undefined} />
      {runId && (
        <Card title="Tiến độ lần chạy" className="mb-4" actions={<Button size="sm" variant="ghost" onClick={() => setRunId(null)}>Ẩn</Button>}>
          <RunProgress runId={runId} onDone={() => { agents.reload(); }} />
        </Card>
      )}
      <Tabs tabs={[{ id: 'agents', label: 'Danh sách agent' }, { id: 'runs', label: 'Lần chạy gần đây' }, { id: 'prompt', label: 'Prompt' }]} value={tab} onChange={setTab} />
      <div className="mt-4">
        {tab !== 'prompt' && agents.loading && !agents.data && <Spinner />}
        {tab !== 'prompt' && <ErrorNote message={agents.error} />}
        {tab === 'agents' && agents.data && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {agents.data.agents.map((a) => {
              const runs = Number(a.stats?.runs ?? 0); const failed = Number(a.stats?.failed ?? 0);
              return (
                <Card key={a.key} title={a.name} actions={<Badge tone={a.enabled ? 'green' : 'gray'}>{a.enabled ? 'Đang bật' : 'Đã tắt'}</Badge>}>
                  <dl className="grid grid-cols-2 gap-y-1 text-sm">
                    <dt className="text-muted">Số lần chạy</dt><dd className="text-right tabular-nums">{a.stats ? fmtNum(runs) : '—'}</dd>
                    <dt className="text-muted">Thất bại</dt><dd className="text-right tabular-nums">{a.stats ? fmtNum(failed) : '—'}</dd>
                    <dt className="text-muted">Thời gian TB</dt><dd className="text-right tabular-nums">{a.stats?.avg_ms != null ? `${(Number(a.stats.avg_ms) / 1000).toFixed(1)}s` : '—'}</dd>
                    <dt className="text-muted">Lần cuối</dt><dd className="text-right text-xs">{a.stats ? fmtDateTime(a.stats.last_run) : 'Chưa chạy'}</dd>
                    <dt className="text-muted">Model riêng</dt><dd className="text-right text-xs">{a.provider ? `${a.provider}/${a.model ?? '—'}` : 'Theo cài đặt chung'}</dd>
                  </dl>
                  <div className="mt-3"><Button size="sm" disabled={!canAdmin} busy={busy === 't' + a.key} onClick={() => toggle(a)}>{a.enabled ? 'Tắt agent' : 'Bật agent'}</Button>
                    {!canAdmin && <span className="ml-2 text-xs text-muted">Chỉ admin được đổi</span>}</div>
                </Card>
              );
            })}
          </div>
        )}
        {tab === 'runs' && agents.data && (
          <Table head={['Thời gian', 'Agent', 'Tác vụ', 'Trạng thái', 'Provider / model', 'Cache', 'Thời lượng', 'Lỗi']}
            empty={agents.data.runs.length === 0 ? <div className="p-3"><Empty title="Chưa có lần chạy agent nào" hint="Bấm “Chạy Daily Agent” để bắt đầu." /></div> : undefined}>
            {agents.data.runs.map((r) => {
              const st = RUN_STATUS[r.status] ?? { label: r.status, tone: 'gray' };
              return (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap text-xs">{fmtDateTime(r.created_at)}</Td><Td>{r.agent_key}</Td><Td className="text-xs">{r.task}</Td>
                  <Td><Badge tone={st.tone}>{st.label}</Badge> <DemoBadge show={r.is_demo} /></Td>
                  <Td className="text-xs">{r.provider ? `${r.provider}/${r.model ?? '—'}` : '—'}</Td><Td>{r.cache_hit ? <Badge tone="teal">Cache</Badge> : '—'}</Td>
                  <Td className="tabular-nums">{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</Td><Td className="max-w-xs break-words text-xs text-danger">{r.error ?? ''}</Td>
                </tr>
              );
            })}
          </Table>
        )}
        {tab === 'prompt' && <PromptTab prompts={prompts} canAdmin={canAdmin} />}
      </div>
    </div>
  );
}

function PromptTab({ prompts, canAdmin }: { prompts: ReturnType<typeof useApi<{ items: Prompt[] }>>; canAdmin: boolean }) {
  const items = useMemo(() => prompts.data?.items ?? [], [prompts.data]);
  const [sel, setSel] = useState<string>('');
  const cur = items.find((p) => p.id === sel) ?? items[0];
  const versions = cur?.versions ?? [];
  const active = versions.find((v) => v.active) ?? versions[0];
  const [text, setText] = useState('');
  const [notes, setNotes] = useState('');
  const { busy, run } = useAction();
  const { confirm } = useUi();
  useEffect(() => { setText(active?.system_prompt ?? ''); setNotes(''); }, [cur?.id, active?.version, active?.system_prompt]);

  if (prompts.loading && !prompts.data) return <Spinner />;
  if (prompts.error) return <ErrorNote message={prompts.error} />;
  if (!cur) return <Empty title="Chưa có prompt nào" />;
  const dirty = text !== (active?.system_prompt ?? '');

  const save = async () => {
    if (!(await confirm({ title: 'Tạo phiên bản prompt mới?', body: 'Phiên bản mới sẽ được kích hoạt ngay cho các lần chạy sau. Phiên bản cũ vẫn được giữ để quay lại.', confirmLabel: 'Tạo & kích hoạt' }))) return;
    await run('save', async () => { await api(`/prompts/${cur.id}/versions`, { body: { system_prompt: text, notes, activate: true } }); await prompts.reload(); }, 'Đã tạo phiên bản mới');
  };
  const activate = async (v: number) => {
    if (!(await confirm({ title: `Kích hoạt phiên bản v${v}?`, confirmLabel: 'Kích hoạt' }))) return;
    await run('act' + v, async () => { await api(`/prompts/${cur.id}/activate`, { body: { version: v } }); await prompts.reload(); }, `Đã kích hoạt v${v}`);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <div className="space-y-1">
        {items.map((p) => (
          <button key={p.id} onClick={() => setSel(p.id)} className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${p.id === cur.id ? 'border-brand bg-brand/5' : 'border-line bg-surface hover:bg-surface2'}`}>
            <span className="block font-medium">{p.agent_key}</span><span className="block text-xs text-muted">{p.name} · {p.description}</span>
          </button>
        ))}
      </div>
      <div className="space-y-4">
        <Card title={`Prompt hệ thống · ${cur.agent_key}/${cur.name}`} actions={<Badge tone="blue">{active ? `Đang dùng v${active.version}` : 'Chưa có phiên bản'}</Badge>}>
          {!canAdmin && <div className="mb-3"><Notice tone="blue">Chế độ chỉ đọc: chỉ admin/owner được sửa prompt.</Notice></div>}
          <div className="space-y-3">
            <Field label="Nội dung prompt (tối thiểu 20 ký tự)"><Textarea className="min-h-64 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} readOnly={!canAdmin} /></Field>
            <Field label="Ghi chú phiên bản"><Input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} disabled={!canAdmin} placeholder="Ví dụ: thêm quy tắc về giọng văn" /></Field>
            {canAdmin && <Button variant="primary" disabled={!dirty || text.trim().length < 20} busy={busy === 'save'} onClick={save}>Lưu thành phiên bản mới</Button>}
          </div>
        </Card>
        <Card title="Lịch sử phiên bản">
          {versions.length === 0 ? <Empty title="Chưa có phiên bản" /> : (
            <ul className="divide-y divide-line">
              {versions.map((v) => (
                <li key={v.version} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <b>v{v.version}</b>{v.active && <Badge tone="green">Đang dùng</Badge>}
                  <span className="text-xs text-muted">{fmtDateTime(v.created_at)}</span><span className="min-w-0 flex-1 break-words text-xs">{v.notes}</span>
                  <Button size="sm" variant="ghost" onClick={() => setText(v.system_prompt)}>Nạp vào ô soạn</Button>
                  {canAdmin && !v.active && <Button size="sm" busy={busy === 'act' + v.version} onClick={() => activate(v.version)}>Kích hoạt</Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

export default function AgentsPage() { return <Suspense fallback={<Spinner />}><Inner /></Suspense>; }

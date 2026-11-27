'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, download, fmtDateTime, useApi } from '@/lib/client';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Notice, PageHeader, Select, Spinner, Table, Tabs, Td, useAction, useUi } from '@/components/ui';

type Pid = 'anthropic' | 'openai' | 'gemini';
const PIDS: Pid[] = ['anthropic', 'openai', 'gemini'];
const PNAME: Record<Pid, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', gemini: 'Google Gemini' };
type Role = 'owner' | 'admin' | 'editor' | 'viewer';
type Me = { user: { id: string; name: string; email: string }; workspaceId: string; role: Role; workspaces: { id: string; name: string; role: Role }[] };
type AiSettings = {
  settings: { primary: Pid; fallback: Pid[]; cache_ttl_hours: number; timeout_ms: number; task_models: Record<string, { provider: Pid; model: string }>; providers: Record<Pid, { enabled: boolean; model: string; key_source: 'workspace' | 'env' | 'none' }> };
  demo_forced: boolean; external: boolean;
};
const KEY_SRC = { workspace: 'Khoá của workspace (đã mã hoá)', env: 'Khoá từ biến môi trường máy chủ', none: 'Chưa có khoá' } as const;

function AiTab() {
  const { data, error, loading, reload } = useApi<AiSettings>('/settings/ai');
  const agents = useApi<{ agents: { key: string; name: string }[] }>('/agents');
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  return <AiForm key={JSON.stringify(data.settings)} d={data} agents={agents.data?.agents ?? []} reload={reload} />;
}

function AiForm({ d, agents, reload }: { d: AiSettings; agents: { key: string; name: string }[]; reload: () => Promise<void> }) {
  const s = d.settings;
  const [primary, setPrimary] = useState<Pid>(s.primary);
  const [fallback, setFallback] = useState<Pid[]>(s.fallback);
  const [timeout, setTimeoutMs] = useState(String(s.timeout_ms / 1000));
  const [ttl, setTtl] = useState(String(s.cache_ttl_hours));
  const [prov, setProv] = useState(() => Object.fromEntries(PIDS.map((p) => [p, { enabled: s.providers[p].enabled, model: s.providers[p].model, key: '' }])) as Record<Pid, { enabled: boolean; model: string; key: string }>);
  const [tm, setTm] = useState<Record<string, { provider: Pid; model: string }>>(s.task_models);
  const [tests, setTests] = useState<Partial<Record<Pid, string>>>({});
  const { busy, run } = useAction();
  const { confirm } = useUi();
  const keyBad = PIDS.some((p) => prov[p].key !== '' && prov[p].key.length < 8);
  const valid = !keyBad && PIDS.every((p) => prov[p].model.trim()) && Number(timeout) >= 5 && Number(timeout) <= 180 && Number.isInteger(Number(ttl)) && Number(ttl) >= 0 && Number(ttl) <= 720 && Object.values(tm).every((x) => x.model.trim());

  const body = (clear?: Pid) => ({
    primary, fallback: fallback.filter((p) => p !== primary), cache_ttl_hours: Number(ttl), timeout_ms: Math.round(Number(timeout) * 1000),
    providers: Object.fromEntries(PIDS.map((p) => [p, { enabled: prov[p].enabled, model: prov[p].model.trim(), ...(prov[p].key ? { api_key: prov[p].key } : {}), ...(clear === p ? { clear_key: true } : {}) }])),
    task_models: Object.fromEntries(Object.entries(tm).map(([k, v]) => [k, { provider: v.provider, model: v.model.trim() }])),
  });
  const save = () => run('save', async () => { await api('/settings/ai', { method: 'PUT', body: body() }); await reload(); }, 'Đã lưu cài đặt AI');
  const clearKey = async (p: Pid) => {
    if (!(await confirm({ title: `Xoá khoá API ${PNAME[p]}?`, body: 'Khoá lưu trong workspace sẽ bị xoá. Nếu không còn khoá nào khác, hệ thống chuyển về chế độ DEMO.', danger: true, confirmLabel: 'Xoá khoá' }))) return;
    await run('clr' + p, async () => { await api('/settings/ai', { method: 'PUT', body: body(p) }); await reload(); }, 'Đã xoá khoá');
  };
  const test = async (p: Pid) => {
    if (prov[p].key) { setTests((t) => ({ ...t, [p]: 'Hãy lưu khoá trước rồi mới kiểm tra (kiểm tra dùng khoá đã lưu).' })); return; }
    if (!(await confirm({ title: `Kiểm tra kết nối ${PNAME[p]}?`, body: 'Hệ thống gửi một lời gọi rất nhỏ tới nhà cung cấp, có thể phát sinh chi phí nhỏ và gửi một đoạn văn bản thử ra dịch vụ AI bên ngoài.', confirmLabel: 'Kiểm tra' }))) return;
    const r = await run('test' + p, () => api<Record<string, unknown>>('/settings/ai/test', { body: { provider: p } }));
    if (r) setTests((t) => ({ ...t, [p]: r.ok ? `Kết nối được. ${Object.entries(r).filter(([k]) => k !== 'ok').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}` : `Thất bại: ${String(r.error ?? 'không rõ lỗi')}` }));
  };

  return (
    <div className="space-y-4">
      {(d.demo_forced || !d.external) ? (
        <Notice tone="amber"><b>Đang ở chế độ DEMO.</b> {d.demo_forced ? 'AI_DEMO_MODE đang bật trên máy chủ nên không có lời gọi AI thật.' : 'Chưa có provider nào vừa được bật vừa có khoá API.'} Nội dung sinh ra là dữ liệu mẫu và được gắn nhãn DEMO.</Notice>
      ) : <Notice tone="green">Đang dùng AI thật (dữ liệu gửi tới nhà cung cấp bên ngoài). Các adapter chưa được kiểm thử với khoá thật — hãy dùng “Kiểm tra kết nối”.</Notice>}
      <Card title="Provider chính & dự phòng">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Provider chính"><Select value={primary} onChange={(e) => setPrimary(e.target.value as Pid)}>{PIDS.map((p) => <option key={p} value={p}>{PNAME[p]}</option>)}</Select></Field>
          <Field label="Dự phòng (theo thứ tự thử)">
            <div className="flex flex-wrap gap-3 pt-2">{PIDS.filter((p) => p !== primary).map((p) => (
              <label key={p} className="flex items-center gap-1.5 text-sm"><input type="checkbox" className="h-4 w-4" checked={fallback.includes(p)} onChange={(e) => setFallback((f) => (e.target.checked ? [...f, p] : f.filter((x) => x !== p)))} />{PNAME[p]}</label>
            ))}</div>
          </Field>
          <Field label="Timeout mỗi lời gọi (giây, 5–180)"><Input type="number" min={5} max={180} value={timeout} onChange={(e) => setTimeoutMs(e.target.value)} /></Field>
          <Field label="Cache TTL (giờ, 0 = tắt cache)"><Input type="number" min={0} max={720} value={ttl} onChange={(e) => setTtl(e.target.value)} /></Field>
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        {PIDS.map((p) => (
          <Card key={p} title={PNAME[p]} actions={<Badge tone={s.providers[p].key_source === 'none' ? 'amber' : 'green'}>{KEY_SRC[s.providers[p].key_source]}</Badge>}>
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={prov[p].enabled} onChange={(e) => setProv({ ...prov, [p]: { ...prov[p], enabled: e.target.checked } })} />Bật provider này</label>
              <Field label="Model"><Input value={prov[p].model} onChange={(e) => setProv({ ...prov, [p]: { ...prov[p], model: e.target.value } })} /></Field>
              <Field label="API key" hint="Khoá được mã hoá AES-256-GCM và không bao giờ hiển thị lại. Để trống nếu không đổi."><Input type="password" autoComplete="new-password" value={prov[p].key} placeholder={s.providers[p].key_source === 'none' ? 'Dán khoá API' : '•••••••• (đã có, nhập để thay)'} onChange={(e) => setProv({ ...prov, [p]: { ...prov[p], key: e.target.value } })} /></Field>
              {prov[p].key !== '' && prov[p].key.length < 8 && <p className="text-xs text-danger">Khoá quá ngắn (tối thiểu 8 ký tự).</p>}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" busy={busy === 'test' + p} onClick={() => test(p)}>Kiểm tra kết nối</Button>
                {s.providers[p].key_source === 'workspace' && <Button size="sm" variant="danger" busy={busy === 'clr' + p} onClick={() => clearKey(p)}>Xoá khoá</Button>}
              </div>
              {tests[p] && <p className="break-words text-xs text-muted" role="status">{tests[p]}</p>}
            </div>
          </Card>
        ))}
      </div>
      <p className="text-xs text-muted">Kiểm tra kết nối gửi một lời gọi rất nhỏ và có thể phát sinh chi phí nhỏ.</p>
      <Card title="Model theo agent (ghi đè)">
        <p className="mb-2 text-xs text-muted">Mặc định agent dùng provider chính. Chọn để ghi đè provider/model cho từng agent.</p>
        {agents.length === 0 && <p className="text-sm text-muted">Chưa tải được danh sách agent.</p>}
        <div className="space-y-2">
          {agents.map((a) => {
            const v = tm[a.key];
            return (
              <div key={a.key} className="grid grid-cols-[1fr_1fr] gap-2 sm:grid-cols-[180px_160px_1fr]">
                <span className="col-span-2 self-center text-sm sm:col-span-1">{a.name}</span>
                <Select aria-label={`Provider cho ${a.name}`} value={v?.provider ?? ''} onChange={(e) => { const pv = e.target.value as Pid | ''; setTm((t) => { const n = { ...t }; if (!pv) delete n[a.key]; else n[a.key] = { provider: pv, model: v?.model || prov[pv].model }; return n; }); }}>
                  <option value="">Mặc định</option>{PIDS.map((p) => <option key={p} value={p}>{PNAME[p]}</option>)}
                </Select>
                <Input aria-label={`Model cho ${a.name}`} value={v?.model ?? ''} disabled={!v} onChange={(e) => setTm((t) => ({ ...t, [a.key]: { ...t[a.key], model: e.target.value } }))} placeholder="model" />
              </div>
            );
          })}
        </div>
      </Card>
      <Button variant="primary" size="lg" disabled={!valid} busy={busy === 'save'} onClick={save}>Lưu cài đặt AI</Button>
    </div>
  );
}

const INT_STATUS: Record<string, { label: string; tone: string }> = {
  configured_untested: { label: 'Đã có khoá (chưa kiểm thử với khoá thật)', tone: 'amber' }, needs_api_key: { label: 'Cần API key', tone: 'amber' }, needs_oauth: { label: 'Cần OAuth', tone: 'amber' },
  not_implemented: { label: 'Chưa triển khai', tone: 'gray' }, manual_only: { label: 'Chỉ thủ công', tone: 'blue' }, active: { label: 'Đã hoạt động', tone: 'green' },
};
function IntegrationsTab() {
  const { data, error, loading } = useApi<{ items: { key: string; name: string; kind: string; status: string; note: string }[]; demo_forced: boolean }>('/integrations');
  if (loading && !data) return <Spinner />;
  return (
    <div className="space-y-3">
      <ErrorNote message={error} />
      <Notice tone="blue">Chưa có tích hợp nào được xác nhận là “đã kết nối” với dịch vụ thật. Trạng thái dưới đây phản ánh đúng mức triển khai hiện tại.</Notice>
      {data && (
        <Table head={['Tích hợp', 'Loại', 'Trạng thái', 'Ghi chú']} empty={data.items.length === 0 ? <div className="p-3"><Empty title="Không có tích hợp" /></div> : undefined}>
          {data.items.map((i) => { const st = INT_STATUS[i.status] ?? { label: i.status, tone: 'gray' }; return (
            <tr key={i.key}><Td className="font-medium">{i.name}</Td><Td className="text-xs">{i.kind}</Td><Td><Badge tone={st.tone}>{st.label}</Badge></Td><Td className="min-w-64 text-xs text-muted">{i.note}</Td></tr>
          ); })}
        </Table>
      )}
    </div>
  );
}

function MembersTab({ role }: { role: Role }) {
  const { data, error, loading, reload } = useApi<{ items: { id: string; role: Role; user_id: string; email: string; name: string }[] }>('/members');
  const [email, setEmail] = useState(''); const [r, setR] = useState<'admin' | 'editor' | 'viewer'>('editor');
  const { busy, run } = useAction(); const { confirm } = useUi();
  const isAdmin = role === 'owner' || role === 'admin';
  const add = () => run('add', async () => { await api('/members', { body: { email: email.trim(), role: r } }); setEmail(''); await reload(); }, 'Đã thêm/cập nhật thành viên');
  const del = async (m: { id: string; name: string; email: string }) => {
    if (!(await confirm({ title: 'Xoá thành viên?', body: `${m.name} (${m.email}) sẽ mất quyền truy cập workspace.`, danger: true, confirmLabel: 'Xoá' }))) return;
    await run('d' + m.id, async () => { await api(`/members/${m.id}`, { method: 'DELETE' }); await reload(); }, 'Đã xoá thành viên');
  };
  const ROLE: Record<Role, string> = { owner: 'Chủ sở hữu', admin: 'Quản trị', editor: 'Biên tập', viewer: 'Người xem' };
  return (
    <div className="space-y-4">
      {!isAdmin && <Notice tone="blue">Chỉ admin/owner được quản lý thành viên.</Notice>}
      {isAdmin && (
        <Card title="Thêm thành viên">
          <div className="grid gap-2 sm:grid-cols-[1fr_160px_auto] sm:items-end">
            <Field label="Email (đã đăng ký tài khoản)"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label="Vai trò"><Select value={r} onChange={(e) => setR(e.target.value as typeof r)}><option value="admin">Quản trị</option><option value="editor">Biên tập</option><option value="viewer">Người xem</option></Select></Field>
            <Button variant="primary" disabled={!/.+@.+\..+/.test(email)} busy={busy === 'add'} onClick={add}>Thêm</Button>
          </div>
          <p className="mt-2 text-xs text-muted">Hệ thống chưa gửi email mời: người được thêm phải tự đăng ký tài khoản trước. Thêm lại email đã có để đổi vai trò.</p>
        </Card>
      )}
      {loading && !data && <Spinner />}<ErrorNote message={error} />
      {data && (
        <Table head={['Tên', 'Email', 'Vai trò', '']} empty={data.items.length === 0 ? <div className="p-3"><Empty title="Chưa có thành viên" /></div> : undefined}>
          {data.items.map((m) => <tr key={m.id}><Td>{m.name}</Td><Td className="text-xs">{m.email}</Td><Td><Badge tone={m.role === 'owner' ? 'gold' : 'blue'}>{ROLE[m.role]}</Badge></Td>
            <Td className="text-right">{isAdmin && m.role !== 'owner' && <Button size="sm" variant="ghost" busy={busy === 'd' + m.id} onClick={() => del(m)}>Xoá</Button>}</Td></tr>)}
        </Table>
      )}
    </div>
  );
}

function DataTab({ me }: { me: Me }) {
  const isAdmin = me.role === 'owner' || me.role === 'admin';
  const audit = useApi<{ items: { id: string; action: string; entity_type: string | null; entity_id: string | null; created_at: string; user_name: string | null; detail: unknown }[] }>(isAdmin ? '/audit-logs' : null);
  const { busy, run } = useAction(); const { confirm } = useUi();
  const router = useRouter();
  const ws = me.workspaces.find((w) => w.id === me.workspaceId);
  const [typed, setTyped] = useState('');
  const exportAll = () => run('exp', async () => { const d = await api('/export/workspace'); download('lyvan-workspace-export.json', JSON.stringify(d, null, 2), 'application/json'); }, 'Đã xuất dữ liệu (không gồm khoá API)');
  const del = async () => {
    if (!(await confirm({ title: 'XOÁ VĨNH VIỄN workspace?', body: `Toàn bộ dữ liệu của “${ws?.name}” sẽ bị xoá và không thể khôi phục. Hãy xuất dữ liệu trước.`, danger: true, confirmLabel: 'Xoá vĩnh viễn' }))) return;
    const r = await run('del', () => api('/workspace', { method: 'DELETE', body: { confirm_name: typed } }), 'Đã xoá workspace');
    if (r) router.push('/login');
  };
  return (
    <div className="space-y-4">
      <Card title="Chính sách dữ liệu & bảo mật">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Cách ly workspace: mọi truy vấn đều lọc theo workspace của bạn.</li>
          <li>Khoá API của nhà cung cấp AI được mã hoá AES-256-GCM, không bao giờ trả về trình duyệt và không có trong file xuất.</li>
          <li>Dữ liệu chỉ gửi ra AI bên ngoài khi có khoá API hợp lệ và provider được bật; nếu không hệ thống chạy chế độ DEMO.</li>
        </ul>
      </Card>
      <Card title="Xuất dữ liệu">
        {isAdmin ? <><p className="mb-2 text-sm text-muted">Tải toàn bộ dữ liệu workspace dạng JSON (không gồm khoá API).</p><Button busy={busy === 'exp'} onClick={exportAll}>Tải file xuất</Button></> : <p className="text-sm text-muted">Chỉ admin/owner được xuất dữ liệu.</p>}
      </Card>
      <Card title="Nhật ký audit (200 gần nhất)">
        {!isAdmin ? <p className="text-sm text-muted">Chỉ admin/owner được xem nhật ký.</p> : audit.loading && !audit.data ? <Spinner /> : <>
          <ErrorNote message={audit.error} />
          {audit.data && <Table head={['Thời gian', 'Người dùng', 'Hành động', 'Đối tượng']} empty={audit.data.items.length === 0 ? <div className="p-3"><Empty title="Chưa có nhật ký" /></div> : undefined}>
            {audit.data.items.map((a) => <tr key={a.id}><Td className="whitespace-nowrap text-xs">{fmtDateTime(a.created_at)}</Td><Td>{a.user_name ?? '—'}</Td><Td className="text-xs">{a.action}</Td><Td className="text-xs">{a.entity_type ?? '—'}</Td></tr>)}
          </Table>}
        </>}
      </Card>
      {me.role === 'owner' && ws && (
        <Card title="Vùng nguy hiểm: xoá workspace">
          <p className="mb-2 text-sm">Gõ lại đúng tên workspace <b>{ws.name}</b> để xác nhận.</p>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]"><Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={ws.name} aria-label="Tên workspace xác nhận" /><Button variant="danger" disabled={typed !== ws.name} busy={busy === 'del'} onClick={del}>Xoá workspace</Button></div>
        </Card>
      )}
    </div>
  );
}

function GeneralTab({ me }: { me: Me }) {
  const [name, setName] = useState('');
  const { busy, run } = useAction();
  const ws = me.workspaces.find((w) => w.id === me.workspaceId);
  const create = async () => { const r = await run('cw', () => api('/workspaces', { body: { name: name.trim() } }), 'Đã tạo workspace'); if (r) location.reload(); };
  return (
    <div className="space-y-4">
      <Card title="Workspace hiện tại"><dl className="grid grid-cols-2 gap-y-1 text-sm sm:max-w-md"><dt className="text-muted">Tên</dt><dd>{ws?.name ?? '—'}</dd><dt className="text-muted">Vai trò của bạn</dt><dd>{me.role}</dd><dt className="text-muted">Múi giờ</dt><dd>Asia/Ho_Chi_Minh (chỉ đọc)</dd><dt className="text-muted">Tiền tệ hiển thị</dt><dd>VND (chỉ đọc)</dd></dl></Card>
      <Card title="Tạo workspace mới">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end"><Field label="Tên workspace"><Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field><Button variant="primary" disabled={!name.trim()} busy={busy === 'cw'} onClick={create}>Tạo và chuyển sang</Button></div>
        <p className="mt-2 text-xs text-muted">Workspace mới có dữ liệu khởi tạo riêng; bạn sẽ được chuyển sang workspace đó.</p>
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  const { data: me, error, loading } = useApi<Me>('/auth/me');
  const [tab, setTab] = useState<'ai' | 'int' | 'members' | 'data' | 'general'>('ai');
  const isAdmin = me?.role === 'owner' || me?.role === 'admin';
  const tabs = [...(isAdmin ? [{ id: 'ai' as const, label: 'AI Provider' }] : []), { id: 'int' as const, label: 'Tích hợp' }, { id: 'members' as const, label: 'Thành viên' }, { id: 'data' as const, label: 'Dữ liệu & bảo mật' }, { id: 'general' as const, label: 'Chung' }];
  const cur = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  return (
    <div>
      <PageHeader title="Cài đặt" desc="AI provider, tích hợp, thành viên, dữ liệu và bảo mật." />
      {loading && !me && <Spinner />}<ErrorNote message={error} />
      {me && (
        <div className="space-y-4">
          <Tabs tabs={tabs} value={cur} onChange={setTab} />
          {cur === 'ai' && <AiTab />}
          {cur === 'int' && <IntegrationsTab />}
          {cur === 'members' && <MembersTab role={me.role} />}
          {cur === 'data' && <DataTab me={me} />}
          {cur === 'general' && <GeneralTab me={me} />}
        </div>
      )}
    </div>
  );
}

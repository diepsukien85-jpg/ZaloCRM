'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Sparkles } from 'lucide-react';
import { api, ApiError, FORMAT_LABEL, PLATFORM_LABEL, useApi } from '@/lib/client';
import { Badge, Button, Card, DemoBadge, Empty, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Textarea, useAction, useUi } from '@/components/ui';

type Idea = {
  id: string; title: string; summary: string; pillar: string; format: string; platform: string; hook: string; status: string; total_score: number | null; source: string; is_demo: boolean; created_at: string;
  attraction: number | null; brand_fit: number | null; retention: number | null; conversion: number | null; feasibility: number | null; rationale: string | null; is_ai_estimate: boolean | null;
};
type GenRes = { saved: { id: string; title: string; total: number }[]; duplicates: { title: string; of: string; similarity: number }[]; meta: { demo: boolean } };

const STATUS: Record<string, string> = { new: 'Mới', selected: 'Đã chọn', in_production: 'Đang sản xuất', rejected: 'Bị loại', archived: 'Lưu trữ' };
const STATUS_TONE: Record<string, string> = { new: 'blue', selected: 'teal', in_production: 'amber', rejected: 'red', archived: 'gray' };
const COMP = [['attraction', 'Thu hút', 25], ['brand_fit', 'Phù hợp thương hiệu', 25], ['retention', 'Giữ chân', 20], ['conversion', 'Chuyển đổi', 20], ['feasibility', 'Khả thi', 10]] as const;
type CompKey = (typeof COMP)[number][0];
const DURATIONS = [15, 30, 45, 60, 90, 180];

function Scores({ i }: { i: Idea }) {
  const unscored = i.total_score == null || (i.rationale === 'Chưa chấm điểm');
  if (unscored) return <p className="rounded-lg bg-surface2 px-3 py-2 text-xs text-muted">Chưa chấm điểm</p>;
  const manual = i.is_ai_estimate === false || i.rationale === 'Chấm thủ công';
  return (
    <div className="rounded-lg bg-surface2 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-1"><p className="text-2xl font-semibold tabular-nums">{i.total_score}<span className="text-sm font-normal text-muted">/100</span></p><Badge tone={manual ? 'green' : 'amber'}>{manual ? 'chấm thủ công' : 'điểm ước tính của AI'}</Badge></div>
      <div className="mt-2 space-y-1.5">
        {COMP.map(([k, label, max]) => { const v = i[k] ?? 0; return (
          <div key={k} title={`${label}: ${v}/${max}`}>
            <div className="flex justify-between text-xs"><span>{label}</span><span className="tabular-nums text-muted">{v}/{max}</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full bg-teal" style={{ width: `${Math.min(100, (v / max) * 100)}%` }} /></div>
          </div>
        ); })}
      </div>
      {i.rationale && !manual && <p className="mt-2 text-xs text-muted">Lý do AI: {i.rationale}</p>}
    </div>
  );
}

export default function IdeasPage() {
  const router = useRouter();
  const { toast, confirm } = useUi();
  const { busy, run } = useAction();
  const [f, setF] = useState({ status: '', pillar: '', format: '', q: '' });
  const path = useMemo(() => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v.trim()) p.set(k, v.trim()); return `/ideas${p.size ? `?${p}` : ''}`; }, [f]);
  const { data, error, loading, reload } = useApi<{ items: Idea[] }>(path);
  const { data: brands } = useApi<{ items: { pillars: { name: string }[] }[] }>('/brands');
  const pillars = brands?.items[0]?.pillars.map((p) => p.name) ?? [];
  const items = data?.items ?? [];

  // Tạo bằng AI
  const [count, setCount] = useState(10);
  const [gen, setGen] = useState<GenRes | null>(null);
  const generate = () => run('gen', async () => { setGen(await api<GenRes>('/ideas/generate', { body: { count } })); reload(); });

  // Thêm thủ công
  const [addOpen, setAddOpen] = useState(false);
  const blank = { title: '', summary: '', pillar: '', format: 'post', platform: 'facebook_profile', hook: '' };
  const [nf, setNf] = useState(blank);
  const [withScore, setWithScore] = useState(false);
  const [ns, setNs] = useState<Record<CompKey, number>>({ attraction: 0, brand_fit: 0, retention: 0, conversion: 0, feasibility: 0 });
  const [addErr, setAddErr] = useState<string | null>(null);
  const add = () => run('add', async () => {
    setAddErr(null);
    try {
      await api('/ideas', { body: { ...nf, title: nf.title.trim(), ...(withScore ? { scores: ns } : {}) } });
      setAddOpen(false); setNf(blank); setWithScore(false); reload(); toast('Đã thêm ý tưởng');
    } catch (e) { if (e instanceof ApiError && e.status === 409) setAddErr(e.message); else throw e; }
  });

  // Chấm điểm
  const [sc, setSc] = useState<{ idea: Idea; v: Record<CompKey, number>; rationale: string } | null>(null);
  const openScore = (i: Idea) => setSc({ idea: i, v: { attraction: i.attraction ?? 0, brand_fit: i.brand_fit ?? 0, retention: i.retention ?? 0, conversion: i.conversion ?? 0, feasibility: i.feasibility ?? 0 }, rationale: '' });
  const saveScore = () => sc && run('score', async () => { await api(`/ideas/${sc.idea.id}/score`, { method: 'PUT', body: { ...sc.v, rationale: sc.rationale } }); setSc(null); reload(); }, 'Đã lưu điểm chấm thủ công');
  const scTotal = sc ? Object.values(sc.v).reduce((a, b) => a + b, 0) : 0;
  const clampV = (v: string, max: number) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

  const setStatus = (i: Idea, status: string) => run('s' + i.id, async () => { await api(`/ideas/${i.id}`, { method: 'PATCH', body: { status } }); reload(); }, 'Đã đổi trạng thái');
  const del = async (i: Idea) => {
    if (!(await confirm({ title: 'Xoá ý tưởng?', body: `Xoá “${i.title}”.`, danger: true, confirmLabel: 'Xoá' }))) return;
    run('d' + i.id, async () => { await api(`/ideas/${i.id}`, { method: 'DELETE' }); reload(); }, 'Đã xoá');
  };

  // Sản xuất
  const [dur, setDur] = useState<Record<string, number>>({});
  const produce = (i: Idea, type: 'post' | 'video') => run(`${type}${i.id}`, async () => {
    const c = await api<{ id: string; video_project_id?: string }>(`/ideas/${i.id}/produce`, { body: type === 'post' ? { type } : { type, duration_sec: dur[i.id] ?? 30 } });
    toast(type === 'post' ? 'Đã tạo bài viết nháp' : 'Đã tạo kịch bản video nháp');
    router.push(`/content/${c.id}`);
  });

  const hasFilter = Object.values(f).some((v) => v);

  return (
    <div>
      <PageHeader title="Ngân hàng ý tưởng" desc="Thu thập, chấm điểm và biến ý tưởng thành bài viết hoặc kịch bản video. Trùng lặp được loại tự động."
        actions={<><Button onClick={() => { setAddErr(null); setAddOpen(true); }}><Plus className="h-4 w-4" />Thêm thủ công</Button></>} />
      <Notice tone="blue">Điểm /100 là <b>ước tính của AI</b> (hoặc do bạn chấm) để xếp thứ tự ưu tiên — <b>không phải cam kết lượt xem hay khả năng viral</b>.</Notice>

      <Card title="Tạo ý tưởng bằng AI" className="mt-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Số ý tưởng (1–30)"><Input type="number" min={1} max={30} className="w-28" value={count} onChange={(e) => setCount(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} /></Field>
          <Button variant="primary" busy={busy === 'gen'} onClick={generate}><Sparkles className="h-4 w-4" />Tạo ý tưởng bằng AI</Button>
        </div>
        <p className="mt-2 text-xs text-muted">AI dựa trên từ khoá, nhật ký không riêng tư và ý tưởng đã có (để tránh trùng).</p>
        {busy === 'gen' && <Spinner label="AI đang tạo ý tưởng…" />}
        {gen && (
          <div className="mt-3 space-y-2 rounded-lg bg-surface2 p-3 text-sm">
            <p className="flex flex-wrap items-center gap-2"><b>Đã lưu {gen.saved.length}</b> ý tưởng · loại {gen.duplicates.length} do trùng <DemoBadge show={gen.meta?.demo} /></p>
            {gen.meta?.demo && <p className="text-xs text-muted">Chế độ demo: ý tưởng là dữ liệu mẫu.</p>}
            {gen.duplicates.length > 0 && <details><summary className="cursor-pointer text-xs text-muted">Xem các cặp trùng</summary><ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">{gen.duplicates.map((d, i) => <li key={i}>“{d.title}” trùng với “{d.of}” (giống {Math.round(d.similarity * 100)}%)</li>)}</ul></details>}
          </div>
        )}
      </Card>

      <div className="my-4 grid grid-cols-2 gap-2 md:grid-cols-5">
        <Input aria-label="Tìm" className="col-span-2 md:col-span-1" placeholder="Tìm tiêu đề…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <Select aria-label="Trạng thái" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Mọi trạng thái</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select aria-label="Trụ cột" value={f.pillar} onChange={(e) => setF({ ...f, pillar: e.target.value })}><option value="">Mọi trụ cột</option>{pillars.map((p) => <option key={p}>{p}</option>)}</Select>
        <Select aria-label="Định dạng" value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}><option value="">Mọi định dạng</option>{Object.entries(FORMAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        {hasFilter && <Button variant="ghost" onClick={() => setF({ status: '', pillar: '', format: '', q: '' })}>Xoá lọc</Button>}
      </div>

      <ErrorNote message={error} />
      {loading && !data && <Spinner />}
      {data && items.length === 0 && <Empty title={hasFilter ? 'Không có ý tưởng khớp bộ lọc' : 'Chưa có ý tưởng'} hint="Bấm “Tạo ý tưởng bằng AI” hoặc thêm thủ công." />}

      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {items.map((i) => (
          <article key={i.id} className="flex flex-col rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={STATUS_TONE[i.status]}>{STATUS[i.status] ?? i.status}</Badge><Badge>{FORMAT_LABEL[i.format] ?? i.format}</Badge><Badge>{PLATFORM_LABEL[i.platform] ?? i.platform}</Badge>{i.pillar && <Badge tone="blue">{i.pillar}</Badge>}<DemoBadge show={i.is_demo} />
            </div>
            <h3 className="mt-2 break-words font-semibold">{i.title}</h3>
            {i.summary && <p className="mt-1 text-sm text-muted">{i.summary}</p>}
            {i.hook && <p className="mt-2 text-sm"><span className="text-xs text-muted">Hook: </span>{i.hook}</p>}
            <div className="mt-3"><Scores i={i} /></div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Select aria-label="Đổi trạng thái" value={i.status} disabled={busy === 's' + i.id} onChange={(e) => setStatus(i, e.target.value)}>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
              <Button onClick={() => openScore(i)}>Chấm điểm thủ công</Button>
              <Button variant="primary" busy={busy === 'post' + i.id} disabled={!!busy && busy !== 'post' + i.id} onClick={() => produce(i, 'post')}>Viết bài</Button>
              <div className="flex gap-1">
                <Select aria-label="Thời lượng video" className="w-20 px-2" value={dur[i.id] ?? 30} onChange={(e) => setDur({ ...dur, [i.id]: Number(e.target.value) })}>{DURATIONS.map((d) => <option key={d} value={d}>{d}s</option>)}</Select>
                <Button variant="gold" className="flex-1 px-2" busy={busy === 'video' + i.id} disabled={!!busy && busy !== 'video' + i.id} onClick={() => produce(i, 'video')}>Kịch bản video</Button>
              </div>
            </div>
            {busy?.endsWith(i.id) && (busy.startsWith('post') || busy.startsWith('video')) && <Spinner label="AI đang viết, vui lòng chờ…" />}
            <Button size="sm" variant="ghost" className="mt-2 self-end text-danger" onClick={() => del(i)}>Xoá</Button>
          </article>
        ))}
      </div>

      {/* Chấm điểm */}
      <Modal open={!!sc} onClose={() => setSc(null)} title="Chấm điểm thủ công" footer={<><Button onClick={() => setSc(null)}>Huỷ</Button><Button variant="primary" busy={busy === 'score'} onClick={saveScore}>Lưu điểm ({scTotal}/100)</Button></>}>
        {sc && (
          <div className="space-y-4">
            <p className="text-sm font-medium">{sc.idea.title}</p>
            {COMP.map(([k, label, max]) => (
              <div key={k}>
                <div className="flex items-center justify-between gap-2"><label htmlFor={`sc-${k}`} className="text-sm">{label} <span className="text-xs text-muted">(0–{max})</span></label>
                  <Input type="number" min={0} max={max} className="w-20" value={sc.v[k]} onChange={(e) => setSc({ ...sc, v: { ...sc.v, [k]: clampV(e.target.value, max) } })} aria-label={`${label} số điểm`} /></div>
                <input id={`sc-${k}`} type="range" min={0} max={max} step={1} value={sc.v[k]} onChange={(e) => setSc({ ...sc, v: { ...sc.v, [k]: Number(e.target.value) } })} className="mt-1 w-full" />
              </div>
            ))}
            <Field label="Ghi chú lý do chấm"><Textarea value={sc.rationale} maxLength={800} onChange={(e) => setSc({ ...sc, rationale: e.target.value })} /></Field>
            <p className="text-xs text-muted">Điểm do bạn chấm sẽ ghi đè điểm ước tính của AI.</p>
          </div>
        )}
      </Modal>

      {/* Thêm thủ công */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Thêm ý tưởng thủ công" wide footer={<><Button onClick={() => setAddOpen(false)}>Huỷ</Button><Button variant="primary" busy={busy === 'add'} disabled={nf.title.trim().length < 3} onClick={add}>Thêm</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <ErrorNote message={addErr} />
          <Field label="Tiêu đề * (≥3 ký tự)" className="sm:col-span-2"><Input value={nf.title} maxLength={200} onChange={(e) => setNf({ ...nf, title: e.target.value })} autoFocus /></Field>
          <Field label="Tóm tắt" className="sm:col-span-2"><Textarea value={nf.summary} maxLength={1000} onChange={(e) => setNf({ ...nf, summary: e.target.value })} /></Field>
          <Field label="Trụ cột">{pillars.length ? <Select value={nf.pillar} onChange={(e) => setNf({ ...nf, pillar: e.target.value })}><option value="">—</option>{pillars.map((p) => <option key={p}>{p}</option>)}</Select> : <Input value={nf.pillar} onChange={(e) => setNf({ ...nf, pillar: e.target.value })} />}</Field>
          <Field label="Định dạng"><Select value={nf.format} onChange={(e) => setNf({ ...nf, format: e.target.value })}>{Object.entries(FORMAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Nền tảng"><Select value={nf.platform} onChange={(e) => setNf({ ...nf, platform: e.target.value })}>{Object.entries(PLATFORM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Hook"><Input value={nf.hook} maxLength={400} onChange={(e) => setNf({ ...nf, hook: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="h-4 w-4" checked={withScore} onChange={(e) => setWithScore(e.target.checked)} />Chấm điểm ngay (nếu không, ý tưởng ở trạng thái “Chưa chấm điểm”)</label>
          {withScore && COMP.map(([k, label, max]) => <Field key={k} label={`${label} (0–${max})`}><Input type="number" min={0} max={max} value={ns[k]} onChange={(e) => setNs({ ...ns, [k]: clampV(e.target.value, max) })} /></Field>)}
        </div>
      </Modal>
    </div>
  );
}

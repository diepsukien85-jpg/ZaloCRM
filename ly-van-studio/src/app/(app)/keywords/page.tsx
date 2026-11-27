'use client';
import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Download, GitCompare, Plus, Sparkles, Star } from 'lucide-react';
import { api, fmtDate, fmtNum, FUNNEL_LABEL, TIER_LABEL, useApi } from '@/lib/client';
import { Badge, Button, Card, DemoBadge, Empty, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Table, Tabs, Td, clsx, useAction, useUi } from '@/components/ui';

type Kw = {
  id: string; keyword: string; parent_keyword_id: string | null; language: 'vi' | 'en' | 'zh'; category: string; search_intent: string; audience: string; funnel_stage: string; tier: number;
  relevance_score: number | null; content_potential_score: number | null; scores_are_ai_estimate: boolean; search_volume: number | null; search_volume_source: string | null;
  source: string; favorite: boolean; labels: string[]; is_demo: boolean; updated_at: string;
};
type Expand = { added: number; skipped: number; total: number; meta: { demo: boolean; provider: string } };
type Plan = { saved: { id: string; title: string; total: number }[]; duplicates: { title: string; of: string; similarity: number }[]; meta: { demo: boolean } };

const LANG: Record<string, string> = { vi: 'Tiếng Việt', en: 'Tiếng Anh', zh: 'Tiếng Trung' };
const INTENT: Record<string, string> = { informational: 'Tìm hiểu', navigational: 'Điều hướng', commercial: 'So sánh/cân nhắc', transactional: 'Mua/giao dịch' };
const PLAN_KIND = { idea: 'Chuyển thành ý tưởng', series: 'Thành series 5 tập', plan30: 'Kế hoạch 30 ngày' } as const;
const SOURCE_LABEL = (s: string) => ({ manual: 'Nhập tay', ai: 'AI', demo: 'Demo (mẫu)' }[s] ?? s);

function Est({ v }: { v: number | null }) {
  return v == null ? <span className="text-muted">—</span> : <span className="tabular-nums" title="Điểm ước tính của AI, không phải số liệu đo lường">{v}<sup className="ml-0.5 text-[10px] text-muted">AI</sup></span>;
}

export default function KeywordsPage() {
  const { toast, confirm } = useUi();
  const { busy, run } = useAction();
  const [f, setF] = useState({ q: '', tier: '', language: '', funnel_stage: '', label: '', favorite: false });
  const [view, setView] = useState<'table' | 'tree' | 'funnel'>('table');
  const path = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, String(v));
    return `/keywords${p.size ? `?${p}` : ''}`;
  }, [f]);
  const { data, error, loading, reload } = useApi<{ items: Kw[] }>(path);
  const items = useMemo(() => data?.items ?? [], [data]);

  // Form mở rộng
  const [roots, setRoots] = useState('');
  const [count, setCount] = useState(20);
  const [langs, setLangs] = useState<string[]>([]);
  const [expRes, setExpRes] = useState<Expand | null>(null);
  const doExpand = () => {
    const list = roots.split(/[,\n;]/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) return toast('Nhập ít nhất một từ khoá gốc', 'err');
    if (list.length > 10) return toast('Tối đa 10 từ khoá gốc mỗi lần', 'err');
    run('expand', async () => {
      const r = await api<Expand>('/keywords/expand', { body: { roots: list, count, ...(langs.length ? { languages: langs } : {}) } });
      setExpRes(r); reload();
    }, 'Đã mở rộng từ khoá');
  };

  // Thêm thủ công
  const [addOpen, setAddOpen] = useState(false);
  const blank = { keyword: '', language: 'vi', tier: 1, funnel_stage: 'awareness', search_intent: 'informational', category: '', audience: '', parent_keyword_id: '' };
  const [nf, setNf] = useState(blank);
  const doAdd = () => run('add', async () => {
    await api('/keywords', { body: { ...nf, parent_keyword_id: nf.parent_keyword_id || null } });
    setAddOpen(false); setNf(blank); reload();
  }, 'Đã thêm từ khoá');

  // Chọn / so sánh
  const [sel, setSel] = useState<string[]>([]);
  const [cmpOpen, setCmpOpen] = useState(false);
  const toggleSel = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 4 ? (toast('Chỉ so sánh tối đa 4 từ khoá', 'err'), s) : [...s, id]));
  const cmpItems = sel.map((id) => items.find((k) => k.id === id)).filter((x): x is Kw => !!x);

  // Từ khoá đang xem chi tiết
  const [openId, setOpenId] = useState<string | null>(null);
  const cur = items.find((k) => k.id === openId) ?? null;
  const [planRes, setPlanRes] = useState<{ kind: string; r: Plan } | null>(null);
  const [vol, setVol] = useState({ v: '', src: '' });
  const [labelsTxt, setLabelsTxt] = useState('');
  const open = (k: Kw) => { setOpenId(k.id); setPlanRes(null); setVol({ v: k.search_volume?.toString() ?? '', src: k.search_volume_source ?? '' }); setLabelsTxt(k.labels.join(', ')); };

  const patch = (id: string, body: Record<string, unknown>, ok?: string) => run('patch' + id, async () => { await api(`/keywords/${id}`, { method: 'PATCH', body }); reload(); }, ok);
  const saveVol = (k: Kw) => {
    if (!vol.v.trim()) return toast('Nhập lượng tìm kiếm', 'err');
    if (vol.src.trim().length < 2) return toast('Bắt buộc ghi rõ nguồn (ví dụ: Google Keyword Planner 11/2026)', 'err');
    patch(k.id, { search_volume: Number(vol.v), search_volume_source: vol.src.trim() }, 'Đã lưu lượng tìm kiếm kèm nguồn');
  };
  const del = async (k: Kw) => {
    if (!(await confirm({ title: 'Xoá từ khoá?', body: `Xoá “${k.keyword}”. Ý tưởng đã tạo từ từ khoá này vẫn được giữ.`, danger: true, confirmLabel: 'Xoá' }))) return;
    run('del' + k.id, async () => { await api(`/keywords/${k.id}`, { method: 'DELETE' }); setOpenId(null); setSel((s) => s.filter((x) => x !== k.id)); reload(); }, 'Đã xoá');
  };
  const plan = (k: Kw, kind: keyof typeof PLAN_KIND) => run('plan' + kind, async () => {
    const r = await api<Plan>(`/keywords/${k.id}/plan`, { body: { kind } });
    setPlanRes({ kind, r });
  });

  // Cây từ khoá
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => {
    const ids = new Set(items.map((k) => k.id));
    const kids = new Map<string | null, Kw[]>();
    for (const k of items) { const p = k.parent_keyword_id && ids.has(k.parent_keyword_id) ? k.parent_keyword_id : null; kids.set(p, [...(kids.get(p) ?? []), k]); }
    return kids;
  }, [items]);
  const toggleNode = (id: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const renderNode = (k: Kw, depth: number): ReactNode => {
    const ch = tree.get(k.id) ?? [];
    const isC = collapsed.has(k.id);
    return (
      <li key={k.id}>
        <div className={clsx('flex items-center gap-1 rounded-lg py-1 pr-2', openId === k.id && 'bg-brand/10')} style={{ paddingLeft: Math.min(depth, 8) * 14 }}>
          {ch.length ? <button aria-label={isC ? 'Mở nhánh' : 'Thu nhánh'} className="grid h-7 w-7 shrink-0 place-items-center rounded hover:bg-surface2" onClick={() => toggleNode(k.id)}>{isC ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</button> : <span className="h-7 w-7 shrink-0" />}
          <button onClick={() => open(k)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm hover:underline">
            <Badge tone="blue">T{k.tier}</Badge><span className="truncate">{k.keyword}</span>{k.favorite && <Star className="h-3.5 w-3.5 shrink-0 fill-gold text-gold" />}
            <span className="shrink-0 text-xs text-muted">{LANG[k.language]}</span>{ch.length > 0 && <span className="shrink-0 text-xs text-muted">({ch.length})</span>}
          </button>
        </div>
        {ch.length > 0 && !isC && <ul className="border-l border-line" style={{ marginLeft: Math.min(depth, 8) * 14 + 14 }}>{ch.map((c) => renderNode(c, 1))}</ul>}
      </li>
    );
  };

  const hasFilter = Object.values(f).some(Boolean);
  const setLang = (l: string) => setF({ ...f, language: l });

  return (
    <div>
      <PageHeader title="Phòng nghiên cứu từ khoá" desc="Mở rộng từ khoá theo 5 tầng bằng AI, lọc, xem dạng cây và biến từ khoá thành ý tưởng/series/kế hoạch."
        actions={<>
          <Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" />Thêm thủ công</Button>
          <a href="/api/keywords/export.csv" className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 text-sm font-medium hover:bg-surface2"><Download className="h-4 w-4" />Xuất CSV</a>
        </>} />

      <Notice tone="blue">
        Hệ thống <b>không tự bịa lượng tìm kiếm</b>. Điểm “liên quan” và “tiềm năng nội dung” là <b>ước tính của AI</b> (nhãn AI), không phải số liệu đo lường. Lượng tìm kiếm chỉ hiện khi bạn tự nhập kèm nguồn.
      </Notice>

      <Card title="Mở rộng từ khoá bằng AI" className="mt-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
          <Field label="Từ khoá gốc (phân tách bằng dấu phẩy, tối đa 10)"><Input value={roots} onChange={(e) => setRoots(e.target.value)} placeholder="ví dụ: khởi nghiệp, bán hàng online, quản lý thời gian" onKeyDown={(e) => e.key === 'Enter' && doExpand()} /></Field>
          <Field label="Số lượng"><Select value={count} onChange={(e) => setCount(Number(e.target.value))}><option value={20}>20 từ khoá</option><option value={50}>50 từ khoá</option><option value={100}>100 từ khoá</option></Select></Field>
          <div className="flex items-end"><Button variant="primary" className="w-full md:w-auto" busy={busy === 'expand'} onClick={doExpand}><Sparkles className="h-4 w-4" />Mở rộng</Button></div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-xs text-muted">Giữ lại ngôn ngữ:</span>
          {Object.entries(LANG).map(([k, v]) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={langs.includes(k)} onChange={(e) => setLangs(e.target.checked ? [...langs, k] : langs.filter((x) => x !== k))} />{v}</label>)}
          <span className="text-xs text-muted">(không chọn = giữ tất cả)</span>
        </div>
        {busy === 'expand' && <Spinner label="AI đang mở rộng từ khoá…" />}
        {expRes && (
          <div className="mt-3 rounded-lg bg-surface2 p-3 text-sm">
            <p className="flex flex-wrap items-center gap-2"><b>Thêm mới {expRes.added}</b> · bỏ qua {expRes.skipped} do trùng · tổng AI trả về {expRes.total}<DemoBadge show={expRes.meta?.demo} /></p>
            {expRes.meta?.demo && <p className="mt-1 text-xs text-muted">Chế độ demo: từ khoá là dữ liệu mẫu, chưa có khoá AI thật.</p>}
          </div>
        )}
      </Card>

      <Card className="mt-4" pad={false}>
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
            <Input aria-label="Tìm từ khoá" className="col-span-2" placeholder="Tìm từ khoá…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
            <Select aria-label="Tầng" value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })}><option value="">Mọi tầng</option>{[1, 2, 3, 4, 5].map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}</Select>
            <Select aria-label="Hành trình" value={f.funnel_stage} onChange={(e) => setF({ ...f, funnel_stage: e.target.value })}><option value="">Mọi hành trình</option>{Object.entries(FUNNEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            <Input aria-label="Nhãn" placeholder="Nhãn…" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
            <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={f.favorite} onChange={(e) => setF({ ...f, favorite: e.target.checked })} />Yêu thích</label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {[['', 'Mọi ngôn ngữ'], ['zh', 'Chỉ tiếng Trung'], ['en', 'Chỉ tiếng Anh'], ['vi', 'Chỉ tiếng Việt']].map(([k, v]) => (
              <button key={k} onClick={() => setLang(k)} className={clsx('rounded-full border px-3 py-1 text-xs', f.language === k ? 'border-brand bg-brand/10 text-brand' : 'border-line text-muted hover:text-ink')}>{v}</button>
            ))}
            {hasFilter && <Button size="sm" variant="ghost" onClick={() => setF({ q: '', tier: '', language: '', funnel_stage: '', label: '', favorite: false })}>Xoá lọc</Button>}
            <span className="ml-auto text-xs text-muted">{loading ? 'Đang tải…' : `${fmtNum(items.length)} từ khoá`}</span>
            <Button size="sm" variant="primary" disabled={sel.length < 2} onClick={() => setCmpOpen(true)}><GitCompare className="h-4 w-4" />So sánh ({sel.length}/4)</Button>
          </div>
          <Tabs value={view} onChange={setView} tabs={[{ id: 'table', label: 'Bảng' }, { id: 'tree', label: 'Cây từ khoá / Mindmap' }, { id: 'funnel', label: 'Theo hành trình khách hàng' }]} />
        </div>

        <div className="px-4 pb-4">
          <ErrorNote message={error} />
          {loading && !data && <Spinner />}
          {data && items.length === 0 && <Empty title={hasFilter ? 'Không có từ khoá khớp bộ lọc' : 'Chưa có từ khoá'} hint="Nhập từ khoá gốc ở trên rồi bấm “Mở rộng”, hoặc thêm thủ công." />}

          {items.length > 0 && view === 'table' && (
            <Table head={['So sánh', '★', 'Từ khoá', 'Tầng', 'Ngôn ngữ', 'Danh mục', 'Ý định tìm kiếm', 'Đối tượng', 'Hành trình', 'Liên quan (ước tính AI)', 'Tiềm năng nội dung (ước tính AI)', 'Lượng tìm kiếm (có nguồn)', 'Nguồn dữ liệu', 'Cập nhật', '']}>
              {items.map((k) => (
                <tr key={k.id} className={clsx(sel.includes(k.id) && 'bg-brand/5')}>
                  <Td><input type="checkbox" aria-label={`Chọn so sánh ${k.keyword}`} className="h-4 w-4" checked={sel.includes(k.id)} onChange={() => toggleSel(k.id)} /></Td>
                  <Td><button aria-label={k.favorite ? 'Bỏ yêu thích' : 'Yêu thích'} onClick={() => patch(k.id, { favorite: !k.favorite })}><Star className={clsx('h-4 w-4', k.favorite ? 'fill-gold text-gold' : 'text-muted')} /></button></Td>
                  <Td className="min-w-48"><button onClick={() => open(k)} className="text-left font-medium hover:underline">{k.keyword}</button> <DemoBadge show={k.is_demo} />{k.labels.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{k.labels.map((l) => <Badge key={l}>{l}</Badge>)}</div>}</Td>
                  <Td>{k.tier}</Td><Td>{LANG[k.language]}</Td><Td>{k.category || '—'}</Td><Td>{INTENT[k.search_intent] ?? k.search_intent}</Td><Td className="min-w-32">{k.audience || '—'}</Td>
                  <Td>{FUNNEL_LABEL[k.funnel_stage] ?? k.funnel_stage}</Td>
                  <Td><Est v={k.relevance_score} /></Td><Td><Est v={k.content_potential_score} /></Td>
                  <Td>{k.search_volume != null ? <span title={`Nguồn: ${k.search_volume_source}`}><b className="tabular-nums">{fmtNum(k.search_volume)}</b><span className="block max-w-36 truncate text-xs text-muted">{k.search_volume_source}</span></span> : <span className="text-muted" title="Chưa có số liệu đo lường">— chưa có</span>}</Td>
                  <Td>{SOURCE_LABEL(k.source)}</Td><Td className="whitespace-nowrap">{fmtDate(k.updated_at)}</Td>
                  <Td><Button size="sm" onClick={() => open(k)}>Chi tiết</Button></Td>
                </tr>
              ))}
            </Table>
          )}

          {items.length > 0 && view === 'tree' && (
            <div>
              <div className="mb-2 flex gap-2"><Button size="sm" onClick={() => setCollapsed(new Set())}>Mở hết</Button><Button size="sm" onClick={() => setCollapsed(new Set(items.filter((k) => tree.get(k.id)?.length).map((k) => k.id)))}>Thu hết</Button><span className="self-center text-xs text-muted">Cây dựng theo từ khoá cha. Bấm một nút để xem/hành động.</span></div>
              <ul className="space-y-0.5 overflow-x-auto rounded-lg border border-line p-2">{(tree.get(null) ?? []).map((k) => renderNode(k, 0))}</ul>
            </div>
          )}

          {items.length > 0 && view === 'funnel' && (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {Object.entries(FUNNEL_LABEL).map(([stage, label]) => {
                const g = items.filter((k) => k.funnel_stage === stage);
                return (
                  <div key={stage} className="rounded-lg border border-line p-3">
                    <h3 className="mb-2 flex items-center justify-between text-sm font-semibold">{label}<Badge>{g.length}</Badge></h3>
                    {g.length ? <ul className="space-y-1">{g.map((k) => <li key={k.id}><button onClick={() => open(k)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface2"><Badge tone="blue">T{k.tier}</Badge><span className="truncate">{k.keyword}</span></button></li>)}</ul> : <p className="text-xs text-muted">—</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      {/* Chi tiết + hành động */}
      <Modal open={!!cur} onClose={() => setOpenId(null)} title={cur ? cur.keyword : ''} wide>
        {cur && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="blue">{TIER_LABEL[cur.tier]}</Badge><Badge>{LANG[cur.language]}</Badge><Badge>{FUNNEL_LABEL[cur.funnel_stage]}</Badge><Badge>{INTENT[cur.search_intent]}</Badge><DemoBadge show={cur.is_demo} />
              {cur.favorite && <Badge tone="gold">Yêu thích</Badge>}
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div><dt className="text-xs text-muted">Liên quan (ước tính AI)</dt><dd><Est v={cur.relevance_score} /></dd></div>
              <div><dt className="text-xs text-muted">Tiềm năng nội dung (ước tính AI)</dt><dd><Est v={cur.content_potential_score} /></dd></div>
              <div><dt className="text-xs text-muted">Danh mục</dt><dd>{cur.category || '—'}</dd></div>
              <div><dt className="text-xs text-muted">Đối tượng</dt><dd>{cur.audience || '—'}</dd></div>
              <div><dt className="text-xs text-muted">Lượng tìm kiếm</dt><dd>{cur.search_volume != null ? `${fmtNum(cur.search_volume)} (nguồn: ${cur.search_volume_source})` : '— chưa có số liệu'}</dd></div>
              <div><dt className="text-xs text-muted">Nguồn / cập nhật</dt><dd>{SOURCE_LABEL(cur.source)} · {fmtDate(cur.updated_at)}</dd></div>
            </dl>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => patch(cur.id, { favorite: !cur.favorite })}><Star className="h-4 w-4" />{cur.favorite ? 'Bỏ yêu thích' : 'Yêu thích'}</Button>
              <Button onClick={() => toggleSel(cur.id)}>{sel.includes(cur.id) ? 'Bỏ khỏi so sánh' : 'Thêm vào so sánh'}</Button>
              <Button variant="danger" onClick={() => del(cur)}>Xoá</Button>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold">Biến thành nội dung (AI, chỉ tạo ý tưởng — không tự đăng)</h3>
              <div className="grid gap-2 sm:grid-cols-3">
                {(Object.keys(PLAN_KIND) as (keyof typeof PLAN_KIND)[]).map((kd) => <Button key={kd} variant="primary" busy={busy === 'plan' + kd} disabled={!!busy && busy !== 'plan' + kd} onClick={() => plan(cur, kd)}>{PLAN_KIND[kd]}</Button>)}
              </div>
              {planRes && (
                <div className="mt-3 space-y-2 rounded-lg bg-surface2 p-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2"><b>{PLAN_KIND[planRes.kind as keyof typeof PLAN_KIND]}:</b> đã lưu {planRes.r.saved.length} ý tưởng · loại {planRes.r.duplicates.length} do trùng <DemoBadge show={planRes.r.meta?.demo} /></p>
                  {planRes.r.saved.length > 0 && <ul className="list-disc pl-5">{planRes.r.saved.map((s) => <li key={s.id}>{s.title} <span className="text-xs text-muted">({s.total}/100, ước tính AI)</span></li>)}</ul>}
                  {planRes.r.duplicates.length > 0 && <details><summary className="cursor-pointer text-xs text-muted">Xem ý tưởng bị loại do trùng</summary><ul className="mt-1 list-disc pl-5 text-xs">{planRes.r.duplicates.map((d, i) => <li key={i}>“{d.title}” trùng “{d.of}” ({Math.round(d.similarity * 100)}%)</li>)}</ul></details>}
                  <Link href="/ideas" className="inline-block text-brand underline">Mở ngân hàng ý tưởng →</Link>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-line p-3">
              <h3 className="mb-2 text-sm font-semibold">Nhập lượng tìm kiếm (bắt buộc kèm nguồn)</h3>
              <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
                <Field label="Lượng tìm kiếm / tháng"><Input type="number" min={0} inputMode="numeric" value={vol.v} onChange={(e) => setVol({ ...vol, v: e.target.value })} /></Field>
                <Field label="Nguồn số liệu"><Input value={vol.src} onChange={(e) => setVol({ ...vol, src: e.target.value })} placeholder="Google Keyword Planner, 11/2026" /></Field>
                <div className="flex items-end gap-2"><Button variant="primary" busy={busy === 'patch' + cur.id} onClick={() => saveVol(cur)}>Lưu</Button></div>
              </div>
              {cur.search_volume != null && <Button size="sm" variant="ghost" className="mt-2" onClick={() => { patch(cur.id, { search_volume: null }, 'Đã xoá lượng tìm kiếm'); setVol({ v: '', src: '' }); }}>Xoá lượng tìm kiếm</Button>}
            </div>

            <div className="rounded-lg border border-line p-3">
              <Field label="Nhãn (phân tách bằng dấu phẩy)"><Input value={labelsTxt} onChange={(e) => setLabelsTxt(e.target.value)} placeholder="ưu tiên, quý 4" /></Field>
              <Button className="mt-2" onClick={() => patch(cur.id, { labels: labelsTxt.split(',').map((s) => s.trim()).filter(Boolean) }, 'Đã lưu nhãn')}>Lưu nhãn</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* So sánh */}
      <Modal open={cmpOpen && cmpItems.length >= 2} onClose={() => setCmpOpen(false)} title="So sánh từ khoá" wide>
        <Table head={['Tiêu chí', ...cmpItems.map((k) => k.keyword)]}>
          {([
            ['Tầng', (k: Kw) => TIER_LABEL[k.tier]], ['Ngôn ngữ', (k: Kw) => LANG[k.language]], ['Danh mục', (k: Kw) => k.category || '—'], ['Ý định tìm kiếm', (k: Kw) => INTENT[k.search_intent]], ['Đối tượng', (k: Kw) => k.audience || '—'],
            ['Hành trình', (k: Kw) => FUNNEL_LABEL[k.funnel_stage]], ['Liên quan (ước tính AI)', (k: Kw) => (k.relevance_score ?? '—')], ['Tiềm năng nội dung (ước tính AI)', (k: Kw) => (k.content_potential_score ?? '—')],
            ['Lượng tìm kiếm (có nguồn)', (k: Kw) => (k.search_volume != null ? `${fmtNum(k.search_volume)} — ${k.search_volume_source}` : '— chưa có')], ['Nguồn dữ liệu', (k: Kw) => SOURCE_LABEL(k.source)], ['Cập nhật', (k: Kw) => fmtDate(k.updated_at)],
          ] as [string, (k: Kw) => string | number][]).map(([label, fn]) => <tr key={label}><Td className="whitespace-nowrap font-medium text-muted">{label}</Td>{cmpItems.map((k) => <Td key={k.id}>{fn(k)}</Td>)}</tr>)}
        </Table>
        <p className="mt-2 text-xs text-muted">Điểm có nhãn “ước tính AI” không phải số liệu đo lường thật.</p>
      </Modal>

      {/* Thêm thủ công */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Thêm từ khoá thủ công" footer={<><Button onClick={() => setAddOpen(false)}>Huỷ</Button><Button variant="primary" busy={busy === 'add'} disabled={!nf.keyword.trim()} onClick={doAdd}>Thêm</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Từ khoá" className="sm:col-span-2"><Input value={nf.keyword} onChange={(e) => setNf({ ...nf, keyword: e.target.value })} maxLength={200} autoFocus /></Field>
          <Field label="Ngôn ngữ"><Select value={nf.language} onChange={(e) => setNf({ ...nf, language: e.target.value })}>{Object.entries(LANG).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Tầng"><Select value={nf.tier} onChange={(e) => setNf({ ...nf, tier: Number(e.target.value), parent_keyword_id: '' })}>{[1, 2, 3, 4, 5].map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}</Select></Field>
          <Field label="Hành trình"><Select value={nf.funnel_stage} onChange={(e) => setNf({ ...nf, funnel_stage: e.target.value })}>{Object.entries(FUNNEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Ý định tìm kiếm"><Select value={nf.search_intent} onChange={(e) => setNf({ ...nf, search_intent: e.target.value })}>{Object.entries(INTENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Danh mục"><Input value={nf.category} onChange={(e) => setNf({ ...nf, category: e.target.value })} /></Field>
          <Field label="Đối tượng"><Input value={nf.audience} onChange={(e) => setNf({ ...nf, audience: e.target.value })} /></Field>
          <Field label="Từ khoá cha (tuỳ chọn)" className="sm:col-span-2"><Select value={nf.parent_keyword_id} onChange={(e) => setNf({ ...nf, parent_keyword_id: e.target.value })}><option value="">— Không —</option>{items.filter((k) => k.tier < nf.tier).map((k) => <option key={k.id} value={k.id}>T{k.tier} · {k.keyword}</option>)}</Select></Field>
        </div>
        <p className="mt-3 text-xs text-muted">Từ khoá nhập tay không có điểm AI và không có lượng tìm kiếm cho đến khi bạn nhập kèm nguồn.</p>
      </Modal>
    </div>
  );
}

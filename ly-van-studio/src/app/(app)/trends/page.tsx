'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Plus, Trash2 } from 'lucide-react';
import { api, fmtDate, fmtDateTime, PLATFORM_LABEL, useApi } from '@/lib/client';
import { Badge, Button, Card, DemoBadge, Empty, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Textarea, useAction, useUi } from '@/components/ui';

type Trend = {
  id: string; title: string; platform: string; url: string | null; country: string | null; language: string | null; published_at: string | null; collected_at: string; keywords: string[]; reason: string;
  relevance_score: number | null; metrics: Record<string, string | number>; reliability: string; verification_status: 'unverified' | 'verified' | 'rejected'; status: 'new' | 'saved' | 'ignored';
  analysis: string; application_hint: string; is_demo: boolean;
};
type Source = { id: string; name: string; platform: string; kind: 'manual' | 'api'; url: string | null; status: string; last_sync_at: string | null };
type IdeaRes = { saved: { id: string; title: string; total: number }[]; duplicates: { title: string; of: string; similarity: number }[]; meta: { demo: boolean } };

const STATUS_L: Record<string, string> = { new: 'Mới', saved: 'Đã lưu', ignored: 'Đã bỏ qua' };
const VERIF_L: Record<string, string> = { unverified: 'Chưa xác minh', verified: 'Đã xác minh', rejected: 'Bị bác bỏ' };
const VERIF_TONE: Record<string, string> = { unverified: 'amber', verified: 'green', rejected: 'red' };
const RELI_L: Record<string, string> = { unverified: 'Chưa rõ', low: 'Thấp', medium: 'Trung bình', high: 'Cao' };
const SRC_STATUS = (s: string) => (s === 'not_connected' ? 'chưa kết nối' : s === 'connected' ? 'đã kết nối' : s);

export default function TrendsPage() {
  const { confirm } = useUi();
  const { busy, run } = useAction();
  const [f, setF] = useState({ platform: '', status: '', verification_status: '', language: '', country: '', q: '' });
  const path = useMemo(() => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v.trim()) p.set(k, v.trim()); return `/trends${p.size ? `?${p}` : ''}`; }, [f]);
  const { data, error, loading, reload } = useApi<{ items: Trend[]; sources: Source[] }>(path);

  const [addOpen, setAddOpen] = useState(false);
  const blank = { title: '', platform: 'tiktok', url: '', published_at: '', keywords: '', reason: '', country: '', language: '', reliability: 'unverified', verification_status: 'unverified' };
  const [nf, setNf] = useState(blank);
  const [pairs, setPairs] = useState<{ k: string; v: string }[]>([{ k: '', v: '' }]);
  const [ideaRes, setIdeaRes] = useState<{ title: string; r: IdeaRes } | null>(null);

  const submit = () => run('add', async () => {
    const metrics: Record<string, string | number> = {};
    for (const p of pairs) if (p.k.trim() && p.v.trim()) metrics[p.k.trim()] = p.v.trim() !== '' && !Number.isNaN(Number(p.v)) ? Number(p.v) : p.v.trim();
    await api('/trends', { body: {
      title: nf.title.trim(), platform: nf.platform, url: nf.url.trim() || null, published_at: nf.published_at || null, country: nf.country.trim() || null, language: nf.language.trim() || null,
      keywords: nf.keywords.split(',').map((s) => s.trim()).filter(Boolean), reason: nf.reason.trim(), metrics, reliability: nf.reliability, verification_status: nf.verification_status,
    } });
    setAddOpen(false); setNf(blank); setPairs([{ k: '', v: '' }]); reload();
  }, 'Đã thêm xu hướng');

  const patch = (t: Trend, body: Record<string, string>, ok: string) => run('p' + t.id, async () => { await api(`/trends/${t.id}`, { method: 'PATCH', body }); reload(); }, ok);
  const analyze = (t: Trend) => run('a' + t.id, async () => { await api(`/trends/${t.id}/analyze`, { body: {} }); reload(); }, 'Đã phân tích xu hướng');
  const idea = (t: Trend) => run('i' + t.id, async () => { const r = await api<IdeaRes>(`/trends/${t.id}/idea`, { body: {} }); setIdeaRes({ title: t.title, r }); });
  const del = async (t: Trend) => {
    if (!(await confirm({ title: 'Xoá xu hướng?', body: `Xoá “${t.title}”.`, danger: true, confirmLabel: 'Xoá' }))) return;
    run('d' + t.id, async () => { await api(`/trends/${t.id}`, { method: 'DELETE' }); reload(); }, 'Đã xoá');
  };

  const items = data?.items ?? [];
  const sources = data?.sources ?? [];
  const hasFilter = Object.values(f).some((v) => v);
  const sel = (k: keyof typeof f) => ({ value: f[k], onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });

  return (
    <div>
      <PageHeader title="Radar xu hướng" desc="Danh sách xu hướng do bạn tự nhập và đánh giá. Phân tích AI chỉ là gợi ý — cần tự kiểm chứng trước khi áp dụng."
        actions={<Button variant="primary" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" />Thêm xu hướng thủ công</Button>} />

      <Notice tone="amber">
        Hệ thống <b>KHÔNG tự động thu thập</b> dữ liệu từ Facebook, TikTok, YouTube hay Google Trends (chưa có tích hợp API chính thức). Mọi xu hướng ở đây là <b>nhập thủ công</b>; số liệu do bạn tự nhập và tự chịu trách nhiệm về nguồn.
      </Notice>

      <Card title="Trạng thái nguồn dữ liệu" className="mt-4">
        {loading && !data ? <Spinner /> : sources.length ? (
          <ul className="divide-y divide-line text-sm">
            {sources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><b>{s.name}</b> <span className="text-muted">· {PLATFORM_LABEL[s.platform] ?? s.platform} · {s.kind === 'manual' ? 'nhập thủ công' : 'API'}</span></span>
                <span className="flex items-center gap-2"><Badge tone={s.status === 'connected' ? 'green' : s.kind === 'manual' ? 'blue' : 'gray'}>{s.kind === 'manual' && s.status === 'not_connected' ? 'nhập thủ công' : SRC_STATUS(s.status)}</Badge><span className="text-xs text-muted">đồng bộ gần nhất: {fmtDateTime(s.last_sync_at)}</span></span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted">Chưa có nguồn nào được khai báo — mọi nguồn tự động đều <b>chưa kết nối</b>.</p>}
      </Card>

      <div className="my-4 grid grid-cols-2 gap-2 md:grid-cols-6">
        <Input aria-label="Tìm tiêu đề" className="col-span-2" placeholder="Tìm tiêu đề…" {...sel('q')} />
        <Select aria-label="Nền tảng" {...sel('platform')}><option value="">Mọi nền tảng</option>{Object.entries(PLATFORM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select aria-label="Trạng thái" {...sel('status')}><option value="">Mọi trạng thái</option>{Object.entries(STATUS_L).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select aria-label="Xác minh" {...sel('verification_status')}><option value="">Mọi xác minh</option>{Object.entries(VERIF_L).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Input aria-label="Ngôn ngữ" placeholder="Ngôn ngữ (vi, en…)" {...sel('language')} />
        <Input aria-label="Quốc gia" placeholder="Quốc gia (VN, US…)" {...sel('country')} />
        {hasFilter && <Button variant="ghost" onClick={() => setF({ platform: '', status: '', verification_status: '', language: '', country: '', q: '' })}>Xoá lọc</Button>}
      </div>

      <ErrorNote message={error} />
      {loading && !data && <Spinner />}
      {data && items.length === 0 && <Empty title={hasFilter ? 'Không có xu hướng khớp bộ lọc' : 'Chưa có xu hướng nào'} hint="Bấm “Thêm xu hướng thủ công” để ghi lại xu hướng bạn quan sát được." />}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map((t) => (
          <article key={t.id} className="flex flex-col rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="blue">{PLATFORM_LABEL[t.platform] ?? t.platform}</Badge><Badge tone={t.status === 'saved' ? 'green' : t.status === 'ignored' ? 'gray' : 'amber'}>{STATUS_L[t.status]}</Badge>
              <Badge tone={VERIF_TONE[t.verification_status]}>{VERIF_L[t.verification_status]}</Badge><DemoBadge show={t.is_demo} />
            </div>
            <h3 className="mt-2 break-words font-semibold">{t.title}</h3>
            {t.url && <a href={t.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 break-all text-xs text-brand underline"><ExternalLink className="h-3 w-3 shrink-0" />{t.url}</a>}
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <div><dt className="text-muted">Ngày xuất bản</dt><dd>{fmtDate(t.published_at)}</dd></div>
              <div><dt className="text-muted">Ngày thu thập</dt><dd>{fmtDate(t.collected_at)}</dd></div>
              <div><dt className="text-muted">Độ tin cậy (tự đánh giá)</dt><dd>{RELI_L[t.reliability] ?? t.reliability}</dd></div>
              <div><dt className="text-muted">Quốc gia / ngôn ngữ</dt><dd>{[t.country, t.language].filter(Boolean).join(' / ') || '—'}</dd></div>
            </dl>
            {t.reason && <p className="mt-2 text-sm"><span className="text-xs text-muted">Lý do đáng chú ý: </span>{t.reason}</p>}
            {t.keywords.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{t.keywords.map((k) => <Badge key={k}>{k}</Badge>)}</div>}
            {Object.keys(t.metrics ?? {}).length > 0 && (
              <div className="mt-2 rounded-lg bg-surface2 p-2 text-xs"><p className="mb-1 text-muted">Số liệu bạn tự nhập (chưa được hệ thống kiểm chứng)</p>
                <ul className="grid grid-cols-2 gap-x-3">{Object.entries(t.metrics).map(([k, v]) => <li key={k} className="flex justify-between gap-2"><span className="truncate">{k}</span><b className="tabular-nums">{String(v)}</b></li>)}</ul></div>
            )}
            {(t.analysis || t.application_hint) && (
              <div className="mt-2 space-y-1 rounded-lg border border-line p-2 text-sm">
                <p className="text-xs font-medium text-muted">Phân tích AI {t.relevance_score != null && <>· độ phù hợp <b>{t.relevance_score}/100</b> (ước tính AI)</>}</p>
                {t.analysis && <p>{t.analysis}</p>}
                {t.application_hint && <p><span className="text-xs text-muted">Gợi ý áp dụng: </span>{t.application_hint}</p>}
              </div>
            )}
            <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
              <Button size="sm" variant={t.status === 'saved' ? 'primary' : 'secondary'} disabled={!!busy} onClick={() => patch(t, { status: 'saved' }, 'Đã lưu')}>Lưu</Button>
              <Button size="sm" disabled={!!busy} onClick={() => patch(t, { status: 'ignored' }, 'Đã bỏ qua')}>Bỏ qua</Button>
              <Button size="sm" disabled={!!busy || t.verification_status === 'verified'} onClick={() => patch(t, { verification_status: 'verified' }, 'Đã đánh dấu xác minh')}>Đã xác minh</Button>
              <Button size="sm" variant="primary" busy={busy === 'a' + t.id} disabled={!!busy && busy !== 'a' + t.id} onClick={() => analyze(t)}>Phân tích AI</Button>
              <Button size="sm" variant="gold" busy={busy === 'i' + t.id} disabled={!!busy && busy !== 'i' + t.id} onClick={() => idea(t)}>Tạo ý tưởng</Button>
              <Button size="sm" variant="ghost" aria-label="Xoá" disabled={!!busy} onClick={() => del(t)}><Trash2 className="h-4 w-4 text-danger" /></Button>
            </div>
          </article>
        ))}
      </div>

      <Modal open={!!ideaRes} onClose={() => setIdeaRes(null)} title="Ý tưởng từ xu hướng">
        {ideaRes && (
          <div className="space-y-2 text-sm">
            <p className="flex flex-wrap items-center gap-2">Từ “{ideaRes.title}”: đã lưu <b>{ideaRes.r.saved.length}</b> ý tưởng · loại {ideaRes.r.duplicates.length} do trùng <DemoBadge show={ideaRes.r.meta?.demo} /></p>
            {ideaRes.r.saved.length > 0 && <ul className="list-disc pl-5">{ideaRes.r.saved.map((s) => <li key={s.id}>{s.title} <span className="text-xs text-muted">({s.total}/100, ước tính AI)</span></li>)}</ul>}
            {ideaRes.r.duplicates.length > 0 && <ul className="list-disc pl-5 text-xs text-muted">{ideaRes.r.duplicates.map((d, i) => <li key={i}>“{d.title}” trùng “{d.of}” ({Math.round(d.similarity * 100)}%)</li>)}</ul>}
            <Link href="/ideas" className="inline-block text-brand underline">Mở ngân hàng ý tưởng →</Link>
          </div>
        )}
      </Modal>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Thêm xu hướng thủ công" wide
        footer={<><Button onClick={() => setAddOpen(false)}>Huỷ</Button><Button variant="primary" busy={busy === 'add'} disabled={!nf.title.trim()} onClick={submit}>Lưu xu hướng</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tiêu đề *" className="sm:col-span-2"><Input value={nf.title} onChange={(e) => setNf({ ...nf, title: e.target.value })} maxLength={300} autoFocus /></Field>
          <Field label="Nền tảng"><Select value={nf.platform} onChange={(e) => setNf({ ...nf, platform: e.target.value })}>{Object.entries(PLATFORM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Ngày xuất bản"><Input type="date" value={nf.published_at} onChange={(e) => setNf({ ...nf, published_at: e.target.value })} /></Field>
          <Field label="URL nguồn" className="sm:col-span-2"><Input type="url" placeholder="https://…" value={nf.url} onChange={(e) => setNf({ ...nf, url: e.target.value })} /></Field>
          <Field label="Quốc gia"><Input value={nf.country} onChange={(e) => setNf({ ...nf, country: e.target.value })} placeholder="VN" maxLength={10} /></Field>
          <Field label="Ngôn ngữ"><Input value={nf.language} onChange={(e) => setNf({ ...nf, language: e.target.value })} placeholder="vi" maxLength={10} /></Field>
          <Field label="Từ khoá (phân tách bằng dấu phẩy)" className="sm:col-span-2"><Input value={nf.keywords} onChange={(e) => setNf({ ...nf, keywords: e.target.value })} /></Field>
          <Field label="Lý do đáng chú ý" className="sm:col-span-2"><Textarea value={nf.reason} onChange={(e) => setNf({ ...nf, reason: e.target.value })} maxLength={2000} /></Field>
          <div className="sm:col-span-2">
            <p className="mb-1 text-xs font-medium text-muted">Số liệu tự nhập (tên — giá trị), ví dụ “Lượt xem — 120000”</p>
            <div className="space-y-2">
              {pairs.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <Input aria-label="Tên số liệu" placeholder="Tên" value={p.k} onChange={(e) => setPairs(pairs.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
                  <Input aria-label="Giá trị" placeholder="Giá trị" value={p.v} onChange={(e) => setPairs(pairs.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
                  <Button aria-label="Bỏ dòng" variant="ghost" onClick={() => setPairs(pairs.length > 1 ? pairs.filter((_, j) => j !== i) : [{ k: '', v: '' }])}>×</Button>
                </div>
              ))}
              <Button size="sm" onClick={() => setPairs([...pairs, { k: '', v: '' }])} disabled={pairs.length >= 12}>+ Thêm số liệu</Button>
            </div>
          </div>
          <Field label="Độ tin cậy của nguồn (tự đánh giá)"><Select value={nf.reliability} onChange={(e) => setNf({ ...nf, reliability: e.target.value })}>{Object.entries(RELI_L).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Trạng thái xác minh"><Select value={nf.verification_status} onChange={(e) => setNf({ ...nf, verification_status: e.target.value })}>{Object.entries(VERIF_L).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        </div>
      </Modal>
    </div>
  );
}

'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api, fmtDateTime, useApi } from '@/lib/client';
import { Badge, Button, Card, CopyButton, DemoBadge, Empty, ErrorNote, Field, Input, Notice, PageHeader, Select, Spinner, Textarea, clsx, useAction, useUi } from '@/components/ui';
import { CopyBlock } from '@/components/lv-research-bits';

type Result = {
  topic: string; audience: string; hook: string; structure: string[]; conflict: string; curiosity: string; emotion: string;
  pacing?: string | null; camera?: string | null; lighting?: string | null; audio?: string | null; on_screen_text?: string | null; cta: string;
  retention_formula: string; reusable_formula: string; template: string; not_observed: string[]; ideas: { title: string; summary: string }[]; script: string; production_guide: string;
  meta?: { demo: boolean; provider: string };
};
type Decode = { id: string; title: string; source_type: string; source_url: string | null; input_text?: string; observed_visuals: boolean; result?: Result; is_demo: boolean; created_at: string };
type IdeaRes = { saved: { id: string; title: string; total: number }[]; duplicates: { title: string; of: string; similarity: number }[] };

const SRC: Record<string, string> = { url: 'Link tham chiếu + nội dung bạn dán', transcript: 'Transcript (lời thoại)', post_text: 'Nội dung bài viết', screenshot_note: 'Mô tả ảnh chụp màn hình' };
const NO_OBS = 'Không quan sát được';

export default function ViralPage() {
  const { toast } = useUi();
  const { busy, run } = useAction();
  const list = useApi<{ items: Decode[] }>('/viral-decodes');
  const [f, setF] = useState({ title: '', source_type: 'transcript', source_url: '', input_text: '', observed_visuals: false });
  const [cur, setCur] = useState<Decode | null>(null);
  const [ideaRes, setIdeaRes] = useState<IdeaRes | null>(null);

  const submit = () => {
    if (f.title.trim().length < 1) return toast('Nhập tiêu đề', 'err');
    if (f.input_text.trim().length < 20) return toast('Cần dán transcript/nội dung tối thiểu 20 ký tự', 'err');
    run('decode', async () => {
      const r = await api<Decode>('/viral-decodes', { body: { title: f.title.trim(), source_type: f.source_type, source_url: f.source_url.trim() || null, input_text: f.input_text, observed_visuals: f.observed_visuals } });
      setCur(r); setIdeaRes(null); list.reload();
    }, 'Đã giải mã');
  };
  const load = (id: string) => run('load' + id, async () => { setCur(await api<Decode>(`/viral-decodes/${id}`)); setIdeaRes(null); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  const saveIdeas = () => cur && run('ideas', async () => { setIdeaRes(await api<IdeaRes>(`/viral-decodes/${cur.id}/ideas`, { body: {} })); });

  const r = cur?.result;
  const visual = (v?: string | null) => {
    if (!v || !v.trim()) return null;
    return v;
  };
  const visualBlock = (label: string, v?: string | null) => {
    const t = visual(v);
    if (!t) return <CopyBlock key={label} label={label}><p className="text-sm text-muted">{NO_OBS}</p></CopyBlock>;
    return <CopyBlock key={label} label={label} text={t}>
      {!cur?.observed_visuals && <p className="mb-1 text-xs text-warn">Bạn không đánh dấu đã mô tả hình ảnh — nội dung này có thể là AI suy đoán, hãy kiểm chứng.</p>}
      <p className="whitespace-pre-wrap text-sm">{t}</p>
    </CopyBlock>;
  };

  return (
    <div>
      <PageHeader title="Giải mã video viral" desc="Phân tích cấu trúc của một nội dung đang chạy tốt từ văn bản bạn cung cấp, rồi tạo ý tưởng phiên bản Ly Vân." />
      <div className="space-y-2">
        <Notice tone="amber">Hệ thống <b>KHÔNG tải hoặc xem video</b> từ URL. Chỉ phân tích <b>văn bản bạn dán vào</b>. Nếu chỉ có transcript, các mục góc quay / ánh sáng / hình ảnh sẽ hiện “{NO_OBS}” và không được suy đoán.</Notice>
        <Notice tone="blue">Chỉ học cấu trúc và công thức. <b>Không sao chép nguyên văn</b> nội dung có bản quyền. Nội dung dán vào có thể được gửi tới dịch vụ AI bên ngoài (đã ẩn SĐT/email), đừng dán dữ liệu riêng tư của khách hàng.</Notice>
      </div>

      <Card title="Giải mã nội dung mới" className="mt-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tiêu đề (đặt tên để tìm lại) *"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={200} /></Field>
          <Field label="Loại nguồn"><Select value={f.source_type} onChange={(e) => setF({ ...f, source_type: e.target.value })}>{Object.entries(SRC).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="URL tham chiếu (chỉ để ghi nguồn, không được truy cập)" className="sm:col-span-2"><Input type="url" placeholder="https://…" value={f.source_url} onChange={(e) => setF({ ...f, source_url: e.target.value })} /></Field>
          <Field label="Dán transcript / nội dung (tối thiểu 20 ký tự) *" hint={`${f.input_text.length}/30000 ký tự`} className="sm:col-span-2"><Textarea className="min-h-40" value={f.input_text} maxLength={30000} onChange={(e) => setF({ ...f, input_text: e.target.value })} /></Field>
          <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" className="mt-1 h-4 w-4" checked={f.observed_visuals} onChange={(e) => setF({ ...f, observed_visuals: e.target.checked })} /><span>Tôi đã mô tả hình ảnh quan sát được trong nội dung dán ở trên (góc quay, ánh sáng, chữ trên màn hình…). Không tích nếu chỉ có lời thoại.</span></label>
        </div>
        <div className="mt-4"><Button variant="primary" size="lg" busy={busy === 'decode'} onClick={submit}>Giải mã</Button></div>
        {busy === 'decode' && <Spinner label="AI đang phân tích văn bản…" />}
      </Card>

      {cur && r && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{cur.title}</h2><DemoBadge show={cur.is_demo} /><Badge>{SRC[cur.source_type]}</Badge><Badge tone={cur.observed_visuals ? 'green' : 'gray'}>{cur.observed_visuals ? 'Có mô tả hình ảnh' : 'Chỉ có văn bản'}</Badge>
            {cur.source_url && <a className="break-all text-xs text-brand underline" href={cur.source_url} target="_blank" rel="noopener noreferrer">{cur.source_url}</a>}
          </div>
          {cur.is_demo && <Notice tone="amber">Chế độ demo: báo cáo bên dưới là dữ liệu mẫu, không phản ánh nội dung bạn dán.</Notice>}

          <div className="grid gap-3 md:grid-cols-2">
            <CopyBlock label="Chủ đề" text={r.topic} /><CopyBlock label="Đối tượng" text={r.audience} />
            <CopyBlock label="Hook mở đầu" text={r.hook} /><CopyBlock label="Mâu thuẫn" text={r.conflict} />
            <CopyBlock label="Yếu tố gây tò mò" text={r.curiosity} /><CopyBlock label="Cảm xúc" text={r.emotion} />
            <CopyBlock label="Cấu trúc" text={(r.structure ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n')}>
              {r.structure?.length ? <ol className="list-decimal space-y-1 pl-5 text-sm">{r.structure.map((s, i) => <li key={i}>{s}</li>)}</ol> : <p className="text-sm">—</p>}
            </CopyBlock>
            {visualBlock('Nhịp (pacing)', r.pacing)}
            {visualBlock('Máy quay / góc quay', r.camera)}{visualBlock('Ánh sáng', r.lighting)}
            {visualBlock('Âm thanh', r.audio)}{visualBlock('Chữ trên màn hình', r.on_screen_text)}
            <CopyBlock label="Lời kêu gọi (CTA)" text={r.cta} />
            <CopyBlock label="Công thức giữ chân" text={r.retention_formula} /><CopyBlock label="Công thức tái sử dụng" text={r.reusable_formula} />
            <CopyBlock label="Template" text={r.template} />
          </div>

          {r.not_observed?.length > 0 && (
            <Card title="Không quan sát được từ dữ liệu bạn cung cấp (không suy đoán)">
              <ul className="list-disc space-y-1 pl-5 text-sm">{r.not_observed.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </Card>
          )}

          <Card title="5 ý tưởng phiên bản Ly Vân" actions={<Button variant="primary" size="sm" busy={busy === 'ideas'} onClick={saveIdeas}>Lưu vào ngân hàng ý tưởng</Button>}>
            <ul className="space-y-2">
              {r.ideas.map((i, k) => <li key={k} className="rounded-lg border border-line p-3"><div className="flex items-start justify-between gap-2"><p className="font-medium">{k + 1}. {i.title}</p><CopyButton text={`${i.title}\n${i.summary}`} /></div><p className="mt-1 text-sm text-muted">{i.summary || '—'}</p></li>)}
            </ul>
            {ideaRes && (
              <div className="mt-3 rounded-lg bg-surface2 p-3 text-sm">
                <p>Đã lưu <b>{ideaRes.saved.length}</b> ý tưởng · loại {ideaRes.duplicates.length} do trùng. Điểm mặc định chưa phải đánh giá — hãy chấm lại trong ngân hàng ý tưởng.</p>
                {ideaRes.duplicates.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-muted">{ideaRes.duplicates.map((d, i) => <li key={i}>“{d.title}” trùng “{d.of}” ({Math.round(d.similarity * 100)}%)</li>)}</ul>}
                <Link className="mt-1 inline-block text-brand underline" href="/ideas">Mở ngân hàng ý tưởng →</Link>
              </div>
            )}
          </Card>

          <div className="grid gap-3 md:grid-cols-2">
            <CopyBlock label="Kịch bản" text={r.script} /><CopyBlock label="Hướng dẫn sản xuất" text={r.production_guide} />
          </div>
        </div>
      )}

      <Card title="Các lần giải mã trước" className="mt-4">
        <ErrorNote message={list.error} />
        {list.loading && !list.data && <Spinner />}
        {list.data && list.data.items.length === 0 && <Empty title="Chưa có lần giải mã nào" />}
        <ul className="divide-y divide-line">
          {list.data?.items.map((d) => (
            <li key={d.id} className={clsx('flex flex-wrap items-center justify-between gap-2 py-2', cur?.id === d.id && 'bg-brand/5')}>
              <div className="min-w-0"><p className="truncate text-sm font-medium">{d.title} <DemoBadge show={d.is_demo} /></p><p className="text-xs text-muted">{SRC[d.source_type]} · {fmtDateTime(d.created_at)}</p></div>
              <Button size="sm" busy={busy === 'load' + d.id} onClick={() => load(d.id)}>Xem</Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

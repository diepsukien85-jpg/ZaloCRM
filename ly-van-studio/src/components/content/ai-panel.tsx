'use client';
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '@/lib/client';
import { Button, Card, DemoBadge, Input, Notice, useAction } from '@/components/ui';

type Proposal = { text: string; hooks: string[]; note: string; meta: { demo: boolean; provider?: string; model?: string } };

const QUICK: { label: string; instruction: string }[] = [
  { label: 'Rút gọn', instruction: 'Rút gọn nội dung còn khoảng 60%, giữ ý chính và giọng văn' },
  { label: 'Mở rộng', instruction: 'Mở rộng nội dung với ví dụ cụ thể và chi tiết thật, không bịa số liệu' },
  { label: 'Thay hook', instruction: 'Viết lại phần hook mở đầu hấp dẫn hơn và đề xuất 3 hook khác' },
  { label: 'Thân mật hơn', instruction: 'Đổi giọng văn thân mật, gần gũi hơn' },
  { label: 'Chuyên nghiệp hơn', instruction: 'Đổi giọng văn chuyên nghiệp, đáng tin hơn' },
  { label: 'Thêm CTA', instruction: 'Thêm lời kêu gọi hành động (CTA) tự nhiên ở cuối bài' },
];

/** Panel AI chỉnh sửa: chỉ trả ĐỀ XUẤT — người dùng bấm Áp dụng mới đưa vào editor. */
export function AiPanel({ contentId, body, disabled, onApplyBody, onApplyHooks }: {
  contentId: string; body: string; disabled?: boolean; onApplyBody: (t: string) => void; onApplyHooks: (h: string[]) => void;
}) {
  const [custom, setCustom] = useState('');
  const [prop, setProp] = useState<Proposal | null>(null);
  const { busy, run } = useAction();

  const ask = (instruction: string) => run('rewrite', async () => {
    const r = await api<Proposal>(`/contents/${contentId}/rewrite`, { body: { instruction, text: body } });
    setProp(r);
  });

  return (
    <Card title={<span className="inline-flex items-center gap-1.5"><Sparkles className="h-4 w-4 text-gold" aria-hidden />AI chỉnh sửa</span>}>
      <p className="mb-2 text-xs text-muted">AI chỉ đưa ra đề xuất cho thân bài hiện tại. Nội dung chỉ thay đổi khi bạn bấm “Áp dụng”.</p>
      <div className="flex flex-wrap gap-1.5">
        {QUICK.map((q) => <Button key={q.label} size="sm" disabled={disabled || !body.trim() || !!busy} busy={busy === 'rewrite'} onClick={() => ask(q.instruction)}>{q.label}</Button>)}
      </div>
      <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (custom.trim().length >= 2) void ask(custom.trim()); }}>
        <Input aria-label="Chỉ thị tuỳ chỉnh" placeholder="Chỉ thị riêng, ví dụ: thêm câu chuyện nhỏ ở đầu" value={custom} onChange={(e) => setCustom(e.target.value)} maxLength={500} />
        <Button type="submit" variant="primary" disabled={disabled || custom.trim().length < 2 || !body.trim() || !!busy}>Gửi</Button>
      </form>
      {busy === 'rewrite' && <p className="mt-2 text-xs text-muted" role="status">AI đang viết đề xuất…</p>}
      {prop && (
        <div className="mt-3 space-y-2 rounded-lg border border-line bg-surface2/50 p-3">
          <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">Đề xuất</span><DemoBadge show={prop.meta?.demo} /></div>
          {prop.meta?.demo && <Notice tone="amber">Chế độ DEMO: chưa có khoá AI thật, đây là nội dung mẫu để thử luồng, không phải kết quả AI.</Notice>}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-2 text-sm font-sans">{prop.text}</pre>
          {prop.hooks.length > 0 && <div><p className="text-xs font-medium text-muted">Hook đề xuất</p><ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">{prop.hooks.map((h, i) => <li key={i}>{h}</li>)}</ol></div>}
          {prop.note && <p className="text-xs text-muted">{prop.note}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => { onApplyBody(prop.text); setProp(null); }}>Áp dụng vào thân bài</Button>
            {prop.hooks.length > 0 && <Button size="sm" onClick={() => { onApplyHooks(prop.hooks); setProp(null); }}>Thay danh sách hook</Button>}
            <Button size="sm" variant="ghost" onClick={() => setProp(null)}>Bỏ đề xuất</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

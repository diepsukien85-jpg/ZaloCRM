'use client';
import { useState } from 'react';
import { api, PLATFORM_LABEL } from '@/lib/client';
import { Button, Card, CopyButton, DemoBadge, Empty, Field, Input, Notice, Textarea, useAction } from '@/components/ui';

export type Variant = { id: string; platform: string; title: string; hook: string; caption: string; hashtags: string[]; aspect_ratio: string | null; duration_sec: number | null; cta: string; body: string; is_demo: boolean };

const PLATFORMS = ['facebook_profile', 'facebook_page', 'facebook_reels', 'tiktok', 'youtube_shorts', 'youtube_long'] as const;
const parseTags = (s: string) => s.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);

function variantText(v: { title: string; hook: string; body: string; caption: string; hashtags: string[]; cta: string }) {
  return [v.title, v.hook, v.body, v.caption, v.hashtags.join(' '), v.cta].filter((x) => x && x.trim()).join('\n\n');
}

function VariantCard({ contentId, v, readOnly, onSaved }: { contentId: string; v: Variant; readOnly: boolean; onSaved: () => void }) {
  const [f, setF] = useState({ title: v.title, hook: v.hook, body: v.body, caption: v.caption, hashtags: v.hashtags.join(' '), cta: v.cta });
  const [base, setBase] = useState(JSON.stringify(f));
  const { busy, run } = useAction();
  const dirty = JSON.stringify(f) !== base;
  const tags = parseTags(f.hashtags);
  const save = () => run('save', async () => {
    await api(`/contents/${contentId}/variants/${v.platform}`, { method: 'PATCH', body: { title: f.title, hook: f.hook, body: f.body, caption: f.caption, hashtags: tags, cta: f.cta } });
    setBase(JSON.stringify(f)); onSaved();
  }, 'Đã lưu biến thể');
  const parts: [string, string][] = [['Hook', f.hook], ['Nội dung', f.body], ['Caption', f.caption], ['Hashtag', tags.join(' ')], ['CTA', f.cta]];
  return (
    <Card title={<span className="flex flex-wrap items-center gap-2">{PLATFORM_LABEL[v.platform] ?? v.platform}<DemoBadge show={v.is_demo} /><span className="text-xs font-normal text-muted">{v.aspect_ratio ?? ''}{v.duration_sec ? ` · ${v.duration_sec}s` : ''}</span></span>}
      actions={<><CopyButton text={variantText({ ...f, hashtags: tags })} label="Sao chép cả biến thể" /><Button size="sm" variant="primary" disabled={!dirty || readOnly} busy={busy === 'save'} onClick={save}>{dirty ? 'Lưu biến thể' : 'Đã lưu'}</Button></>}>
      <div className="space-y-3">
        <Field label="Tiêu đề"><Input value={f.title} disabled={readOnly} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Hook"><Input value={f.hook} disabled={readOnly} onChange={(e) => setF({ ...f, hook: e.target.value })} /></Field>
        <Field label="Nội dung"><Textarea value={f.body} disabled={readOnly} className="min-h-40" onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        <Field label="Caption"><Textarea value={f.caption} disabled={readOnly} onChange={(e) => setF({ ...f, caption: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Hashtag (cách nhau bằng dấu cách)"><Input value={f.hashtags} disabled={readOnly} onChange={(e) => setF({ ...f, hashtags: e.target.value })} /></Field>
          <Field label="CTA"><Input value={f.cta} disabled={readOnly} onChange={(e) => setF({ ...f, cta: e.target.value })} /></Field>
        </div>
        <div className="flex flex-wrap gap-1.5"><span className="self-center text-xs text-muted">Sao chép từng phần:</span>{parts.map(([l, t]) => t.trim() ? <CopyButton key={l} text={t} label={l} /> : null)}</div>
      </div>
    </Card>
  );
}

export function VariantsPanel({ contentId, variants, readOnly, onChanged }: { contentId: string; variants: Variant[]; readOnly: boolean; onChanged: () => void }) {
  const [sel, setSel] = useState<string[]>([]);
  const { busy, run } = useAction();
  const toggle = (p: string) => setSel((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]));
  const make = () => run('variants', async () => {
    await api(`/contents/${contentId}/variants`, { body: { platforms: sel } });
    setSel([]); onChanged();
  }, 'Đã tạo biến thể');
  return (
    <div className="space-y-4">
      <Card title="Tạo biến thể theo nền tảng">
        <p className="mb-2 text-xs text-muted">Biến thể là bản chuyển thể của cùng một nội dung gốc (không tính vào KPI nội dung gốc). Tạo lại nền tảng đã có sẽ ghi đè biến thể đó.</p>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {PLATFORMS.map((p) => (
            <label key={p} className="flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface2">
              <input type="checkbox" checked={sel.includes(p)} onChange={() => toggle(p)} />{PLATFORM_LABEL[p]}{variants.some((v) => v.platform === p) && <span className="ml-auto text-xs text-muted">đã có</span>}
            </label>
          ))}
        </div>
        {sel.some((p) => variants.some((v) => v.platform === p)) && <div className="mt-2"><Notice tone="amber">Biến thể đã có của nền tảng được chọn sẽ bị ghi đè, kể cả phần bạn đã sửa tay.</Notice></div>}
        <div className="mt-3"><Button variant="primary" disabled={!sel.length || readOnly} busy={busy === 'variants'} onClick={make}>Tạo {sel.length ? `${sel.length} ` : ''}biến thể</Button></div>
      </Card>
      {variants.length === 0 ? <Empty title="Chưa có biến thể" hint="Chọn nền tảng ở trên rồi bấm Tạo biến thể." /> : variants.map((v) => <VariantCard key={`${v.platform}-${v.id}-${v.body.length}-${v.title}`} contentId={contentId} v={v} readOnly={readOnly} onSaved={onChanged} />)}
    </div>
  );
}

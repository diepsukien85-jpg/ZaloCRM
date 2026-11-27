'use client';
import { useMemo, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { api } from '@/lib/client';
import { Badge, Button, Card, CopyButton, DemoBadge, Empty, Notice, Textarea, useAction, useUi, clsx } from '@/components/ui';
import type { Project, Scene } from './types';

const snap = (sec: number) => [4, 6, 8, 10].reduce((b, d) => (Math.abs(d - sec) < Math.abs(b - sec) ? d : b), 4);

function Block({ label, text }: { label: string; text?: string | null }) {
  if (!text) return null;
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="mb-1 flex items-center justify-between gap-2"><p className="text-xs font-medium text-muted">{label}</p><CopyButton text={text} /></div>
      <p className="whitespace-pre-wrap break-words text-sm">{text}</p>
    </div>
  );
}

export function ScriptPanel({ project }: { project: Project }) {
  const s = project.script;
  if (!s) return <Empty title="Dự án này chưa có kịch bản AI" hint="Kịch bản (hook, caption, hashtag, CTA…) được lưu khi dự án được tạo từ workflow Daily Agent. Dự án tạo thủ công chỉ có storyboard." />;
  const all = [
    s.title && `Tiêu đề: ${s.title}`, s.hooks?.length && `Hook:\n${s.hooks.map((h, i) => `${i + 1}. ${h}`).join('\n')}`, s.audience && `Đối tượng: ${s.audience}`, s.problem && `Vấn đề: ${s.problem}`, s.desire && `Mong muốn: ${s.desire}`,
    s.caption && `Caption: ${s.caption}`, s.hashtags?.length && `Hashtag: ${s.hashtags.join(' ')}`, s.cta && `CTA: ${s.cta}`,
  ].filter(Boolean).join('\n\n');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2"><DemoBadge show={project.is_demo} />{project.is_demo && <span className="text-xs text-muted">Kịch bản mẫu, chưa phải do AI thật sinh ra.</span>}<span className="ml-auto"><CopyButton text={all} label="Sao chép toàn bộ kịch bản" /></span></div>
      <div className="grid gap-3 md:grid-cols-2">
        <Block label="Từ khoá chính" text={s.main_keyword} /><Block label="Đối tượng" text={s.audience} />
        <Block label="Vấn đề" text={s.problem} /><Block label="Mong muốn" text={s.desire} />
      </div>
      {!!s.hooks?.length && (
        <Card title="Hook">
          <ol className="space-y-2 text-sm">{s.hooks.map((h, i) => <li key={i} className="flex items-start justify-between gap-2"><span className="min-w-0 break-words"><span className="mr-1 text-muted">{i + 1}.</span>{h}</span><CopyButton text={h} /></li>)}</ol>
        </Card>
      )}
      <Block label="Caption" text={s.caption} />
      {!!s.hashtags?.length && <Block label="Hashtag" text={s.hashtags.join(' ')} />}
      <Block label="Lời kêu gọi hành động (CTA)" text={s.cta} />
      {s.youtube && (
        <Card title="YouTube">
          <div className="space-y-3">
            <div><p className="mb-1 text-xs font-medium text-muted">Tiêu đề đề xuất</p><ul className="space-y-1.5 text-sm">{s.youtube.titles.map((t, i) => <li key={i} className="flex items-start justify-between gap-2"><span className="break-words">{t}</span><CopyButton text={t} /></li>)}</ul></div>
            <Block label="Mô tả" text={s.youtube.description} />
            {!!s.youtube.chapters.length && <Block label="Chương (chapters)" text={s.youtube.chapters.map((c) => `${c.time} ${c.title}`).join('\n')} />}
          </div>
        </Card>
      )}
    </div>
  );
}

function PromptRow({ scene, projectId, onChanged, reload }: { scene: Scene; projectId: string; onChanged: (row: Scene) => void; reload: () => void }) {
  const { confirm } = useUi();
  const { busy, run } = useAction();
  const [text, setText] = useState(scene.prompt ?? '');
  const dirty = text !== (scene.prompt ?? '');
  const snapped = snap(scene.duration_sec);
  return (
    <div className="rounded-xl border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <h3 className="text-sm font-semibold">Cảnh {scene.scene_no}</h3>
        <Badge tone="gray">{scene.duration_sec}s</Badge>
        {scene.duration_sec !== snapped && <Badge tone="amber">Flow dùng mốc {snapped}s</Badge>}
        <div className="ml-auto flex flex-wrap gap-1.5">
          <CopyButton text={text} />
          <Button size="sm" busy={busy === 'regen'} onClick={async () => {
            if (dirty || scene.prompt) { if (!(await confirm({ title: `Tạo lại prompt cảnh ${scene.scene_no}?`, body: 'Prompt hiện tại (kể cả phần bạn đã sửa tay) sẽ bị thay bằng bản dựng tự động từ nội dung cảnh.', confirmLabel: 'Tạo lại' }))) return; }
            await run('regen', async () => { await api(`/video/projects/${projectId}/prompts`, { body: { scene_id: scene.id } }); reload(); }, 'Đã tạo lại prompt');
          }}><RefreshCw className="h-3.5 w-3.5" />Tạo lại</Button>
        </div>
      </header>
      <div className="space-y-2 p-3">
        <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} className={clsx('font-mono text-xs', !text && 'border-warn')} placeholder="Chưa có prompt — bấm “Tạo lại”." />
        {dirty && <div className="flex gap-2"><Button size="sm" variant="primary" busy={busy === 'save'} onClick={() => run('save', async () => { const row = await api<Scene>(`/video/scenes/${scene.id}`, { method: 'PATCH', body: { prompt: text } }); onChanged(row); }, 'Đã lưu prompt')}>Lưu prompt sửa tay</Button><Button size="sm" onClick={() => setText(scene.prompt ?? '')}>Hoàn tác</Button></div>}
      </div>
    </div>
  );
}

export function PromptsPanel({ project, scenes, reload, onSceneSaved }: { project: Project; scenes: Scene[]; reload: () => void; onSceneSaved: (row: Scene) => void }) {
  const { confirm } = useUi();
  const { busy, run } = useAction();
  const sorted = useMemo(() => [...scenes].sort((a, b) => a.scene_no - b.scene_no), [scenes]);
  const all = sorted.map((s) => `# Cảnh ${s.scene_no} (${s.duration_sec}s)\n${s.prompt ?? ''}`).join('\n\n----------\n\n');
  return (
    <div className="space-y-3">
      <Notice tone="amber">
        <p className="font-medium">Chưa kết nối Google Flow — quy trình thủ công.</p>
        <p className="mt-1 text-xs">Hệ thống chỉ dựng sẵn prompt (xác định, không tốn AI) để bạn sao chép sang Google Flow, tự tạo clip ở đó rồi tải kết quả lên lại cho từng cảnh ở tab Storyboard. Hệ thống KHÔNG tự tạo video.</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
          <li>Google Flow thường tạo clip theo mốc 4s / 6s / 8s / 10s; thời lượng cảnh được làm tròn về mốc gần nhất khi dựng prompt.</li>
          <li>Tag nhân vật dạng <code>@ten</code> chỉ nên dùng khi bạn đã tạo đúng tag đó trong công cụ đích; nếu nhân vật không có tag, prompt dùng mô tả bằng chữ.</li>
          <li>Sửa nội dung cảnh xong cần bấm “Tạo lại” để prompt cập nhật theo.</li>
        </ul>
      </Notice>
      {project.is_demo && <div className="flex items-center gap-2 text-xs text-muted"><DemoBadge />Dự án mẫu — prompt dựng từ dữ liệu mẫu.</div>}
      {sorted.length === 0 ? <Empty title="Chưa có cảnh để dựng prompt" /> : (
        <>
          <div className="flex flex-wrap gap-2">
            <CopyButton size="md" text={all} label="Sao chép tất cả" />
            <Button busy={busy === 'all'} onClick={async () => {
              if (!(await confirm({ title: 'Tạo lại prompt cho tất cả cảnh?', body: 'Mọi prompt đã sửa tay sẽ bị thay bằng bản dựng tự động.', confirmLabel: 'Tạo lại tất cả', danger: true }))) return;
              await run('all', async () => { await api(`/video/projects/${project.id}/prompts`, { body: {} }); reload(); }, 'Đã tạo lại prompt cho toàn bộ cảnh');
            }}><RefreshCw className="h-4 w-4" />Tạo lại toàn bộ prompt</Button>
          </div>
          {sorted.map((s) => <PromptRow key={`${s.id}:${s.prompt ?? ''}`} scene={s} projectId={project.id} onChanged={onSceneSaved} reload={reload} />)}
        </>
      )}
    </div>
  );
}

const EXPORTS: { kind: string; label: string; desc: string }[] = [
  { kind: 'storyboard', label: 'Storyboard (.md)', desc: 'Toàn bộ cảnh, thoại, máy quay, ánh sáng… dạng Markdown.' },
  { kind: 'dialogue', label: 'Lời thoại (.txt)', desc: 'Thoại và voiceover theo từng cảnh.' },
  { kind: 'srt', label: 'Phụ đề (.srt)', desc: 'Phụ đề theo thời lượng từng cảnh (căn thời gian ước lượng).' },
  { kind: 'flow', label: 'Prompts Google Flow (.txt)', desc: 'Prompt mỗi cảnh, ngăn cách bằng dòng gạch.' },
  { kind: 'zip', label: 'Production package (.zip)', desc: 'Storyboard, thoại, prompt, SRT, project.json và file tư liệu đã gán cho cảnh.' },
];
export function ExportPanel({ projectId }: { projectId: string }) {
  return (
    <div className="space-y-3">
      <Notice tone="blue">Ghép video bằng FFmpeg chưa được triển khai. Gói sản xuất dùng để bạn tự dựng video bằng công cụ khác (CapCut, Premiere, Google Flow…).</Notice>
      <div className="grid gap-3 sm:grid-cols-2">
        {EXPORTS.map((x) => (
          <Card key={x.kind} title={x.label}>
            <p className="mb-3 text-sm text-muted">{x.desc}</p>
            <a href={`/api/video/projects/${projectId}/export?kind=${x.kind}`} download className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 text-sm font-medium text-white hover:opacity-90"><Download className="h-4 w-4" />Tải xuống</a>
          </Card>
        ))}
      </div>
    </div>
  );
}

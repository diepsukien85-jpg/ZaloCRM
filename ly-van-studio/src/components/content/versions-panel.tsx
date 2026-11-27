'use client';
import { useMemo, useState } from 'react';
import { fmtDateTime } from '@/lib/client';
import { Badge, Button, Card, Empty, Select, useUi } from '@/components/ui';
import { DiffView, lineDiff } from './diff';

export type Version = { version: number; title: string; body: string; hooks: string[]; caption: string; change_note: string; source: string; created_at: string; author: string | null };
const SRC: Record<string, string> = { manual: 'Lưu tay', autosave: 'Tự lưu', ai_generate: 'AI tạo', ai_rewrite: 'AI sửa', restore: 'Khôi phục' };

const flat = (v: Version) => `# ${v.title}\n\n[HOOK]\n${v.hooks.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n\n[THÂN BÀI]\n${v.body}\n\n[CAPTION]\n${v.caption}`;

export function VersionsPanel({ versions, current, readOnly, onRestore }: { versions: Version[]; current: number; readOnly: boolean; onRestore: (v: number) => Promise<void> }) {
  const { confirm } = useUi();
  const [a, setA] = useState<number | ''>('');
  const [b, setB] = useState<number | ''>('');
  const [busy, setBusy] = useState<number | null>(null);
  const va = versions.find((v) => v.version === a); const vb = versions.find((v) => v.version === b);
  const diff = useMemo(() => (va && vb ? lineDiff(flat(va), flat(vb)) : null), [va, vb]);

  const restore = async (v: Version) => {
    if (!(await confirm({ title: `Khôi phục phiên bản ${v.version}?`, body: 'Nội dung hiện tại sẽ được thay bằng phiên bản này (tạo thành một phiên bản mới, không mất lịch sử). Nếu bài đã duyệt, bài sẽ về bản nháp để duyệt lại.', confirmLabel: 'Khôi phục' }))) return;
    setBusy(v.version);
    try { await onRestore(v.version); } finally { setBusy(null); }
  };

  if (!versions.length) return <Empty title="Chưa có phiên bản nào" />;
  return (
    <div className="space-y-4">
      <Card title="So sánh hai phiên bản">
        <div className="grid grid-cols-2 gap-2">
          <Select aria-label="Phiên bản cũ" value={a} onChange={(e) => setA(e.target.value ? Number(e.target.value) : '')}><option value="">Phiên bản cũ…</option>{versions.map((v) => <option key={v.version} value={v.version}>v{v.version}</option>)}</Select>
          <Select aria-label="Phiên bản mới" value={b} onChange={(e) => setB(e.target.value ? Number(e.target.value) : '')}><option value="">Phiên bản mới…</option>{versions.map((v) => <option key={v.version} value={v.version}>v{v.version}</option>)}</Select>
        </div>
        <div className="mt-3">{diff ? <><p className="mb-1 text-xs text-muted"><span className="text-danger">Đỏ</span>: dòng bị xoá (v{a}) · <span className="text-ok">xanh</span>: dòng thêm (v{b})</p><DiffView lines={diff} /></> : <p className="text-sm text-muted">Chọn hai phiên bản để xem khác biệt theo dòng.</p>}</div>
      </Card>
      <Card title={`Lịch sử (${versions.length})`} pad={false}>
        <ul className="divide-y divide-line">
          {versions.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">v{v.version}</span>{v.version === current && <Badge tone="green">Hiện tại</Badge>}<Badge>{SRC[v.source] ?? v.source}</Badge><span className="truncate text-muted">{v.title}</span></div>
                <p className="text-xs text-muted">{fmtDateTime(v.created_at)} · {v.author ?? 'Hệ thống'}{v.change_note ? ` · ${v.change_note}` : ''}</p>
              </div>
              <Button size="sm" disabled={readOnly || v.version === current || busy !== null} busy={busy === v.version} onClick={() => void restore(v)}>Khôi phục</Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

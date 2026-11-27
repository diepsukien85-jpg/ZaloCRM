'use client';
import { clsx } from '@/components/ui';

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/** Diff theo dòng (LCS). Đủ cho nội dung vài trăm dòng. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split('\n'); const y = b.split('\n');
  const n = x.length; const m = y.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ kind: 'same', text: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: 'del', text: x[i++] });
    else out.push({ kind: 'add', text: y[j++] });
  }
  while (i < n) out.push({ kind: 'del', text: x[i++] });
  while (j < m) out.push({ kind: 'add', text: y[j++] });
  return out;
}

export function DiffView({ lines }: { lines: DiffLine[] }) {
  const changed = lines.some((l) => l.kind !== 'same');
  if (!changed) return <p className="text-sm text-muted">Hai phiên bản giống hệt nhau.</p>;
  return (
    <div className="max-h-[480px] overflow-auto rounded-lg border border-line text-sm" role="region" aria-label="So sánh phiên bản">
      {lines.map((l, i) => (
        <div key={i} className={clsx('flex gap-2 px-2 py-0.5 font-mono text-[13px] leading-relaxed', l.kind === 'add' && 'bg-ok/10 text-ok', l.kind === 'del' && 'bg-danger/10 text-danger')}>
          <span aria-hidden className="w-3 shrink-0 select-none">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
          <span className={clsx('min-w-0 whitespace-pre-wrap break-words', l.kind === 'del' && 'line-through decoration-danger/40')}>{l.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

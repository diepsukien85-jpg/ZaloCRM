'use client';
import type { ReactNode } from 'react';
import { CopyButton } from '@/components/ui';

/** Khối nội dung có nút sao chép. Rỗng -> "—". */
export function CopyBlock({ label, text, children }: { label: string; text?: string | null; children?: ReactNode }) {
  const t = (text ?? '').trim();
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</h4>
        {t && <CopyButton text={t} />}
      </div>
      {children ?? <p className="whitespace-pre-wrap break-words text-sm">{t || '—'}</p>}
    </div>
  );
}

export const asText = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v.join('\n') : v ?? '');

'use client';
 
import clsx from 'clsx';
import { Loader2, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { STATUS_LABEL } from '@/lib/client';

export { clsx };

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'gold'; size?: 'sm' | 'md' | 'lg'; busy?: boolean };
export function Button({ variant = 'secondary', size = 'md', busy, className, children, disabled, ...p }: BtnProps) {
  const v = {
    primary: 'bg-brand text-white hover:opacity-90',
    secondary: 'bg-surface border border-line text-ink hover:bg-surface2',
    ghost: 'text-ink hover:bg-surface2',
    danger: 'bg-danger text-white hover:opacity-90',
    gold: 'bg-gold text-navy hover:opacity-90 font-semibold',
  }[variant];
  const s = { sm: 'h-8 px-2.5 text-xs', md: 'h-10 px-3.5 text-sm', lg: 'h-12 px-6 text-base' }[size];
  return (
    <button {...p} disabled={disabled || busy} className={clsx('inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap', v, s, className)}>
      {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{children}
    </button>
  );
}

export function Card({ title, actions, children, className, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={clsx('rounded-xl border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

const TONES: Record<string, string> = {
  gray: 'bg-surface2 text-muted', blue: 'bg-brand/10 text-brand', green: 'bg-ok/10 text-ok', red: 'bg-danger/10 text-danger', amber: 'bg-warn/10 text-warn', teal: 'bg-teal/10 text-teal', gold: 'bg-gold/20 text-[#8a6d00] dark:text-gold',
};
export function Badge({ tone = 'gray', children, className }: { tone?: keyof typeof TONES | string; children: ReactNode; className?: string }) {
  return <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone] ?? TONES.gray, className)}>{children}</span>;
}
/** Nhãn bắt buộc cho mọi dữ liệu sinh ở chế độ DEMO (chưa có khoá AI). */
export function DemoBadge({ show = true }: { show?: boolean }) {
  return show ? <Badge tone="amber" className="uppercase tracking-wide">Demo</Badge> : null;
}
const STATUS_TONE: Record<string, string> = { draft: 'gray', pending_review: 'amber', changes_requested: 'red', approved: 'green', scheduled: 'blue', published: 'teal', failed: 'red', archived: 'gray', in_production: 'blue', ready_to_publish: 'teal' };
export function StatusBadge({ status }: { status: string }) { return <Badge tone={STATUS_TONE[status] ?? 'gray'}>{STATUS_LABEL[status] ?? status}</Badge>; }

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block space-y-1', className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}
const inputCls = 'w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted/70 disabled:opacity-60';
export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) { return <input {...p} className={clsx(inputCls, 'h-10', className)} />; }
export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...p} className={clsx(inputCls, 'py-2 min-h-24 leading-relaxed', className)} />; }
export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) { return <select {...p} className={clsx(inputCls, 'h-10', className)}>{children}</select>; }

export function Spinner({ label = 'Đang tải…' }: { label?: string }) {
  return <div className="flex items-center gap-2 py-6 text-sm text-muted" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{label}</div>;
}
export function Empty({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center"><p className="text-sm font-medium">{title}</p>{hint && <p className="mx-auto mt-1 max-w-md text-xs text-muted">{hint}</p>}{action && <div className="mt-3">{action}</div>}</div>;
}
export function ErrorNote({ message }: { message: string | null }) {
  return message ? <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{message}</p> : null;
}
export function Notice({ tone = 'amber', children }: { tone?: 'amber' | 'blue' | 'red' | 'green'; children: ReactNode }) {
  const t = { amber: 'bg-warn/10 text-warn', blue: 'bg-brand/10 text-brand', red: 'bg-danger/10 text-danger', green: 'bg-ok/10 text-ok' }[tone];
  return <div className={clsx('rounded-lg px-3 py-2 text-sm', t)}>{children}</div>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={clsx('mt-1 text-2xl font-semibold tabular-nums', tone)}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function PageHeader({ title, desc, actions }: { title: string; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h1 className="text-xl font-semibold sm:text-2xl">{title}</h1>{desc && <p className="mt-1 max-w-3xl text-sm text-muted">{desc}</p>}</div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={clsx('whitespace-nowrap border-b-2 px-3 py-2 text-sm', value === t.id ? 'border-brand font-medium text-brand' : 'border-transparent text-muted hover:text-ink')}>{t.label}</button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={clsx('flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Đóng" className="rounded p-1 hover:bg-surface2"><X className="h-5 w-5" /></button>
        </header>
        <div className="overflow-y-auto p-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

// ---------- Toast & Confirm ----------
type Toast = { id: number; msg: string; tone: 'ok' | 'err' | 'info' };
type Ctx = { toast: (msg: string, tone?: Toast['tone']) => void; confirm: (o: { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }) => Promise<boolean> };
const UiCtx = createContext<Ctx>({ toast: () => {}, confirm: async () => false });
export const useUi = () => useContext(UiCtx);

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dlg, setDlg] = useState<null | { o: Parameters<Ctx['confirm']>[0]; res: (v: boolean) => void }>(null);
  const toast = useCallback((msg: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'err' ? 7000 : 3500);
  }, []);
  const confirm = useCallback((o: Parameters<Ctx['confirm']>[0]) => new Promise<boolean>((res) => setDlg({ o, res })), []);
  return (
    <UiCtx.Provider value={{ toast, confirm }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={clsx('pointer-events-auto max-w-md rounded-lg px-4 py-2 text-sm text-white shadow-lg', t.tone === 'err' ? 'bg-danger' : t.tone === 'info' ? 'bg-navy' : 'bg-ok')}>{t.msg}</div>
        ))}
      </div>
      <Modal open={!!dlg} onClose={() => { dlg?.res(false); setDlg(null); }} title={dlg?.o.title ?? ''}
        footer={<><Button onClick={() => { dlg?.res(false); setDlg(null); }}>Huỷ</Button><Button variant={dlg?.o.danger ? 'danger' : 'primary'} onClick={() => { dlg?.res(true); setDlg(null); }}>{dlg?.o.confirmLabel ?? 'Xác nhận'}</Button></>}>
        <div className="text-sm">{dlg?.o.body}</div>
      </Modal>
    </UiCtx.Provider>
  );
}

/** Chạy một thao tác bất đồng bộ với trạng thái busy + toast lỗi. */
export function useAction() {
  const { toast } = useUi();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
    setBusy(key);
    try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
    catch (e) { toast((e as Error).message, 'err'); return undefined; }
    finally { setBusy(null); }
  }, [toast]);
  return { busy, run };
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="bg-surface2 text-left text-xs text-muted"><tr>{head.map((h, i) => <th key={i} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
      {empty}
    </div>
  );
}
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => <td className={clsx('px-3 py-2 align-top', className)}>{children}</td>;

export function CopyButton({ text, label = 'Sao chép', size = 'sm' }: { text: string; label?: string; size?: 'sm' | 'md' }) {
  const { toast } = useUi();
  return <Button size={size} onClick={async () => { try { await navigator.clipboard.writeText(text); toast('Đã sao chép'); } catch { toast('Trình duyệt không cho phép sao chép', 'err'); } }}>{label}</Button>;
}

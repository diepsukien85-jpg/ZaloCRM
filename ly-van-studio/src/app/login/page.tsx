'use client';
import { useState } from 'react';
import { api } from '@/lib/client';
import { Button, ErrorNote, Field, Input } from '@/components/ui';

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [f, setF] = useState({ email: '', password: '', name: '', workspace_name: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      if (mode === 'login') await api('/auth/login', { body: { email: f.email, password: f.password } });
      else await api('/auth/register', { body: { email: f.email, password: f.password, name: f.name, workspace_name: f.workspace_name || undefined } });
      location.href = '/';
    } catch (e2) { setErr((e2 as Error).message); setBusy(false); }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-navy p-4">
      <div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl sm:p-8">
        <p className="text-xs uppercase tracking-widest text-gold">Ly Vân</p>
        <h1 className="text-2xl font-semibold">AI Content Studio</h1>
        <p className="mt-1 text-sm text-muted">Hệ điều hành marketing AI cho thương hiệu cá nhân & doanh nghiệp.</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          {mode === 'register' && <>
            <Field label="Họ và tên"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" /></Field>
            <Field label="Tên workspace (tuỳ chọn)"><Input value={f.workspace_name} onChange={(e) => setF({ ...f, workspace_name: e.target.value })} placeholder="Ly Vân Studio" /></Field>
          </>}
          <Field label="Email"><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" /></Field>
          <Field label="Mật khẩu" hint={mode === 'register' ? 'Tối thiểu 8 ký tự' : undefined}><Input type="password" required minLength={mode === 'register' ? 8 : 1} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></Field>
          <ErrorNote message={err} />
          <Button type="submit" variant="primary" size="lg" className="w-full" busy={busy}>{mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}</Button>
        </form>
        <button className="mt-4 text-sm text-brand" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(null); }}>
          {mode === 'login' ? 'Chưa có tài khoản? Đăng ký' : 'Đã có tài khoản? Đăng nhập'}
        </button>
      </div>
    </main>
  );
}

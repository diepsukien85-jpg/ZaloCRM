'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BarChart3, Bell, BookOpen, Bot, CalendarDays, Clapperboard, DollarSign, Dna, Factory, FolderOpen, Lightbulb, LayoutDashboard, LogOut, Menu, MessageSquare, Moon, Radar, Search, Send, Settings, Share2,
  Sparkles, Sun, Users, Workflow, X, Zap,
} from 'lucide-react';
import { api, useApi } from '@/lib/client';
import { Badge, Button, UiProvider, clsx, useUi } from './ui';

export const NAV = [
  { href: '/', label: 'Tổng quan', icon: LayoutDashboard },
  { href: '/agents', label: 'AI Agent Center', icon: Bot },
  { href: '/dna', label: 'DNA thương hiệu', icon: Dna },
  { href: '/trends', label: 'Radar xu hướng', icon: Radar },
  { href: '/keywords', label: 'Phòng nghiên cứu từ khoá', icon: Search },
  { href: '/viral', label: 'Giải mã video viral', icon: Zap },
  { href: '/stories', label: 'Ngân hàng câu chuyện', icon: BookOpen },
  { href: '/ideas', label: 'Ngân hàng ý tưởng', icon: Lightbulb },
  { href: '/content', label: 'Content Factory', icon: Factory },
  { href: '/video', label: 'Video Studio', icon: Clapperboard },
  { href: '/media', label: 'Thư viện tư liệu', icon: FolderOpen },
  { href: '/calendar', label: 'Lịch nội dung', icon: CalendarDays },
  { href: '/channels', label: 'Quản lý kênh', icon: Share2 },
  { href: '/leads', label: 'Khách hàng tiềm năng', icon: Users },
  { href: '/analytics', label: 'Phân tích hiệu quả', icon: BarChart3 },
  { href: '/automation', label: 'Tự động hoá', icon: Workflow },
  { href: '/ai-cost', label: 'Quản lý chi phí AI', icon: DollarSign },
  { href: '/settings', label: 'Cài đặt', icon: Settings },
];

type Me = { user: { name: string; email: string }; workspaceId: string; role: string; workspaces: { id: string; name: string; role: string }[] };

function Copilot({ onClose }: { onClose: () => void }) {
  const [msgs, setMsgs] = useState<{ role: 'user' | 'ai'; text: string; link?: string; demo?: boolean }[]>([
    { role: 'ai', text: 'Xin chào! Gõ câu hỏi hoặc lệnh nhanh: /DAILY /KEYWORD /VIRAL /DECODE /STORY /FLOW /30DAY /AUDIT /REPORT /REWRITE' },
  ]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const router = useRouter();
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs]);
  async function send(m: string) {
    if (!m.trim() || busy) return;
    setMsgs((x) => [...x, { role: 'user', text: m }]); setText(''); setBusy(true);
    try { const r = await api<{ reply: string; link?: string; demo?: boolean }>('/copilot', { body: { message: m } }); setMsgs((x) => [...x, { role: 'ai', text: r.reply, link: r.link, demo: r.demo }]); }
    catch (e) { setMsgs((x) => [...x, { role: 'ai', text: `⚠ ${(e as Error).message}` }]); }
    finally { setBusy(false); }
  }
  return (
    <aside aria-label="AI Copilot" className="flex h-full w-full flex-col border-l border-line bg-surface">
      <header className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-gold" />AI Copilot</div>
        <button onClick={onClose} aria-label="Đóng Copilot" className="rounded p-1 hover:bg-surface2"><X className="h-4 w-4" /></button>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm">
        {msgs.map((m, i) => (
          <div key={i} className={clsx('rounded-lg px-3 py-2 prose-pre', m.role === 'user' ? 'ml-6 bg-brand text-white' : 'mr-4 bg-surface2')}>
            {m.text}{m.demo && <div className="mt-1"><Badge tone="amber">DEMO</Badge></div>}
            {m.link && <button className="mt-2 block text-xs font-medium text-brand underline" onClick={() => router.push(m.link!)}>Mở →</button>}
          </div>
        ))}
        {busy && <p className="text-xs text-muted">Đang xử lý…</p>}
        <div ref={end} />
      </div>
      <div className="flex flex-wrap gap-1 border-t border-line px-3 pt-2">
        {['/DAILY', '/REPORT', '/VIRAL', '/FLOW'].map((c) => <button key={c} onClick={() => send(c)} className="rounded-full bg-surface2 px-2 py-0.5 text-xs hover:bg-line">{c}</button>)}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); send(text); }} className="flex gap-2 p-3">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Hỏi hoặc gõ /lệnh…" aria-label="Tin nhắn Copilot" className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm" />
        <Button variant="primary" type="submit" disabled={busy} aria-label="Gửi"><Send className="h-4 w-4" /></Button>
      </form>
    </aside>
  );
}

function Notifications() {
  const { data, reload } = useApi<{ items: { id: string; title: string; body: string; link: string | null; read_at: string | null; created_at: string }[] }>('/notifications');
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const unread = data?.items.filter((n) => !n.read_at).length ?? 0;
  useEffect(() => { const t = setInterval(reload, 30000); return () => clearInterval(t); }, [reload]);
  return (
    <div className="relative">
      <button aria-label={`Thông báo (${unread} chưa đọc)`} onClick={() => { setOpen(!open); if (!open) reload(); }} className="relative rounded-lg p-2 hover:bg-surface2">
        <Bell className="h-5 w-5" />{unread > 0 && <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] text-white">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(22rem,90vw)] rounded-xl border border-line bg-surface p-2 shadow-xl">
          <div className="flex items-center justify-between px-2 py-1 text-sm font-semibold">Thông báo<button className="text-xs font-normal text-brand" onClick={async () => { await api('/notifications/read', { method: 'POST' }); reload(); }}>Đánh dấu đã đọc</button></div>
          <div className="max-h-80 overflow-y-auto">
            {!data?.items.length && <p className="p-3 text-sm text-muted">Chưa có thông báo.</p>}
            {data?.items.map((n) => (
              <button key={n.id} onClick={() => { setOpen(false); if (n.link) router.push(n.link); }} className={clsx('block w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-surface2', !n.read_at && 'font-medium')}>
                {n.title}{n.body && <span className="block text-xs font-normal text-muted">{n.body}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ShellInner({ me, children }: { me: Me; children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { toast } = useUi();
  const [nav, setNav] = useState(false);
  const [copilot, setCopilot] = useState(false);
  const [dark, setDark] = useState(false);
  useEffect(() => { setDark(document.documentElement.classList.contains('dark')); }, []);
  useEffect(() => setNav(false), [path]);
  const toggleTheme = () => { const d = !dark; setDark(d); document.documentElement.classList.toggle('dark', d); try { localStorage.setItem('lv-theme', d ? 'dark' : 'light'); } catch { /* bỏ qua */ } };
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));

  const navList = (
    <nav aria-label="Điều hướng chính" className="flex-1 space-y-0.5 overflow-y-auto p-2">
      {NAV.map(({ href, label, icon: Icon }) => (
        <Link key={href} href={href} className={clsx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm', active(href) ? 'bg-white/15 font-medium text-white' : 'text-slate-300 hover:bg-white/10')}>
          <Icon className="h-4 w-4 shrink-0" />{label}
        </Link>
      ))}
    </nav>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Sidebar desktop */}
      <aside className="hidden w-64 shrink-0 flex-col bg-navy text-white lg:flex">
        <div className="px-4 py-4"><p className="text-xs uppercase tracking-widest text-gold">Ly Vân</p><p className="text-base font-semibold">AI Content Studio</p></div>
        {navList}
      </aside>
      {/* Sidebar mobile */}
      {nav && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setNav(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <aside className="relative flex h-full w-72 max-w-[85vw] flex-col bg-navy text-white" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-4"><p className="font-semibold">Ly Vân AI Studio</p><button aria-label="Đóng menu" onClick={() => setNav(false)}><X className="h-5 w-5" /></button></div>
            {navList}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:px-4">
          <button className="rounded-lg p-2 hover:bg-surface2 lg:hidden" aria-label="Mở menu" onClick={() => setNav(true)}><Menu className="h-5 w-5" /></button>
          <select aria-label="Workspace" value={me.workspaceId} onChange={async (e) => { await api('/auth/workspace', { body: { workspace_id: e.target.value } }); router.refresh(); location.reload(); }} className="h-9 max-w-[10rem] truncate rounded-lg border border-line bg-surface px-2 text-sm sm:max-w-xs">
            {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <Badge tone="gray" className="hidden sm:inline-flex">{me.role}</Badge>
          <div className="flex-1" />
          <Notifications />
          <button onClick={toggleTheme} aria-label={dark ? 'Chế độ sáng' : 'Chế độ tối'} className="rounded-lg p-2 hover:bg-surface2">{dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}</button>
          <button onClick={() => setCopilot(!copilot)} aria-pressed={copilot} className={clsx('flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm hover:bg-surface2', copilot && 'bg-surface2')}><MessageSquare className="h-5 w-5" /><span className="hidden sm:inline">Copilot</span></button>
          <button onClick={async () => { await api('/auth/logout', { method: 'POST' }); toast('Đã đăng xuất', 'info'); location.href = '/login'; }} aria-label="Đăng xuất" title={me.user.email} className="rounded-lg p-2 hover:bg-surface2"><LogOut className="h-5 w-5" /></button>
        </header>
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-5 lg:p-6">{children}</main>
          {copilot && (
            <div className="fixed inset-0 z-40 sm:static sm:z-auto sm:w-80 sm:shrink-0 xl:w-96"><Copilot onClose={() => setCopilot(false)} /></div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Shell({ me, children }: { me: Me; children: ReactNode }) {
  return <UiProvider><ShellInner me={me}>{children}</ShellInner></UiProvider>;
}

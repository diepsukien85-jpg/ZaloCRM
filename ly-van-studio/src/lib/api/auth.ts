import { z } from 'zod';
import { NextResponse } from 'next/server';
import { one, q, tx } from '../db';
import { audit } from '../audit';
import { clearSessionCookies, createWorkspace, getAuth, registerUser, setSessionCookies, verifyPassword, roleAtLeast, type Role } from '../auth';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors';
import { env } from '../env';
import { rateLimit } from '../ratelimit';
import { bootstrapWorkspace } from '../services/bootstrap';
import type { RouteDef } from '../router';

const pw = z.string().min(8, 'Mật khẩu tối thiểu 8 ký tự').max(200);
const Register = z.object({ email: z.string().email().max(200), password: pw, name: z.string().min(1).max(100), workspace_name: z.string().min(1).max(100).optional() });
const Login = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });

export const authRoutes: RouteDef[] = [
  {
    method: 'POST', path: '/auth/register', public: true, schema: Register, rate: { key: 'register', max: 10 },
    handler: async ({ body }) => {
      if (!env.allowSignup) throw forbidden('Đăng ký đang tắt');
      const b = body as z.infer<typeof Register>;
      const r = await registerUser(b.email, b.password, b.name, b.workspace_name ?? `Workspace của ${b.name}`);
      if (!r) throw conflict('Email đã được đăng ký');
      await bootstrapWorkspace(r.workspaceId, r.userId);
      await setSessionCookies(r.userId, r.workspaceId);
      await audit(r.workspaceId, r.userId, 'auth.register');
      return { ok: true };
    },
  },
  {
    method: 'POST', path: '/auth/login', public: true, schema: Login, rate: { key: 'login', max: 15 },
    handler: async ({ body }) => {
      const b = body as z.infer<typeof Login>;
      // Giới hạn theo email: chống dò mật khẩu kể cả khi kẻ tấn công giả header IP
      await rateLimit(`login-email:${b.email.toLowerCase()}`, 10);
      const u = await one<{ id: string; password_hash: string }>('SELECT id, password_hash FROM users WHERE lower(email)=lower($1)', [b.email]);
      // So sánh luôn chạy để tránh lộ email tồn tại qua thời gian phản hồi
      const ok = await verifyPassword(b.password, u?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
      if (!u || !ok) throw unauthorized('Email hoặc mật khẩu không đúng');
      const m = await one<{ workspace_id: string }>('SELECT workspace_id FROM workspace_members WHERE user_id=$1 ORDER BY created_at LIMIT 1', [u.id]);
      await setSessionCookies(u.id, m?.workspace_id);
      await audit(m?.workspace_id ?? null, u.id, 'auth.login');
      return { ok: true };
    },
  },
  { method: 'POST', path: '/auth/logout', public: true, handler: async () => { await clearSessionCookies(); return { ok: true }; } },
  {
    method: 'GET', path: '/auth/me', public: true,
    handler: async () => {
      const a = await getAuth();
      if (!a) return NextResponse.json({ user: null }, { status: 401 });
      const workspaces = await q('SELECT w.id, w.name, w.slug, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at', [a.user.id]);
      return { user: a.user, workspaceId: a.workspaceId, role: a.role, workspaces };
    },
  },
  {
    method: 'POST', path: '/auth/workspace', schema: z.object({ workspace_id: z.string().uuid() }),
    handler: async (c) => {
      const m = await one<{ role: Role }>('SELECT role FROM workspace_members WHERE user_id=$1 AND workspace_id=$2', [c.user.id, (c.body as { workspace_id: string }).workspace_id]);
      if (!m) throw forbidden('Bạn không thuộc workspace này');
      await setSessionCookies(c.user.id, (c.body as { workspace_id: string }).workspace_id);
      return { ok: true };
    },
  },
  {
    method: 'POST', path: '/workspaces', schema: z.object({ name: z.string().min(1).max(100) }), min: 'viewer',
    handler: async (c) => {
      const id = await tx((cl) => createWorkspace(cl, (c.body as { name: string }).name, c.user.id));
      await bootstrapWorkspace(id, c.user.id);
      await setSessionCookies(c.user.id, id);
      await audit(id, c.user.id, 'workspace.create');
      return { id };
    },
  },
  {
    method: 'GET', path: '/members',
    handler: async (c) => ({ items: await q('SELECT m.id, m.role, u.id AS user_id, u.email, u.name FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.created_at', [c.workspaceId]) }),
  },
  {
    method: 'POST', path: '/members', min: 'admin', schema: z.object({ email: z.string().email(), role: z.enum(['admin', 'editor', 'viewer']) }),
    handler: async (c) => {
      const b = c.body as { email: string; role: Role };
      const u = await one<{ id: string }>('SELECT id FROM users WHERE lower(email)=lower($1)', [b.email]);
      if (!u) throw notFound('Người dùng chưa đăng ký tài khoản. Hãy bảo họ đăng ký trước rồi thêm lại.');
      await q('INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role WHERE workspace_members.role <> \'owner\'', [c.workspaceId, u.id, b.role]);
      await audit(c.workspaceId, c.user.id, 'member.upsert', 'user', u.id, { role: b.role });
      return { ok: true };
    },
  },
  {
    method: 'DELETE', path: '/members/:id', min: 'admin',
    handler: async (c) => {
      const m = await one<{ role: Role; user_id: string }>('SELECT role, user_id FROM workspace_members WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!m) throw notFound();
      if (m.role === 'owner') throw badRequest('Không thể xoá chủ sở hữu');
      if (!roleAtLeast(c.role, m.role === 'admin' ? 'owner' : 'admin')) throw forbidden();
      await q('DELETE FROM workspace_members WHERE id=$1', [c.params.id]);
      await audit(c.workspaceId, c.user.id, 'member.remove', 'user', m.user_id);
      return { ok: true };
    },
  },
];

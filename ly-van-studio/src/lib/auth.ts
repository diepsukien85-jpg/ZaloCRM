import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { appSecret } from './env';
import { one, q, tx } from './db';
import { forbidden, unauthorized } from './errors';
import type { PoolClient } from 'pg';

export type Role = 'owner' | 'admin' | 'editor' | 'viewer';
const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };
export const roleAtLeast = (r: Role, min: Role) => RANK[r] >= RANK[min];

export const SESSION_COOKIE = 'lv_session';
export const WS_COOKIE = 'lv_ws';
const SESSION_DAYS = 14;

export type SessionUser = { id: string; email: string; name: string };
export type AuthCtx = { user: SessionUser; workspaceId: string; role: Role };

const secretKey = () => new TextEncoder().encode(appSecret());

export async function hashPassword(pw: string) { return bcrypt.hash(pw, 10); }
export async function verifyPassword(pw: string, hash: string) { return bcrypt.compare(pw, hash); }

export async function signSession(userId: string): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId)
    .setIssuedAt().setExpirationTime(`${SESSION_DAYS}d`).sign(secretKey());
}
export async function readSessionToken(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try { const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] }); return payload.sub ?? null; }
  catch { return null; }
}

export async function setSessionCookies(userId: string, workspaceId?: string) {
  const jar = await cookies();
  const secure = process.env.NODE_ENV === 'production';
  jar.set(SESSION_COOKIE, await signSession(userId), { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_DAYS * 86400 });
  if (workspaceId) jar.set(WS_COOKIE, workspaceId, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_DAYS * 86400 });
}
export async function clearSessionCookies() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE); jar.delete(WS_COOKIE);
}

export async function getAuth(): Promise<AuthCtx | null> {
  const jar = await cookies();
  const userId = await readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!userId) return null;
  const user = await one<SessionUser>('SELECT id, email, name FROM users WHERE id = $1', [userId]);
  if (!user) return null;
  const wanted = jar.get(WS_COOKIE)?.value;
  const members = await q<{ workspace_id: string; role: Role }>(
    'SELECT workspace_id, role FROM workspace_members WHERE user_id = $1 ORDER BY created_at', [userId]);
  if (!members.length) return null;
  // Quyền luôn được tính lại từ DB: cookie chỉ là gợi ý chọn workspace, không phải bằng chứng quyền.
  const m = members.find((x) => x.workspace_id === wanted) ?? members[0];
  return { user, workspaceId: m.workspace_id, role: m.role };
}
export async function requireAuth(min: Role = 'viewer'): Promise<AuthCtx> {
  const a = await getAuth();
  if (!a) throw unauthorized();
  if (!roleAtLeast(a.role, min)) throw forbidden();
  return a;
}

export function slugify(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace';
}

export async function createWorkspace(c: PoolClient, name: string, ownerId: string) {
  const base = slugify(name);
  let slug = base;
  for (let i = 1; (await c.query('SELECT 1 FROM workspaces WHERE slug=$1', [slug])).rowCount; i++) slug = `${base}-${i}`;
  const ws = (await c.query('INSERT INTO workspaces(name, slug, owner_id) VALUES ($1,$2,$3) RETURNING id', [name, slug, ownerId])).rows[0];
  await c.query("INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws.id, ownerId]);
  return ws.id as string;
}

export async function registerUser(email: string, password: string, name: string, workspaceName: string) {
  return tx(async (c) => {
    const exists = await c.query('SELECT 1 FROM users WHERE lower(email)=lower($1)', [email]);
    if (exists.rowCount) return null;
    const u = (await c.query('INSERT INTO users(email, password_hash, name) VALUES ($1,$2,$3) RETURNING id', [email, await hashPassword(password), name])).rows[0];
    const workspaceId = await createWorkspace(c, workspaceName, u.id);
    return { userId: u.id as string, workspaceId };
  });
}

import { NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import { getAuth, roleAtLeast, type AuthCtx, type Role } from './auth';
import { checkOrigin, handleError } from './http';
import { badRequest, forbidden, unauthorized } from './errors';
import { rateLimit } from './ratelimit';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Ctx<B = any> = {
  user: AuthCtx['user']; workspaceId: string; role: Role;
  req: Request; body: B; params: Record<string, string>; query: URLSearchParams;
};
export type PublicCtx<B = any> = { req: Request; body: B; params: Record<string, string>; query: URLSearchParams };

type Base = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string };
export type AuthedRoute = Base & { public?: false; min?: Role; schema?: ZodType; rate?: { key: string; max: number }; handler: (c: Ctx) => Promise<unknown> };
export type PublicRoute = Base & { public: true; schema?: ZodType; rate?: { key: string; max: number }; handler: (c: PublicCtx) => Promise<unknown> };
export type RouteDef = AuthedRoute | PublicRoute;

const compiled: { def: RouteDef; re: RegExp; keys: string[] }[] = [];
export function register(routes: RouteDef[]) {
  for (const def of routes) {
    const keys: string[] = [];
    const re = new RegExp('^' + def.path.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    compiled.push({ def, re, keys });
  }
}

export async function dispatch(req: Request, segments: string[]): Promise<Response> {
  try {
    const path = '/' + segments.join('/');
    let match: { def: RouteDef; params: Record<string, string> } | null = null;
    let pathExists = false;
    for (const c of compiled) {
      const m = c.re.exec(path);
      if (!m) continue;
      pathExists = true;
      if (c.def.method !== req.method) continue;
      match = { def: c.def, params: Object.fromEntries(c.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      break;
    }
    if (!match) {
      return NextResponse.json({ error: pathExists ? 'Phương thức không được hỗ trợ' : 'Không tìm thấy endpoint', code: pathExists ? 'method_not_allowed' : 'not_found' }, { status: pathExists ? 405 : 404 });
    }
    const { def, params } = match;
    checkOrigin(req);
    const query = new URL(req.url).searchParams;
    let auth: AuthCtx | null = null;
    if (!def.public) {
      auth = await getAuth();
      if (!auth) throw unauthorized();
      const min: Role = def.min ?? (req.method === 'GET' ? 'viewer' : 'editor');
      if (!roleAtLeast(auth.role, min)) throw forbidden();
      if (def.rate) await rateLimit(`${def.rate.key}:${auth.user.id}`, def.rate.max);
    } else if (def.rate) {
      await rateLimit(`${def.rate.key}:${req.headers.get('x-forwarded-for') ?? 'local'}`, def.rate.max);
    }
    let body: unknown = undefined;
    if (def.schema) {
      let raw: unknown;
      try { raw = await req.json(); } catch { throw badRequest('Body JSON không hợp lệ'); }
      body = def.schema.parse(raw);
    }
    const out = def.public
      ? await (def as PublicRoute).handler({ req, body, params, query })
      : await (def as AuthedRoute).handler({ ...(auth as AuthCtx), req, body, params, query });
    if (out instanceof Response) return out;
    return NextResponse.json(out ?? { ok: true });
  } catch (e) {
    return handleError(e);
  }
}

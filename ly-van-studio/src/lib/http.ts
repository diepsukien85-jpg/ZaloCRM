import { NextResponse } from 'next/server';
import { ZodError, type ZodType } from 'zod';
import { requireAuth, type AuthCtx, type Role } from './auth';
import { HttpError, badRequest, forbidden } from './errors';
import { rateLimit } from './ratelimit';

type Ctx<B, P> = AuthCtx & { req: Request; body: B; params: P; query: URLSearchParams };
type Opts<B> = { min?: Role; schema?: ZodType<B>; rate?: { key: string; max: number }; public?: boolean };

/** Chống CSRF: yêu cầu thay đổi dữ liệu phải cùng origin (cộng cookie SameSite=Lax). */
export function checkOrigin(req: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers.get('origin');
  if (!origin) return; // client không phải trình duyệt (curl, test): không có cookie ngữ cảnh chéo trang
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (new URL(origin).host !== host) throw forbidden('Origin không hợp lệ');
}

export function handleError(e: unknown) {
  if (e instanceof HttpError) return NextResponse.json({ error: e.message, code: e.code, details: e.details }, { status: e.status });
  if (e instanceof ZodError) return NextResponse.json({ error: 'Dữ liệu không hợp lệ', code: 'validation', details: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, { status: 400 });
  const pgCode = (e as { code?: string })?.code;
  if (pgCode === '23505') return NextResponse.json({ error: 'Dữ liệu đã tồn tại (trùng)', code: 'conflict' }, { status: 409 });
  if (pgCode === '23503') return NextResponse.json({ error: 'Tham chiếu không hợp lệ', code: 'bad_reference' }, { status: 400 });
  if (pgCode === '23514' || pgCode === '22P02') return NextResponse.json({ error: 'Giá trị không hợp lệ', code: 'validation' }, { status: 400 });
  console.error('[api]', e);
  return NextResponse.json({ error: 'Lỗi máy chủ nội bộ', code: 'internal' }, { status: 500 });
}

/**
 * Bọc route handler: xác thực → phân quyền theo vai trò → kiểm Origin → rate limit → validate Zod.
 * Mọi truy vấn trong fn phải dùng ctx.workspaceId (cách ly workspace).
 */
export function route<B = undefined, P = Record<string, string>>(opts: Opts<B>, fn: (ctx: Ctx<B, P>) => Promise<unknown>) {
  return async (req: Request, extra: { params: Promise<P> }) => {
    try {
      checkOrigin(req);
      const min: Role = opts.min ?? (req.method === 'GET' ? 'viewer' : 'editor');
      const auth = await requireAuth(min);
      if (opts.rate) await rateLimit(`${opts.rate.key}:${auth.user.id}`, opts.rate.max);
      let body = undefined as B;
      if (opts.schema) {
        let raw: unknown = {};
        try { raw = await req.json(); } catch { throw badRequest('Body JSON không hợp lệ'); }
        body = opts.schema.parse(raw);
      }
      const params = (await extra.params) ?? ({} as P);
      const out = await fn({ ...auth, req, body, params, query: new URL(req.url).searchParams });
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true });
    } catch (e) {
      return handleError(e);
    }
  };
}

/** Route công khai (đăng nhập/đăng ký): chỉ kiểm Origin + validate. */
export function publicRoute<B = undefined>(opts: { schema?: ZodType<B> }, fn: (ctx: { req: Request; body: B }) => Promise<unknown>) {
  return async (req: Request) => {
    try {
      checkOrigin(req);
      let body = undefined as B;
      if (opts.schema) {
        let raw: unknown = {};
        try { raw = await req.json(); } catch { throw badRequest('Body JSON không hợp lệ'); }
        body = opts.schema.parse(raw);
      }
      const out = await fn({ req, body });
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true });
    } catch (e) { return handleError(e); }
  };
}

/** Content-Disposition an toàn cho tên file tiếng Việt (RFC 5987): header chỉ cho phép ASCII. */
export function contentDisposition(filename: string, type: 'attachment' | 'inline' = 'attachment'): string {
  const ascii = filename.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

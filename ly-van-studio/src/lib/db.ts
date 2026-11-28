import pg from 'pg';

// Số (bigint/numeric) trả về dạng number để dễ dùng ở UI; giá trị tiền VND nằm trong vùng an toàn.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

const g = globalThis as unknown as { __pool?: pg.Pool };

export function pool(): pg.Pool {
  if (!g.__pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Thiếu DATABASE_URL');
    g.__pool = new pg.Pool({ connectionString: url, max: process.env.VERCEL ? 3 : 10 });
  }
  return g.__pool;
}

export type Q = { query: pg.Pool['query'] };

export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = [], c?: pg.PoolClient): Promise<T[]> {
  const r = await (c ?? pool()).query(sql, params as unknown[]);
  return r.rows as T[];
}
export async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = [], c?: pg.PoolClient): Promise<T | null> {
  const rows = await q<T>(sql, params, c);
  return rows[0] ?? null;
}
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Dựng câu UPDATE an toàn: chỉ cột trong whitelist, luôn ràng buộc workspace_id. */
export function buildUpdate(table: string, allowed: readonly string[], data: Record<string, unknown>, id: string, workspaceId: string) {
  const cols = Object.keys(data).filter((k) => allowed.includes(k) && data[k] !== undefined);
  if (!cols.length) return null;
  const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  const params = [...cols.map((c) => data[c]), id, workspaceId];
  return { sql: `UPDATE ${table} SET ${sets} WHERE id = $${cols.length + 1} AND workspace_id = $${cols.length + 2} RETURNING *`, params };
}

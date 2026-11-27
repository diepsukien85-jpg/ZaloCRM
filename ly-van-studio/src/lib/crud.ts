import { z, type ZodObject, type ZodRawShape } from 'zod';
import { one, q, buildUpdate } from './db';
import { notFound } from './errors';
import { audit } from './audit';
import type { RouteDef } from './router';

const toDb = (v: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x !== null && typeof x === 'object' && !Array.isArray(x) ? JSON.stringify(x) : x]));

/** Sinh route CRUD chuẩn, luôn lọc theo workspace_id; cột ghi bị giới hạn bởi schema. */
export function crud<S extends ZodRawShape>(o: {
  path: string; table: string; shape: S; order?: string; minDelete?: 'editor' | 'admin'; filters?: string[];
}): RouteDef[] {
  const schema = z.object(o.shape) as ZodObject<S>;
  const partial = schema.partial();
  const cols = Object.keys(o.shape);
  return [
    {
      method: 'GET', path: o.path, handler: async (c) => {
        const wh = ['workspace_id = $1']; const p: unknown[] = [c.workspaceId];
        for (const f of o.filters ?? []) { const v = c.query.get(f); if (v) { p.push(v); wh.push(`${f} = $${p.length}`); } }
        return { items: await q(`SELECT * FROM ${o.table} WHERE ${wh.join(' AND ')} ORDER BY ${o.order ?? 'created_at DESC'} LIMIT 500`, p) };
      },
    },
    {
      method: 'POST', path: o.path, schema, handler: async (c) => {
        const d = toDb(c.body as Record<string, unknown>);
        const keys = Object.keys(d).filter((k) => cols.includes(k) && d[k] !== undefined);
        const row = await one<{ id: string }>(
          `INSERT INTO ${o.table}(workspace_id${keys.length ? ',' : ''}${keys.join(',')}) VALUES ($1${keys.map((_, i) => `,$${i + 2}`).join('')}) RETURNING *`,
          [c.workspaceId, ...keys.map((k) => d[k])]);
        await audit(c.workspaceId, c.user.id, `${o.table}.create`, o.table, row!.id);
        return row;
      },
    },
    {
      method: 'PATCH', path: `${o.path}/:id`, schema: partial, handler: async (c) => {
        const u = buildUpdate(o.table, cols, toDb(c.body as Record<string, unknown>), c.params.id, c.workspaceId);
        const row = u ? await one(u.sql, u.params) : await one(`SELECT * FROM ${o.table} WHERE id=$1 AND workspace_id=$2`, [c.params.id, c.workspaceId]);
        if (!row) throw notFound();
        return row;
      },
    },
    {
      method: 'DELETE', path: `${o.path}/:id`, min: o.minDelete ?? 'editor', handler: async (c) => {
        const r = await q(`DELETE FROM ${o.table} WHERE id=$1 AND workspace_id=$2 RETURNING id`, [c.params.id, c.workspaceId]);
        if (!r.length) throw notFound();
        await audit(c.workspaceId, c.user.id, `${o.table}.delete`, o.table, c.params.id);
        return { ok: true };
      },
    },
  ];
}

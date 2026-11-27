import { z } from 'zod';
import { one, q, tx } from '../db';
import { audit } from '../audit';
import { badRequest, notFound } from '../errors';
import { crud } from '../crud';
import { slugify } from '../auth';
import type { RouteDef } from '../router';

const Dna = z.object({
  about: z.string().max(3000).default(''), positioning: z.string().max(2000).default(''), personality: z.string().max(1000).default(''), voice: z.string().max(2000).default(''),
  values: z.array(z.string().max(200)).max(30).default([]), goals: z.array(z.string().max(300)).max(30).default([]), audiences: z.array(z.string().max(300)).max(30).default([]),
  products: z.array(z.string().max(300)).max(50).default([]), rules: z.array(z.string().max(300)).max(50).default([]), avoid: z.array(z.string().max(300)).max(50).default([]),
});

const BrandIn = z.object({ name: z.string().min(1).max(120), kind: z.enum(['personal', 'business']).default('personal'), website: z.string().max(300).nullish(), description: z.string().max(3000).default('') });
const Pillars = z.object({ pillars: z.array(z.object({ name: z.string().min(1).max(100), weight: z.number().min(0).max(100), description: z.string().max(500).default('') })).min(1).max(20) });

export const brandRoutes: RouteDef[] = [
  {
    method: 'GET', path: '/brands',
    handler: async (c) => {
      const brands = await q<{ id: string }>('SELECT * FROM brands WHERE workspace_id=$1 ORDER BY (kind=\'personal\') DESC, created_at', [c.workspaceId]);
      const dna = await q<{ brand_id: string; data: unknown; version: number }>('SELECT brand_id, data, version FROM brand_dna WHERE workspace_id=$1', [c.workspaceId]);
      const pillars = await q<{ brand_id: string }>('SELECT * FROM content_pillars WHERE workspace_id=$1 ORDER BY weight DESC', [c.workspaceId]);
      return { items: brands.map((b) => ({ ...b, dna: dna.find((d) => d.brand_id === b.id) ?? null, pillars: pillars.filter((p) => p.brand_id === b.id) })) };
    },
  },
  {
    method: 'POST', path: '/brands', schema: BrandIn, min: 'admin',
    handler: async (c) => {
      const b = c.body as z.infer<typeof BrandIn>;
      const out = await tx(async (cl) => {
        let slug = slugify(b.name); let n = 1;
        while ((await cl.query('SELECT 1 FROM brands WHERE workspace_id=$1 AND slug=$2', [c.workspaceId, slug])).rowCount) slug = `${slugify(b.name)}-${n++}`;
        const row = (await cl.query('INSERT INTO brands(workspace_id, name, slug, kind, website, description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [c.workspaceId, b.name, slug, b.kind, b.website ?? null, b.description])).rows[0];
        await cl.query('INSERT INTO brand_dna(workspace_id, brand_id, data) VALUES ($1,$2,$3)', [c.workspaceId, row.id, JSON.stringify(Dna.parse({}))]);
        await cl.query('INSERT INTO brand_dna_versions(workspace_id, brand_id, version, data, changed_by) VALUES ($1,$2,1,$3,$4)', [c.workspaceId, row.id, JSON.stringify(Dna.parse({})), c.user.id]);
        return row;
      });
      await audit(c.workspaceId, c.user.id, 'brand.create', 'brand', out.id);
      return out;
    },
  },
  {
    method: 'PATCH', path: '/brands/:id', schema: BrandIn.partial(), min: 'admin',
    handler: async (c) => {
      const b = c.body as Partial<z.infer<typeof BrandIn>>;
      const r = await one('UPDATE brands SET name=COALESCE($3,name), website=COALESCE($4,website), description=COALESCE($5,description) WHERE id=$1 AND workspace_id=$2 RETURNING *', [c.params.id, c.workspaceId, b.name ?? null, b.website ?? null, b.description ?? null]);
      if (!r) throw notFound();
      return r;
    },
  },
  {
    // Cập nhật DNA: luôn tạo phiên bản mới để có thể xem lại / khôi phục
    method: 'PUT', path: '/brands/:id/dna', schema: Dna, min: 'admin',
    handler: async (c) => {
      const data = c.body as z.infer<typeof Dna>;
      const r = await tx(async (cl) => {
        const cur = (await cl.query('SELECT version FROM brand_dna WHERE brand_id=$1 AND workspace_id=$2 FOR UPDATE', [c.params.id, c.workspaceId])).rows[0];
        if (!cur) throw notFound();
        const version = cur.version + 1;
        await cl.query('UPDATE brand_dna SET data=$3, version=$4 WHERE brand_id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId, JSON.stringify(data), version]);
        await cl.query('INSERT INTO brand_dna_versions(workspace_id, brand_id, version, data, changed_by) VALUES ($1,$2,$3,$4,$5)', [c.workspaceId, c.params.id, version, JSON.stringify(data), c.user.id]);
        return { version };
      });
      await audit(c.workspaceId, c.user.id, 'brand.dna.update', 'brand', c.params.id, r);
      return r;
    },
  },
  {
    method: 'GET', path: '/brands/:id/dna/versions',
    handler: async (c) => ({ items: await q('SELECT version, data, changed_by, created_at FROM brand_dna_versions WHERE brand_id=$1 AND workspace_id=$2 ORDER BY version DESC LIMIT 50', [c.params.id, c.workspaceId]) }),
  },
  {
    method: 'PUT', path: '/brands/:id/pillars', schema: Pillars, min: 'admin',
    handler: async (c) => {
      const { pillars } = c.body as z.infer<typeof Pillars>;
      const sum = pillars.reduce((s, p) => s + p.weight, 0);
      if (Math.abs(sum - 100) > 0.01) throw badRequest(`Tổng tỷ trọng phải bằng 100% (hiện ${sum}%)`);
      await tx(async (cl) => {
        if (!(await cl.query('SELECT 1 FROM brands WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId])).rowCount) throw notFound();
        await cl.query('DELETE FROM content_pillars WHERE brand_id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
        for (const p of pillars) await cl.query('INSERT INTO content_pillars(workspace_id, brand_id, name, weight, description) VALUES ($1,$2,$3,$4,$5)', [c.workspaceId, c.params.id, p.name, p.weight, p.description]);
      });
      await audit(c.workspaceId, c.user.id, 'brand.pillars.update', 'brand', c.params.id);
      return { ok: true };
    },
  },
  ...crud({ path: '/products', table: 'products', filters: ['brand_id'], shape: { brand_id: z.string().uuid(), name: z.string().min(1).max(200), category: z.string().max(100).nullish(), description: z.string().max(2000).default(''), url: z.string().max(500).nullish() } }),
  ...crud({ path: '/audiences', table: 'audience_profiles', filters: ['brand_id'], shape: { brand_id: z.string().uuid(), name: z.string().min(1).max(200), description: z.string().max(2000).default(''), pain_points: z.array(z.string()).default([]), desires: z.array(z.string()).default([]) } }),
  ...crud({ path: '/campaigns', table: 'campaigns', shape: { brand_id: z.string().uuid().nullish(), name: z.string().min(1).max(200), goal: z.string().max(1000).default(''), start_date: z.string().nullish(), end_date: z.string().nullish(), status: z.enum(['draft', 'active', 'done', 'archived']).default('active') } }),
  ...crud({
    path: '/channels', table: 'channels', order: 'created_at ASC',
    shape: {
      brand_id: z.string().uuid().nullish(), name: z.string().min(1).max(200), platform: z.enum(['facebook_profile', 'facebook_page', 'facebook_reels', 'tiktok', 'youtube', 'youtube_shorts', 'other']),
      url: z.string().max(500).nullish(), avatar_url: z.string().max(500).nullish(), target_audience: z.string().max(500).default(''), content_pillars: z.array(z.string()).default([]),
      kpi: z.object({ posts_per_day: z.number().min(0).max(50).optional(), short_videos_per_day: z.number().min(0).max(50).optional(), originals_per_30_days: z.number().min(0).max(5000).optional() }).default({}),
      connection_status: z.enum(['not_connected', 'manual', 'connected', 'error']).default('manual'), credentials_ref: z.string().max(200).nullish(), is_satellite: z.boolean().default(false),
    },
  }),
  ...crud({
    path: '/characters', table: 'characters', order: 'kind, name', filters: ['kind'],
    shape: {
      brand_id: z.string().uuid().nullish(), kind: z.enum(['character', 'product', 'location', 'logo', 'voice', 'outfit']).default('character'), name: z.string().min(1).max(200), tag: z.string().max(60).nullish(),
      description: z.string().max(2000).default(''), reference_asset_id: z.string().uuid().nullish(), consent_confirmed: z.boolean().default(false),
    },
  }),
];

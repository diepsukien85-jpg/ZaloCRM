import { one, q } from '../db';

export type BrandDna = {
  positioning?: string; personality?: string; voice?: string; values?: string[]; goals?: string[];
  audiences?: string[]; products?: string[]; rules?: string[]; avoid?: string[]; about?: string;
};
export type BrandCtx = { id: string; name: string; kind: string; website: string | null; dna: BrandDna; pillars: { name: string; weight: number }[] };

export async function loadBrandCtx(workspaceId: string, brandId?: string | null): Promise<BrandCtx | null> {
  const b = brandId
    ? await one<{ id: string; name: string; kind: string; website: string | null }>('SELECT id,name,kind,website FROM brands WHERE id=$1 AND workspace_id=$2', [brandId, workspaceId])
    : await one<{ id: string; name: string; kind: string; website: string | null }>("SELECT id,name,kind,website FROM brands WHERE workspace_id=$1 AND is_active ORDER BY (kind='personal') DESC, created_at LIMIT 1", [workspaceId]);
  if (!b) return null;
  const d = await one<{ data: BrandDna }>('SELECT data FROM brand_dna WHERE brand_id=$1 AND workspace_id=$2', [b.id, workspaceId]);
  const pillars = await q<{ name: string; weight: number }>('SELECT name, weight FROM content_pillars WHERE brand_id=$1 AND workspace_id=$2 ORDER BY weight DESC', [b.id, workspaceId]);
  return { ...b, dna: d?.data ?? {}, pillars };
}

/** Rút gọn DNA thành khối văn bản đưa vào prompt (Brand DNA Agent: mọi agent khác đều đọc DNA này). */
export function dnaToText(b: BrandCtx): string {
  const d = b.dna;
  const L = (t: string, v?: string | string[]) => (v && (Array.isArray(v) ? v.length : v)) ? `${t}: ${Array.isArray(v) ? v.join('; ') : v}` : '';
  return [
    `Thương hiệu: ${b.name} (${b.kind === 'personal' ? 'cá nhân' : 'doanh nghiệp'})${b.website ? ' – ' + b.website : ''}`,
    L('Giới thiệu', d.about), L('Định vị', d.positioning), L('Tính cách', d.personality), L('Giọng văn', d.voice),
    L('Giá trị cốt lõi', d.values), L('Mục tiêu', d.goals), L('Khách hàng mục tiêu', d.audiences), L('Sản phẩm/lĩnh vực', d.products),
    L('Quy tắc nội dung', d.rules), L('Tránh', d.avoid),
    b.pillars.length ? 'Trụ cột nội dung & tỷ trọng: ' + b.pillars.map((p) => `${p.name} ${p.weight}%`).join('; ') : '',
  ].filter(Boolean).join('\n');
}

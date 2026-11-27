import { z } from 'zod';
import fs from 'node:fs';
import { one, q, tx } from '../db';
import { notFound, badRequest } from '../errors';
import { buildAllFlowPrompts, buildFlowPrompt, buildSrt, type FlowCharacter, type FlowScene } from '../services/flow';
import { buildZip } from '../zip';
import { assetPath } from '../services/media';
import { contentDisposition } from '../http';
import type { RouteDef } from '../router';

type SceneRow = FlowScene & { id: string; project_id: string; character_id: string | null; reference_asset_id: string | null; approval_status: string; prompt: string; generated_asset_id: string | null };

const SceneIn = z.object({
  duration_sec: z.number().int().min(1).max(60).optional(), shot_description: z.string().max(3000).optional(), dialogue: z.string().max(3000).optional(), voiceover: z.string().max(3000).optional(),
  camera: z.string().max(500).optional(), lighting: z.string().max(500).optional(), audio: z.string().max(500).optional(), on_screen_text: z.string().max(300).optional(),
  environment: z.string().max(500).optional(), outfit: z.string().max(500).optional(), prompt: z.string().max(8000).optional(), character_id: z.string().uuid().nullish(),
  reference_asset_id: z.string().uuid().nullish(), generated_asset_id: z.string().uuid().nullish(), approval_status: z.enum(['draft', 'approved', 'rejected']).optional(),
});
const SCENE_COLS = ['duration_sec', 'shot_description', 'dialogue', 'voiceover', 'camera', 'lighting', 'audio', 'on_screen_text', 'environment', 'outfit', 'prompt', 'character_id', 'reference_asset_id', 'generated_asset_id', 'approval_status'];

async function loadProject(ws: string, id: string) {
  const p = await one<{ id: string; title: string; aspect_ratio: string; duration_sec: number; content_id: string | null; status: string; script: unknown; notes: string; is_demo: boolean }>('SELECT * FROM video_projects WHERE id=$1 AND workspace_id=$2', [id, ws]);
  if (!p) throw notFound('Không tìm thấy dự án video');
  const scenes = await q<SceneRow>('SELECT * FROM video_scenes WHERE project_id=$1 AND workspace_id=$2 ORDER BY scene_no', [id, ws]);
  return { p, scenes };
}
async function characterFor(ws: string, s: { character_id: string | null }): Promise<FlowCharacter> {
  if (!s.character_id) return null;
  return one<{ name: string; tag: string | null; description: string; consent_confirmed: boolean }>('SELECT name, tag, description, consent_confirmed FROM characters WHERE id=$1 AND workspace_id=$2', [s.character_id, ws]);
}
async function renumber(ws: string, projectId: string, ids: string[]) {
  await tx(async (c) => {
    await c.query('UPDATE video_scenes SET scene_no = scene_no + 10000 WHERE project_id=$1 AND workspace_id=$2', [projectId, ws]);
    for (const [i, id] of ids.entries()) await c.query('UPDATE video_scenes SET scene_no=$3 WHERE id=$1 AND project_id=$2', [id, projectId, i + 1]);
  });
}
async function regenPrompts(ws: string, projectId: string, onlyScene?: string) {
  const { p, scenes } = await loadProject(ws, projectId);
  const sorted = [...scenes].sort((a, b) => a.scene_no - b.scene_no);
  for (const [i, s] of sorted.entries()) {
    if (onlyScene && s.id !== onlyScene) continue;
    const prompt = buildFlowPrompt(s, { character: await characterFor(ws, s), aspectRatio: p.aspect_ratio, prev: sorted[i - 1] ?? null, projectTitle: p.title });
    await q('UPDATE video_scenes SET prompt=$3 WHERE id=$1 AND workspace_id=$2', [s.id, ws, prompt]);
  }
}

export const videoRoutes: RouteDef[] = [
  {
    method: 'GET', path: '/video/projects',
    handler: async (c) => ({ items: await q('SELECT p.*, (SELECT count(*) FROM video_scenes s WHERE s.project_id=p.id) AS scene_count FROM video_projects p WHERE p.workspace_id=$1 ORDER BY p.created_at DESC LIMIT 200', [c.workspaceId]) }),
  },
  {
    method: 'POST', path: '/video/projects', schema: z.object({ title: z.string().min(1).max(200), duration_sec: z.number().int().min(5).max(1800).default(30), aspect_ratio: z.enum(['9:16', '16:9', '1:1', '4:5']).default('9:16'), content_id: z.string().uuid().nullish() }),
    handler: async (c) => {
      const b = c.body as { title: string; duration_sec: number; aspect_ratio: string; content_id?: string | null };
      return one('INSERT INTO video_projects(workspace_id, content_id, title, duration_sec, aspect_ratio) VALUES ($1,$2,$3,$4,$5) RETURNING *', [c.workspaceId, b.content_id ?? null, b.title, b.duration_sec, b.aspect_ratio]);
    },
  },
  {
    method: 'GET', path: '/video/projects/:id',
    handler: async (c) => ({ ...(await loadProject(c.workspaceId, c.params.id)) }),
  },
  {
    method: 'PATCH', path: '/video/projects/:id', schema: z.object({ title: z.string().min(1).max(200).optional(), aspect_ratio: z.enum(['9:16', '16:9', '1:1', '4:5']).optional(), status: z.enum(['planning', 'scripted', 'in_production', 'done', 'archived']).optional(), notes: z.string().max(5000).optional() }),
    handler: async (c) => {
      const b = c.body as Record<string, string | undefined>;
      const r = await one('UPDATE video_projects SET title=COALESCE($3,title), aspect_ratio=COALESCE($4,aspect_ratio), status=COALESCE($5,status), notes=COALESCE($6,notes) WHERE id=$1 AND workspace_id=$2 RETURNING *', [c.params.id, c.workspaceId, b.title ?? null, b.aspect_ratio ?? null, b.status ?? null, b.notes ?? null]);
      if (!r) throw notFound();
      return r;
    },
  },
  { method: 'DELETE', path: '/video/projects/:id', handler: async (c) => { await q('DELETE FROM video_projects WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]); return { ok: true }; } },

  // ----- Scenes -----
  {
    method: 'POST', path: '/video/projects/:id/scenes', schema: SceneIn,
    handler: async (c) => {
      await loadProject(c.workspaceId, c.params.id);
      const b = c.body as Record<string, unknown>;
      const n = (await one<{ n: number }>('SELECT COALESCE(MAX(scene_no),0)+1 AS n FROM video_scenes WHERE project_id=$1', [c.params.id]))!.n;
      const r = await one<{ id: string }>('INSERT INTO video_scenes(workspace_id, project_id, scene_no, duration_sec, shot_description, dialogue, voiceover, camera, lighting, audio, environment, outfit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
        [c.workspaceId, c.params.id, n, b.duration_sec ?? 8, b.shot_description ?? '', b.dialogue ?? '', b.voiceover ?? '', b.camera ?? '', b.lighting ?? '', b.audio ?? '', b.environment ?? '', b.outfit ?? '']);
      await regenPrompts(c.workspaceId, c.params.id, r!.id);
      return one('SELECT * FROM video_scenes WHERE id=$1', [r!.id]);
    },
  },
  {
    method: 'PATCH', path: '/video/scenes/:id', schema: SceneIn,
    handler: async (c) => {
      const b = c.body as Record<string, unknown>;
      const cols = Object.keys(b).filter((k) => SCENE_COLS.includes(k) && b[k] !== undefined);
      if (!cols.length) return one('SELECT * FROM video_scenes WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      const r = await one<{ project_id: string }>(`UPDATE video_scenes SET ${cols.map((k, i) => `${k}=$${i + 3}`).join(',')} WHERE id=$1 AND workspace_id=$2 RETURNING *`, [c.params.id, c.workspaceId, ...cols.map((k) => b[k])]);
      if (!r) throw notFound();
      return r;
    },
  },
  {
    method: 'DELETE', path: '/video/scenes/:id',
    handler: async (c) => {
      const s = await one<{ project_id: string }>('DELETE FROM video_scenes WHERE id=$1 AND workspace_id=$2 RETURNING project_id', [c.params.id, c.workspaceId]);
      if (!s) throw notFound();
      const ids = (await q<{ id: string }>('SELECT id FROM video_scenes WHERE project_id=$1 ORDER BY scene_no', [s.project_id])).map((x) => x.id);
      await renumber(c.workspaceId, s.project_id, ids);
      return { ok: true };
    },
  },
  {
    method: 'POST', path: '/video/scenes/:id/duplicate',
    handler: async (c) => {
      const s = await one<{ project_id: string; scene_no: number }>('SELECT project_id, scene_no FROM video_scenes WHERE id=$1 AND workspace_id=$2', [c.params.id, c.workspaceId]);
      if (!s) throw notFound();
      const copy = await one<{ id: string }>(`INSERT INTO video_scenes(workspace_id, project_id, scene_no, duration_sec, reference_asset_id, character_id, shot_description, dialogue, voiceover, camera, lighting, audio, on_screen_text, environment, outfit, prompt)
        SELECT workspace_id, project_id, 99999, duration_sec, reference_asset_id, character_id, shot_description, dialogue, voiceover, camera, lighting, audio, on_screen_text, environment, outfit, prompt FROM video_scenes WHERE id=$1 RETURNING id`, [c.params.id]);
      const ids = (await q<{ id: string }>('SELECT id FROM video_scenes WHERE project_id=$1 AND id <> $2 ORDER BY scene_no', [s.project_id, copy!.id])).map((x) => x.id);
      ids.splice(s.scene_no, 0, copy!.id);
      await renumber(c.workspaceId, s.project_id, ids);
      return { ok: true };
    },
  },
  {
    method: 'POST', path: '/video/projects/:id/reorder', schema: z.object({ scene_ids: z.array(z.string().uuid()).min(1) }),
    handler: async (c) => {
      const ids = (c.body as { scene_ids: string[] }).scene_ids;
      const { scenes } = await loadProject(c.workspaceId, c.params.id);
      if (ids.length !== scenes.length || !scenes.every((s) => ids.includes(s.id))) throw badRequest('Danh sách cảnh không khớp dự án');
      await renumber(c.workspaceId, c.params.id, ids);
      await regenPrompts(c.workspaceId, c.params.id);
      return { ok: true };
    },
  },
  {
    // Tạo lại prompt Google Flow (xác định, không tốn AI). Có thể cho một cảnh hoặc cả dự án.
    method: 'POST', path: '/video/projects/:id/prompts', schema: z.object({ scene_id: z.string().uuid().optional() }),
    handler: async (c) => { await regenPrompts(c.workspaceId, c.params.id, (c.body as { scene_id?: string }).scene_id); return (await loadProject(c.workspaceId, c.params.id)).scenes; },
  },

  // ----- Xuất -----
  {
    method: 'GET', path: '/video/projects/:id/export',
    handler: async (c) => {
      const { p, scenes } = await loadProject(c.workspaceId, c.params.id);
      const kind = c.query.get('kind') ?? 'storyboard';
      const safe = p.title.slice(0, 30).replace(/[^\p{L}\p{N}]+/gu, '-');
      const send = (body: string | Buffer, type: string, ext: string) => new Response(new Uint8Array(typeof body === 'string' ? Buffer.from(body, 'utf8') : body), { headers: { 'content-type': type, 'content-disposition': contentDisposition(`${safe}.${ext}`) } });
      const storyboard = () => `# ${p.title}\n\nTỷ lệ: ${p.aspect_ratio} · Thời lượng: ${scenes.reduce((s, x) => s + x.duration_sec, 0)}s\n\n` + scenes.map((s) => `## Cảnh ${s.scene_no} (${s.duration_sec}s) — ${s.approval_status}\n- Mô tả: ${s.shot_description}\n- Thoại: ${s.dialogue}\n- Voiceover: ${s.voiceover}\n- Máy quay: ${s.camera}\n- Ánh sáng: ${s.lighting}\n- Âm thanh: ${s.audio}\n- Chữ trên màn hình: ${s.on_screen_text ?? ''}\n`).join('\n');
      const dialogue = () => scenes.map((s) => `[Cảnh ${s.scene_no}] ${[s.dialogue, s.voiceover].filter(Boolean).join(' / ')}`).join('\n');
      const flow = () => scenes.map((s) => (s.prompt?.trim() ? s.prompt : buildAllFlowPrompts(scenes, { character: null, aspectRatio: p.aspect_ratio, projectTitle: p.title }).find((x) => x.scene_no === s.scene_no)!.prompt)).join('\n\n----------\n\n');
      if (kind === 'srt') return send(buildSrt(scenes), 'application/x-subrip; charset=utf-8', 'srt');
      if (kind === 'dialogue') return send(dialogue(), 'text/plain; charset=utf-8', 'txt');
      if (kind === 'flow') return send(flow(), 'text/plain; charset=utf-8', 'txt');
      if (kind === 'zip') {
        const files = [
          { name: 'storyboard.md', data: storyboard() }, { name: 'loi-thoai.txt', data: dialogue() }, { name: 'prompts-google-flow.txt', data: flow() },
          { name: 'phu-de.srt', data: buildSrt(scenes) }, { name: 'project.json', data: JSON.stringify({ project: p, scenes }, null, 2) },
        ];
        // Đính kèm file tham chiếu/tài sản đã tải lên (nếu có trên đĩa)
        const assetIds = [...new Set(scenes.flatMap((s) => [s.reference_asset_id, s.generated_asset_id]).filter(Boolean))] as string[];
        for (const id of assetIds) {
          const a = await one<{ filename: string; storage_path: string }>('SELECT filename, storage_path FROM media_assets WHERE id=$1 AND workspace_id=$2', [id, c.workspaceId]);
          if (a && fs.existsSync(assetPath(a.storage_path))) files.push({ name: `assets/${a.filename}`, data: fs.readFileSync(assetPath(a.storage_path)) as unknown as string });
        }
        return send(buildZip(files), 'application/zip', 'zip');
      }
      return send(storyboard(), 'text/markdown; charset=utf-8', 'md');
    },
  },
];

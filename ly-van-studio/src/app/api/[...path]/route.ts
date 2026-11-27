import { dispatch, register } from '@/lib/router';
import { authRoutes } from '@/lib/api/auth';
import { brandRoutes } from '@/lib/api/brands';
import { researchRoutes } from '@/lib/api/research';
import { contentRoutes } from '@/lib/api/content';
import { videoRoutes } from '@/lib/api/video';
import { opsRoutes } from '@/lib/api/ops';
import { systemRoutes } from '@/lib/api/system';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

let ready = false;
function init() {
  if (ready) return;
  ready = true;
  // Thứ tự quan trọng: route cụ thể (vd /keywords/export.csv) đặt trước route có tham số.
  for (const r of [authRoutes, brandRoutes, researchRoutes, contentRoutes, videoRoutes, opsRoutes, systemRoutes]) register(r);
}

type Ctx = { params: Promise<{ path: string[] }> };
const h = async (req: Request, { params }: Ctx) => { init(); return dispatch(req, (await params).path); };
export const GET = h, POST = h, PUT = h, PATCH = h, DELETE = h;

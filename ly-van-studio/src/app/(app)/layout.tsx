import { redirect } from 'next/navigation';
import { getAuth } from '@/lib/auth';
import { q } from '@/lib/db';
import { Shell } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const a = await getAuth();
  if (!a) redirect('/login');
  const workspaces = await q<{ id: string; name: string; role: string }>(
    'SELECT w.id, w.name, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at', [a.user.id]);
  return <Shell me={{ user: a.user, workspaceId: a.workspaceId, role: a.role, workspaces }}>{children}</Shell>;
}

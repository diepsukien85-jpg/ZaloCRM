import { registerUser } from '@/lib/auth';
import { bootstrapWorkspace } from '@/lib/services/bootstrap';
import { pool } from '@/lib/db';

let n = 0;
export async function makeWorkspace(label = 'ws') {
  const email = `${label}-${Date.now()}-${n++}@test.local`;
  const r = await registerUser(email, 'password123', label, `WS ${label} ${n}`);
  if (!r) throw new Error('register failed');
  await bootstrapWorkspace(r.workspaceId, r.userId);
  return { ...r, email };
}
export async function closePool() { await pool().end(); (globalThis as unknown as { __pool?: unknown }).__pool = undefined; }

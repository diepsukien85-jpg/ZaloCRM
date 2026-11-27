import { q } from './db';
import type { PoolClient } from 'pg';

export async function audit(workspaceId: string | null, userId: string | null, action: string, entityType?: string, entityId?: string, detail: Record<string, unknown> = {}, c?: PoolClient) {
  await q('INSERT INTO audit_logs(workspace_id, user_id, action, entity_type, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6)',
    [workspaceId, userId, action, entityType ?? null, entityId ?? null, JSON.stringify(detail)], c);
}

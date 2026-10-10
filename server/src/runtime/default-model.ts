import type { Pool } from 'pg';
import { DEFAULT_AGENT_MODEL_ID } from '@kla-workstation/contracts';

/** Only initialize once. Explicit edits (including unmounting) must win over provisioning. */
export async function initializeDefaultAgentModels(db: Pick<Pool, 'query'>, identityId: string): Promise<number> {
  const result = await db.query(`UPDATE agents a SET
      model_key_id=k.id, model_id=COALESCE(a.model_id,$2), model_mount_initialized=true,
      version=a.version+1
    FROM (SELECT id FROM compute_keys WHERE identity_id=$1 AND is_default AND status='active'
      AND (expires_at IS NULL OR expires_at>now()) ORDER BY created_at,id LIMIT 1) k
    WHERE a.identity_id=$1 AND NOT a.model_mount_initialized AND a.model_key_id IS NULL
      AND EXISTS(SELECT 1 FROM models m WHERE m.id=COALESCE(a.model_id,$2) AND m.enabled)`,
  [identityId, DEFAULT_AGENT_MODEL_ID]);
  return result.rowCount ?? 0;
}

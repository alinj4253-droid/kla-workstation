-- Existing complete mounts are user choices. Incomplete legacy mounts get their
-- own identity's default Key; a model already selected is retained.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_mount_initialized boolean NOT NULL DEFAULT false;
UPDATE agents SET model_mount_initialized=true WHERE model_key_id IS NOT NULL;

WITH default_keys AS (
  SELECT DISTINCT ON (identity_id) id,identity_id FROM compute_keys
  WHERE is_default AND status='active' AND (expires_at IS NULL OR expires_at>now())
  ORDER BY identity_id,created_at,id
)
UPDATE agents a SET model_key_id=k.id,
  model_id=COALESCE(a.model_id,'zhipu/glm-5.3-flash'),
  model_mount_initialized=true, version=a.version+1
FROM default_keys k
WHERE a.identity_id=k.identity_id
  AND NOT a.model_mount_initialized AND a.model_key_id IS NULL
  AND EXISTS(SELECT 1 FROM models m WHERE m.id=COALESCE(a.model_id,'zhipu/glm-5.3-flash') AND m.enabled);

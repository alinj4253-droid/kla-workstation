ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_key_id uuid REFERENCES compute_keys(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_agents_model_key ON agents(model_key_id) WHERE model_key_id IS NOT NULL;

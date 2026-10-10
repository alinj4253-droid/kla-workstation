CREATE TABLE IF NOT EXISTS runtime_skill_catalog (
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  tool_codes text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(identity_id, code)
);
CREATE TABLE IF NOT EXISTS agent_skill_mounts (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(agent_id, skill_code)
);
CREATE TABLE IF NOT EXISTS agent_tool_mounts (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(agent_id, tool_code)
);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS capabilities_initialized boolean NOT NULL DEFAULT false;
-- Preserve existing per-agent grants as direct mounts; the old rows remain as historical data.
INSERT INTO agent_tool_mounts(agent_id, tool_code)
SELECT s.agent_id, s.definition->>'code' FROM skills s
WHERE s.enabled AND s.definition ? 'code'
ON CONFLICT DO NOTHING;
UPDATE agents SET capabilities_initialized=true WHERE EXISTS(SELECT 1 FROM skills WHERE skills.agent_id=agents.id);

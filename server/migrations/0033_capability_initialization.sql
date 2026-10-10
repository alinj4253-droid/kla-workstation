ALTER TABLE agents ADD COLUMN IF NOT EXISTS capabilities_initialized boolean NOT NULL DEFAULT false;
UPDATE agents SET capabilities_initialized=true
WHERE NOT capabilities_initialized AND EXISTS(SELECT 1 FROM skills WHERE skills.agent_id=agents.id);

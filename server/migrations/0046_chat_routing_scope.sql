-- Chat routing and identity scope.
-- A run is created only for an explicit agent/command mention and must execute
-- as the identity that sent the trigger message, never as the project owner.
ALTER TABLE conversation_runs
  ADD COLUMN IF NOT EXISTS trigger_identity_id uuid REFERENCES identities(id) ON DELETE SET NULL;
ALTER TABLE conversation_runs
  ADD COLUMN IF NOT EXISTS route_mode text NOT NULL DEFAULT 'coordinator_complex';
ALTER TABLE conversation_runs DROP CONSTRAINT IF EXISTS conversation_runs_route_mode_check;
ALTER TABLE conversation_runs ADD CONSTRAINT conversation_runs_route_mode_check
  CHECK (route_mode IN ('direct_agent','coordinator_simple','coordinator_complex'));
CREATE INDEX IF NOT EXISTS conversation_runs_identity_idx
  ON conversation_runs(conversation_id, trigger_identity_id, created_at DESC);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sender_identity_id uuid REFERENCES identities(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS messages_sender_identity_idx
  ON messages(conversation_id, sender_identity_id, created_at);

-- Backfill historical user messages where the project owner is the only
-- unambiguous identity available. New writes always provide this explicitly.
UPDATE messages m
SET sender_identity_id = p.owner_identity_id
FROM conversations c
JOIN projects p ON p.id = c.project_id
WHERE m.conversation_id = c.id
  AND m.sender_type = 'user'
  AND m.sender_identity_id IS NULL;

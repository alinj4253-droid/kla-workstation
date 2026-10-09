ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_reinforced_at timestamptz;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count integer NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence double precision NOT NULL DEFAULT 0.5;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS importance double precision NOT NULL DEFAULT 0.5;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS retained_until timestamptz;

UPDATE memories SET last_reinforced_at=created_at WHERE last_reinforced_at IS NULL;
UPDATE memories SET retained_until=created_at + interval '365 days'
WHERE kind IN ('short_term','short-term','task_summary','task_context') AND retained_until IS NULL;

CREATE OR REPLACE FUNCTION set_memory_lifecycle() RETURNS trigger AS $$
BEGIN
  NEW.last_reinforced_at := COALESCE(NEW.last_reinforced_at, NEW.created_at, now());
  IF NEW.kind IN ('short_term','short-term','task_summary','task_context') THEN
    NEW.retained_until := NEW.created_at + interval '365 days';
  ELSE
    NEW.retained_until := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS memories_lifecycle ON memories;
CREATE TRIGGER memories_lifecycle BEFORE INSERT OR UPDATE OF kind,created_at ON memories
FOR EACH ROW EXECUTE FUNCTION set_memory_lifecycle();
CREATE INDEX IF NOT EXISTS memories_retention_idx ON memories(retained_until) WHERE retained_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_conversation_agent_idx ON memories
  ((COALESCE(metadata->>'conversationId',metadata->>'chatId')),(metadata->>'agentId'),last_reinforced_at DESC)
  WHERE kind IN ('short_term','short-term','task_summary','task_context');
CREATE UNIQUE INDEX IF NOT EXISTS memories_task_run_idx ON memories
  (workspace_id,(metadata->>'conversationId'),(metadata->>'agentId'),(metadata->>'runId'))
  WHERE kind='task_summary' AND metadata->>'runId' IS NOT NULL AND metadata->>'captureVersion'='1';

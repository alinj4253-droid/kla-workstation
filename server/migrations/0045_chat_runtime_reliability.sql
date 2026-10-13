ALTER TABLE conversation_runs
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

ALTER TABLE conversation_run_steps
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS user_message_idempotency
  ON messages (conversation_id, (metadata->>'clientRequestId'))
  WHERE sender_type='user' AND metadata ? 'clientRequestId';

CREATE UNIQUE INDEX IF NOT EXISTS conversation_run_trigger_unique
  ON conversation_runs (trigger_message_id)
  WHERE trigger_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS conversation_runs_due_idx
  ON conversation_runs (next_attempt_at, created_at)
  WHERE status IN ('queued','running','waiting_device','waiting_tool','waiting_approval');

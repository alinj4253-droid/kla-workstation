CREATE INDEX IF NOT EXISTS conversation_runs_active_queue_idx
  ON conversation_runs (conversation_id, created_at, id)
  WHERE status IN ('queued','running','waiting_device','waiting_tool','waiting_approval');

CREATE INDEX IF NOT EXISTS conversation_run_steps_runtime_state_idx
  ON conversation_run_steps (run_id, updated_at DESC, id);

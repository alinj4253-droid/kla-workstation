-- Execution bindings are immutable. Switching away and back never revives old work.
CREATE TABLE IF NOT EXISTS home_ai_execution_bindings (
  step_id uuid PRIMARY KEY REFERENCES conversation_run_steps(id) ON DELETE CASCADE,
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id uuid REFERENCES home_ai_sessions(id),
  binding_version bigint NOT NULL CHECK(binding_version >= 0),
  trigger_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((session_id IS NULL AND binding_version=0) OR (session_id IS NOT NULL AND binding_version>=1))
);
CREATE TABLE IF NOT EXISTS home_ai_session_messages (
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES home_ai_sessions(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY(identity_id,conversation_id,message_id)
);
CREATE INDEX IF NOT EXISTS home_ai_session_messages_session_idx ON home_ai_session_messages(session_id);
CREATE TABLE IF NOT EXISTS home_ai_session_artifacts (
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES home_ai_sessions(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  PRIMARY KEY(artifact_id)
);
CREATE INDEX IF NOT EXISTS home_ai_session_artifacts_session_idx ON home_ai_session_artifacts(session_id);

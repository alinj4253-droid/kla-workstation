ALTER TABLE home_ai_sessions ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';
-- No legacy state is rewritten and ambiguous historical sessions are never selected.
CREATE TABLE IF NOT EXISTS home_ai_current_bindings (
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES home_ai_sessions(id),
  binding_version bigint NOT NULL CHECK (binding_version >= 1),
  PRIMARY KEY (identity_id,conversation_id)
);

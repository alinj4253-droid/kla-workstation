CREATE TABLE IF NOT EXISTS home_ai_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS home_ai_sessions_scope_idx ON home_ai_sessions(identity_id,conversation_id,created_at DESC);
CREATE TABLE IF NOT EXISTS home_ai_operations (
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  input_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(identity_id,conversation_id,operation_key)
);
CREATE TABLE IF NOT EXISTS agent_market_installations (
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  template_code text NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(identity_id,template_code)
);

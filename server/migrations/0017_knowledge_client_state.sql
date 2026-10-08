CREATE TABLE IF NOT EXISTS knowledge_client_state (
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  name text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (identity_id, name)
);

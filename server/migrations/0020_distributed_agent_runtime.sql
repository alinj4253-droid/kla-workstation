ALTER TABLE agents ADD COLUMN IF NOT EXISTS execution_location text NOT NULL DEFAULT 'server' CHECK (execution_location IN ('server','local'));
ALTER TABLE agents ADD COLUMN IF NOT EXISTS device_id uuid;
UPDATE agents SET execution_location='server',device_id=NULL WHERE name='统筹智能体';
ALTER TABLE agents ADD CONSTRAINT coordinator_server_only CHECK (name <> '统筹智能体' OR (execution_location='server' AND device_id IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS builtin_skill_code ON skills(agent_id,(definition->>'code')) WHERE definition ? 'code';
CREATE TABLE IF NOT EXISTS execution_devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, installation_id uuid NOT NULL,
 name text NOT NULL, platform text NOT NULL, capabilities jsonb NOT NULL DEFAULT '[]',
 enabled boolean NOT NULL DEFAULT true, last_seen_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(identity_id,installation_id)
);
ALTER TABLE conversation_runs DROP CONSTRAINT IF EXISTS conversation_runs_status_check;
ALTER TABLE conversation_runs ADD CONSTRAINT conversation_runs_status_check CHECK (status IN ('queued','running','waiting_device','waiting_tool','waiting_approval','completed','failed','cancelled'));
ALTER TABLE conversation_runs ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'coordination';
ALTER TABLE conversation_runs ADD COLUMN IF NOT EXISTS lease_owner uuid;
ALTER TABLE conversation_runs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE conversation_runs ADD COLUMN IF NOT EXISTS coordinator_snapshot jsonb;
ALTER TABLE conversation_runs ADD COLUMN IF NOT EXISTS registry_snapshot jsonb;
ALTER TABLE conversation_runs ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES execution_devices(id) ON DELETE SET NULL;
ALTER TABLE conversation_run_steps DROP CONSTRAINT IF EXISTS conversation_run_steps_status_check;
ALTER TABLE conversation_run_steps ADD CONSTRAINT conversation_run_steps_status_check CHECK (status IN ('pending','running','waiting_device','waiting_tool','waiting_approval','completed','failed','cancelled'));
ALTER TABLE conversation_run_steps ADD COLUMN IF NOT EXISTS depends_on integer[] NOT NULL DEFAULT '{}';
ALTER TABLE conversation_run_steps ADD COLUMN IF NOT EXISTS agent_snapshot jsonb;
ALTER TABLE conversation_run_steps ADD COLUMN IF NOT EXISTS transcript jsonb NOT NULL DEFAULT '[]';
ALTER TABLE conversation_run_steps ADD COLUMN IF NOT EXISTS turns integer NOT NULL DEFAULT 0;
ALTER TABLE conversation_run_steps ADD COLUMN IF NOT EXISTS lease_owner uuid;
ALTER TABLE conversation_run_steps ADD COLUMN IF NOT EXISTS lease_until timestamptz;
CREATE TABLE IF NOT EXISTS runtime_tool_calls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), step_id uuid NOT NULL REFERENCES conversation_run_steps(id) ON DELETE CASCADE,
 identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE, device_id uuid REFERENCES execution_devices(id) ON DELETE SET NULL,
 model_call_id text NOT NULL, tool_name text NOT NULL, arguments jsonb NOT NULL, status text NOT NULL DEFAULT 'queued'
 CHECK(status IN ('queued','running','completed','failed','cancelled','unknown')),
 result jsonb, receipt_id uuid, dispatched_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(step_id,model_call_id)
);
CREATE INDEX IF NOT EXISTS runtime_tool_calls_device_idx ON runtime_tool_calls(device_id,status,created_at);
CREATE TABLE IF NOT EXISTS runtime_events (
 sequence bigserial PRIMARY KEY, identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
 conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE, run_id uuid REFERENCES conversation_runs(id) ON DELETE CASCADE,
 kind text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runtime_events_scope_idx ON runtime_events(identity_id,conversation_id,sequence);
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS checksum text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS source_device_id uuid REFERENCES execution_devices(id) ON DELETE SET NULL;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS tool_call_id uuid REFERENCES runtime_tool_calls(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS artifact_tool_call ON artifacts(tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS runtime_message_idempotency ON messages ((metadata->>'runtimeKey')) WHERE metadata ? 'runtimeKey';

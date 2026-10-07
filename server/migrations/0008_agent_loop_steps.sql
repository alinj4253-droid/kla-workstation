-- 0008: 智能体循环步骤（自远端内嵌数组原样搬移）
CREATE TABLE IF NOT EXISTS conversation_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES conversation_runs(id) ON DELETE CASCADE,
  step_index integer NOT NULL, title text NOT NULL, instruction text NOT NULL DEFAULT '', assigned_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','cancelled')),
  result jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, step_index)
);
CREATE INDEX IF NOT EXISTS conversation_run_steps_run_idx ON conversation_run_steps(run_id, step_index);

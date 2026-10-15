ALTER TABLE conversation_runs
  ADD COLUMN IF NOT EXISTS execution_access text NOT NULL DEFAULT 'approval';
ALTER TABLE conversation_runs DROP CONSTRAINT IF EXISTS conversation_runs_execution_access_check;
ALTER TABLE conversation_runs ADD CONSTRAINT conversation_runs_execution_access_check
  CHECK (execution_access IN ('approval', 'full'));

ALTER TABLE sany_projects ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE sany_members ADD COLUMN IF NOT EXISTS identity_id uuid REFERENCES identities(id) ON DELETE SET NULL;
ALTER TABLE sany_tasks ADD COLUMN IF NOT EXISTS planning_period text NOT NULL DEFAULT '';
ALTER TABLE sany_tasks ADD COLUMN IF NOT EXISTS assigned_by_identity_id uuid REFERENCES identities(id) ON DELETE SET NULL;
ALTER TABLE sany_tasks ADD COLUMN IF NOT EXISTS assignee_identity_id uuid REFERENCES identities(id) ON DELETE SET NULL;
ALTER TABLE sany_tasks ADD COLUMN IF NOT EXISTS individual_note text NOT NULL DEFAULT '';
ALTER TABLE sany_tasks ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE sany_tasks ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sany_documents ADD COLUMN IF NOT EXISTS storage_key text;
ALTER TABLE sany_documents ADD COLUMN IF NOT EXISTS checksum text;
ALTER TABLE sany_documents ADD COLUMN IF NOT EXISTS content_type text NOT NULL DEFAULT '';
ALTER TABLE sany_documents ADD COLUMN IF NOT EXISTS byte_size bigint NOT NULL DEFAULT 0;
ALTER TABLE sany_output_versions ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES sany_tasks(id) ON DELETE CASCADE;

UPDATE sany_projects p
SET organization_id = i.organization_id
FROM identities i
WHERE p.owner_identity_id = i.id AND p.organization_id IS NULL AND i.organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sany_projects_org_idx ON sany_projects(organization_id, status);
CREATE INDEX IF NOT EXISTS sany_members_identity_idx ON sany_members(project_id, identity_id);
CREATE INDEX IF NOT EXISTS sany_tasks_assignee_idx ON sany_tasks(project_id, assignee_identity_id);
CREATE INDEX IF NOT EXISTS sany_output_versions_task_idx ON sany_output_versions(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sany_task_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES sany_projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES sany_tasks(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES sany_members(id) ON DELETE RESTRICT,
  assignee_identity_id uuid REFERENCES identities(id) ON DELETE SET NULL,
  assigned_by_identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','in_progress','submitted','returned','accepted','closed')),
  individual_note text NOT NULL DEFAULT '',
  assigned_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  submitted_at timestamptz,
  closed_at timestamptz,
  UNIQUE (task_id, member_id)
);
CREATE INDEX IF NOT EXISTS sany_task_assignments_assignee_idx ON sany_task_assignments(assignee_identity_id, status);

CREATE TABLE IF NOT EXISTS sany_task_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES sany_projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES sany_tasks(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES sany_task_assignments(id) ON DELETE RESTRICT,
  submission_no integer NOT NULL,
  submitted_by_identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','returned','accepted','closed')),
  summary text NOT NULL DEFAULT '',
  deliverables jsonb NOT NULL DEFAULT '[]'::jsonb,
  material_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewer_note text NOT NULL DEFAULT '',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, submission_no)
);
CREATE INDEX IF NOT EXISTS sany_task_submissions_task_idx ON sany_task_submissions(task_id, submission_no DESC);

CREATE TABLE IF NOT EXISTS sany_task_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES sany_projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES sany_tasks(id) ON DELETE CASCADE,
  submission_id uuid REFERENCES sany_task_submissions(id) ON DELETE SET NULL,
  actor_identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('returned','accepted','closed','reminded')),
  note text NOT NULL DEFAULT '',
  checks jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sany_task_closures_task_idx ON sany_task_closures(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sany_task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES sany_projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES sany_tasks(id) ON DELETE CASCADE,
  assignment_id uuid REFERENCES sany_task_assignments(id) ON DELETE CASCADE,
  actor_identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sany_task_events_project_idx ON sany_task_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sany_task_events_task_idx ON sany_task_events(task_id, created_at DESC);

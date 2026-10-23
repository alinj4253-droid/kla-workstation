-- 三一战略规划协同平台：项目、成员、任务、材料、字段、冲突、成果与反馈
-- 一个身份（管理员）对应一个进行中的规划项目；业务数据全部落库，前端只保留交互状态。

CREATE TABLE IF NOT EXISTS sany_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  name text NOT NULL,
  org_name text NOT NULL,
  planning_period text NOT NULL,
  plan_year text NOT NULL DEFAULT '2027—2029',
  deadline date,
  intent text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  output_generated boolean NOT NULL DEFAULT false,
  output_released boolean NOT NULL DEFAULT false,
  delivery_checks jsonb NOT NULL DEFAULT '{}'::jsonb,
  decisions jsonb NOT NULL DEFAULT '{}'::jsonb,
  conclusion text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sany_projects_one_active ON sany_projects(owner_identity_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS sany_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES sany_projects(id) ON DELETE CASCADE,
  emp_no text NOT NULL,
  name text NOT NULL,
  title text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('admin','owner')),
  color text NOT NULL DEFAULT '#3a4a63',
  joined_on date NOT NULL DEFAULT current_date,
  status text NOT NULL DEFAULT '在职',
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (project_id, emp_no)
);

CREATE TABLE IF NOT EXISTS sany_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES sany_projects(id) ON DELETE CASCADE,
  code text NOT NULL,
  title text NOT NULL,
  unit text NOT NULL,
  owner_name text NOT NULL,
  task_type text NOT NULL DEFAULT '',
  task_type_name text NOT NULL DEFAULT '',
  deadline date,
  assigned_at date NOT NULL DEFAULT current_date,
  status text NOT NULL DEFAULT '待上传',
  intent text NOT NULL DEFAULT '',
  requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code)
);

CREATE TABLE IF NOT EXISTS sany_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES sany_projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES sany_tasks(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('company','unit')),
  module_key text NOT NULL CHECK (module_key IN ('review','market','biz','plan')),
  name text NOT NULL,
  ext text NOT NULL DEFAULT 'pdf',
  size_label text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT '#3a4a63',
  page_count integer NOT NULL DEFAULT 0,
  claim_count integer NOT NULL DEFAULT 0,
  field_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sany_documents_task_idx ON sany_documents(task_id);
CREATE INDEX IF NOT EXISTS sany_documents_project_idx ON sany_documents(project_id);

CREATE TABLE IF NOT EXISTS sany_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES sany_projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES sany_tasks(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('company','unit')),
  module_key text NOT NULL CHECK (module_key IN ('review','market','biz','plan')),
  field_key text NOT NULL,
  label text NOT NULL,
  field_type text NOT NULL DEFAULT 'text' CHECK (field_type IN ('num','text','table')),
  ai_content text NOT NULL DEFAULT '',
  confidence integer NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  source text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','edited','rejected','missing')),
  human_content text,
  gap text NOT NULL DEFAULT '',
  removed boolean NOT NULL DEFAULT false,
  removed_reason text,
  is_custom boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sany_fields_task_idx ON sany_fields(task_id, module_key, sort_order);
CREATE INDEX IF NOT EXISTS sany_fields_scope_idx ON sany_fields(project_id, scope);

CREATE TABLE IF NOT EXISTS sany_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES sany_projects(id) ON DELETE CASCADE,
  code text NOT NULL,
  level text NOT NULL CHECK (level IN ('阻断','重要','一般')),
  title text NOT NULL,
  detail text NOT NULL DEFAULT '',
  owner_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '待补充',
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (project_id, code)
);

CREATE TABLE IF NOT EXISTS sany_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES sany_projects(id) ON DELETE CASCADE,
  output_key text NOT NULL CHECK (output_key IN ('doc','ppt','diag','package')),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (project_id, output_key)
);

CREATE TABLE IF NOT EXISTS sany_output_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  output_id uuid NOT NULL REFERENCES sany_outputs(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  created_label text NOT NULL,
  created_by text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '待审核',
  summary text NOT NULL DEFAULT '',
  changes text NOT NULL DEFAULT '',
  size_label text NOT NULL DEFAULT '',
  file_name text NOT NULL DEFAULT '',
  audit text,
  page_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (output_id, version_no)
);

CREATE TABLE IF NOT EXISTS sany_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES sany_projects(id) ON DELETE CASCADE,
  author_name text NOT NULL DEFAULT '',
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

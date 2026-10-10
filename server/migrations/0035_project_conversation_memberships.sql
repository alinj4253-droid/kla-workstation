ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT;

UPDATE projects p SET organization_id=i.organization_id
FROM identities i WHERE i.id=p.owner_identity_id AND p.organization_id IS DISTINCT FROM i.organization_id;

CREATE OR REPLACE FUNCTION validate_project_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_type text; owner_org uuid;
BEGIN
  SELECT type,organization_id INTO owner_type,owner_org FROM identities WHERE id=NEW.owner_identity_id;
  IF owner_type IS NULL THEN RAISE EXCEPTION 'project owner identity does not exist'; END IF;
  IF NEW.organization_id IS DISTINCT FROM owner_org THEN
    RAISE EXCEPTION 'project organization must match owner identity';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS projects_scope_guard ON projects;
CREATE TRIGGER projects_scope_guard BEFORE INSERT OR UPDATE OF owner_identity_id,organization_id
ON projects FOR EACH ROW EXECUTE FUNCTION validate_project_scope();

CREATE TABLE IF NOT EXISTS project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','manager','member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,identity_id)
);
CREATE INDEX IF NOT EXISTS project_members_identity_idx ON project_members(identity_id,project_id);

CREATE OR REPLACE FUNCTION validate_project_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_org uuid; project_owner uuid; member_type text; member_org uuid; member_status text;
BEGIN
  SELECT organization_id,owner_identity_id INTO project_org,project_owner FROM projects WHERE id=NEW.project_id;
  SELECT type,organization_id,status INTO member_type,member_org,member_status FROM identities WHERE id=NEW.identity_id;
  IF member_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'project member identity is inactive'; END IF;
  IF project_org IS NULL THEN
    IF member_type <> 'personal' OR NEW.identity_id <> project_owner THEN
      RAISE EXCEPTION 'personal projects cannot be joined by another identity';
    END IF;
  ELSIF member_type <> 'enterprise' OR member_org IS DISTINCT FROM project_org THEN
    RAISE EXCEPTION 'enterprise project member must belong to the same organization';
  END IF;
  IF NEW.role='owner' AND NEW.identity_id <> project_owner THEN
    RAISE EXCEPTION 'only the project owner may hold owner role';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS project_members_scope_guard ON project_members;
CREATE TRIGGER project_members_scope_guard BEFORE INSERT OR UPDATE ON project_members
FOR EACH ROW EXECUTE FUNCTION validate_project_member();

INSERT INTO project_members(project_id,identity_id,role)
SELECT id,owner_identity_id,'owner' FROM projects ON CONFLICT (project_id,identity_id) DO NOTHING;

CREATE OR REPLACE FUNCTION add_project_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO project_members(project_id,identity_id,role) VALUES(NEW.id,NEW.owner_identity_id,'owner');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS projects_add_owner ON projects;
CREATE TRIGGER projects_add_owner AFTER INSERT ON projects FOR EACH ROW EXECUTE FUNCTION add_project_owner();

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','manager','member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id,identity_id),
  FOREIGN KEY (project_id,identity_id) REFERENCES project_members(project_id,identity_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS conversation_members_identity_idx ON conversation_members(identity_id,project_id,conversation_id);

CREATE OR REPLACE FUNCTION validate_conversation_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_project uuid; project_owner uuid;
BEGIN
  SELECT c.project_id,p.owner_identity_id INTO actual_project,project_owner
  FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=NEW.conversation_id;
  IF actual_project IS DISTINCT FROM NEW.project_id THEN RAISE EXCEPTION 'conversation project mismatch'; END IF;
  IF NEW.role='owner' AND NEW.identity_id <> project_owner THEN
    RAISE EXCEPTION 'only the project owner may hold conversation owner role';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS conversation_members_scope_guard ON conversation_members;
CREATE TRIGGER conversation_members_scope_guard BEFORE INSERT OR UPDATE ON conversation_members
FOR EACH ROW EXECUTE FUNCTION validate_conversation_member();

INSERT INTO conversation_members(conversation_id,project_id,identity_id,role)
SELECT c.id,c.project_id,p.owner_identity_id,'owner'
FROM conversations c JOIN projects p ON p.id=c.project_id
ON CONFLICT (conversation_id,identity_id) DO NOTHING;

CREATE OR REPLACE FUNCTION add_conversation_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id uuid;
BEGIN
  SELECT owner_identity_id INTO owner_id FROM projects WHERE id=NEW.project_id;
  INSERT INTO conversation_members(conversation_id,project_id,identity_id,role)
  VALUES(NEW.id,NEW.project_id,owner_id,'owner');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS conversations_add_owner ON conversations;
CREATE TRIGGER conversations_add_owner AFTER INSERT ON conversations FOR EACH ROW EXECUTE FUNCTION add_conversation_owner();

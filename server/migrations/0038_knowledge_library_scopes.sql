-- KLA identity-side registry. The knowledge service owns document/index tables.
CREATE TABLE knowledge_library_scopes (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '',
  collection text NOT NULL CHECK (length(trim(collection)) BETWEEN 1 AND 200),
  scope text NOT NULL CHECK (scope IN ('company', 'project', 'personal')),
  organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
  personal_identity_id uuid REFERENCES identities(id) ON DELETE RESTRICT,
  created_by_identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope='company' AND organization_id IS NOT NULL AND project_id IS NULL AND personal_identity_id IS NULL) OR
    (scope='project' AND project_id IS NOT NULL AND personal_identity_id IS NULL) OR
    (scope='personal' AND organization_id IS NULL AND project_id IS NULL AND personal_identity_id IS NOT NULL)
  )
);
CREATE INDEX knowledge_library_scopes_org_idx ON knowledge_library_scopes(organization_id) WHERE status='active';
CREATE INDEX knowledge_library_scopes_project_idx ON knowledge_library_scopes(project_id) WHERE status='active';
CREATE INDEX knowledge_library_scopes_personal_idx ON knowledge_library_scopes(personal_identity_id) WHERE status='active';

CREATE OR REPLACE FUNCTION validate_knowledge_library_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_org uuid; owner_type text;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.scope,NEW.organization_id,NEW.project_id,NEW.personal_identity_id,NEW.collection)
    IS DISTINCT FROM (OLD.scope,OLD.organization_id,OLD.project_id,OLD.personal_identity_id,OLD.collection) THEN
    RAISE EXCEPTION 'knowledge library ownership cannot be changed';
  END IF;
  IF NEW.scope='project' THEN
    SELECT organization_id INTO project_org FROM projects WHERE id=NEW.project_id;
    IF NOT FOUND OR project_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'knowledge library project organization mismatch';
    END IF;
  ELSIF NEW.scope='personal' THEN
    SELECT type INTO owner_type FROM identities WHERE id=NEW.personal_identity_id;
    IF owner_type IS DISTINCT FROM 'personal' THEN RAISE EXCEPTION 'personal identity required'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_library_scope_guard BEFORE INSERT OR UPDATE ON knowledge_library_scopes
FOR EACH ROW EXECUTE FUNCTION validate_knowledge_library_scope();

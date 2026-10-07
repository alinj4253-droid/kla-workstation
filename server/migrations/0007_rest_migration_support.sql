-- 0007: REST 迁移支持（记忆索引、上传会话）——自远端内嵌数组原样搬移
ALTER TABLE memories ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE memories ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS memories_workspace_kind_idx ON memories(workspace_id, kind, created_at DESC);
CREATE TABLE IF NOT EXISTS upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE, file_name text NOT NULL, content_type text,
  size_bytes bigint NOT NULL DEFAULT 0, checksum text, status text NOT NULL DEFAULT 'created' CHECK(status IN ('created','uploaded','processing','completed','failed','cancelled')),
  storage_key text, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour'
);
CREATE INDEX IF NOT EXISTS upload_sessions_identity_idx ON upload_sessions(identity_id, created_at DESC);

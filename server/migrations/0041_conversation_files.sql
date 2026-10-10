-- 正式文件归属群聊，沿用服务端身份与群聊成员关系；本地路径不作为共享标识。
ALTER TABLE files ADD COLUMN IF NOT EXISTS identity_id uuid REFERENCES identities(id) ON DELETE RESTRICT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE;
UPDATE files f SET identity_id=w.identity_id FROM workspaces w WHERE w.id=f.workspace_id AND f.identity_id IS NULL;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS file_id uuid REFERENCES files(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS files_storage_key_unique_idx ON files(storage_key);
CREATE INDEX IF NOT EXISTS files_conversation_idx ON files(conversation_id,created_at DESC);

-- Only extend already-mounted builtin file capabilities; preserve user removals.
INSERT INTO agent_tool_mounts(agent_id,tool_code)
SELECT DISTINCT agent_id,'local_file_fetch' FROM agent_tool_mounts WHERE tool_code='local_read'
ON CONFLICT DO NOTHING;
INSERT INTO agent_tool_mounts(agent_id,tool_code)
SELECT DISTINCT agent_id,'local_file_publish' FROM agent_tool_mounts WHERE tool_code='local_write'
ON CONFLICT DO NOTHING;
INSERT INTO agent_tool_mounts(agent_id,tool_code)
SELECT DISTINCT agent_id,'file_read' FROM agent_tool_mounts WHERE tool_code='artifact_read'
ON CONFLICT DO NOTHING;

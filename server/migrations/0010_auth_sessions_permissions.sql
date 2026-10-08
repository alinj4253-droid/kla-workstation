ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_id text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_name text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_address inet;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS sessions_device_idx ON sessions(user_id, device_id) WHERE revoked_at IS NULL;
INSERT INTO permissions (code, description) VALUES
  ('read','读取资源'),('write','创建或修改资源'),('execute','执行智能体、操作或任务'),('manage','管理成员、资源和技能'),('export','导出文件和数据')
ON CONFLICT (code) DO NOTHING;

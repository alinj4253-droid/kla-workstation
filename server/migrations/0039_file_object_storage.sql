-- 文件和成果的二进制内容进入对象存储，数据库只保存引用和权限元数据。
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS storage_key text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS storage_status text NOT NULL DEFAULT 'inline'
  CHECK (storage_status IN ('inline','stored','deleted'));
ALTER TABLE files ADD COLUMN IF NOT EXISTS uploaded_at timestamptz;
ALTER TABLE files ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS artifacts_storage_key_idx ON artifacts(storage_key) WHERE storage_key IS NOT NULL;

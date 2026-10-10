-- Keep existing text artifacts unchanged; local PPT results are stored as base64.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS content_encoding text NOT NULL DEFAULT 'utf8';
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_content_encoding_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_content_encoding_check CHECK(content_encoding IN ('utf8','base64'));

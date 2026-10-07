-- 0009: 运营平台与会议（自远端内嵌数组原样搬移）
CREATE TABLE IF NOT EXISTS operation_platforms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  name text NOT NULL, base_url text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(identity_id,name)
);
CREATE TABLE IF NOT EXISTS operation_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), platform_id uuid NOT NULL REFERENCES operation_platforms(id) ON DELETE CASCADE,
  name text NOT NULL, description text NOT NULL DEFAULT '', definition jsonb NOT NULL DEFAULT '{}'::jsonb, enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL, name text NOT NULL, description text NOT NULL DEFAULT '',
  input_type text NOT NULL CHECK(input_type IN ('audio_upload','realtime')), status text NOT NULL DEFAULT 'created',
  transcript text NOT NULL DEFAULT '', summary text NOT NULL DEFAULT '', minutes text NOT NULL DEFAULT '', metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meeting_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  speaker text NOT NULL DEFAULT '未识别说话人', content text NOT NULL, start_ms integer, end_ms integer, confidence numeric(5,4), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meetings_identity_created_idx ON meetings(identity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS meeting_segments_meeting_idx ON meeting_segments(meeting_id, created_at);

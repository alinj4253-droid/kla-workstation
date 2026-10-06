import type { Pool } from 'pg';

const migrations = [
  {
    id: '0004_identity_organizations',
    sql: `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, license_number text,
        invite_code text UNIQUE NOT NULL DEFAULT upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 8)),
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, phone text UNIQUE,
        nickname text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (email IS NOT NULL OR phone IS NOT NULL)
      );
      CREATE TABLE IF NOT EXISTS user_credentials (
        user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, password_hash text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS identities (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type text NOT NULL CHECK (type IN ('personal','enterprise')), display_name text NOT NULL,
        organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
        is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS identities_one_default_per_user ON identities(user_id) WHERE is_default;
      CREATE TABLE IF NOT EXISTS roles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
        name text NOT NULL, description text NOT NULL DEFAULT '', is_system boolean NOT NULL DEFAULT false,
        UNIQUE (organization_id, name)
      );
      CREATE TABLE IF NOT EXISTS permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text UNIQUE NOT NULL, description text NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS identity_roles (identity_id uuid REFERENCES identities(id) ON DELETE CASCADE, role_id uuid REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY(identity_id, role_id));
      CREATE TABLE IF NOT EXISTS role_permissions (role_id uuid REFERENCES roles(id) ON DELETE CASCADE, permission_id uuid REFERENCES permissions(id) ON DELETE CASCADE, PRIMARY KEY(role_id, permission_id));
      CREATE TABLE IF NOT EXISTS sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        access_token_hash text UNIQUE NOT NULL, refresh_token_hash text UNIQUE NOT NULL,
        expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id) WHERE revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS projects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
        name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, text text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_time_idx ON messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS workspaces (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
        type text NOT NULL CHECK (type IN ('enterprise','project','personal')), project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
        name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(identity_id, type, project_id)
      );
      CREATE TABLE IF NOT EXISTS agents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identity_id uuid REFERENCES identities(id) ON DELETE CASCADE,
        name text NOT NULL, role text NOT NULL DEFAULT '', model_id text, type text NOT NULL DEFAULT 'custom',
        enabled boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(identity_id, name)
      );
      CREATE TABLE IF NOT EXISTS skills (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
        name text NOT NULL, description text NOT NULL DEFAULT '', definition jsonb NOT NULL DEFAULT '{}'::jsonb,
        enabled boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS files (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
        name text NOT NULL, storage_key text NOT NULL, checksum text, content_type text, size_bytes bigint NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'uploaded', created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS memories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
        content text NOT NULL, kind text NOT NULL DEFAULT 'long_term', metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identity_id uuid REFERENCES identities(id) ON DELETE CASCADE,
        title text NOT NULL, status text NOT NULL DEFAULT 'pending', result jsonb, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS models (
        id text PRIMARY KEY, name text NOT NULL, provider text NOT NULL, capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
        enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS usage_records (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identity_id uuid REFERENCES identities(id) ON DELETE SET NULL,
        model_id text REFERENCES models(id) ON DELETE SET NULL, input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0,
        cost numeric(18,8) NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO models (id, name, provider, capabilities) VALUES
        ('deepseek-v4-flash', 'DeepSeek V4 Flash', 'deepseek', '{"thinking":false,"streaming":true}'),
        ('zhipu/glm-5.3-flash', 'GLM 5.3 Flash', 'zhipu', '{"vision":true,"streaming":true}')
      ON CONFLICT (id) DO NOTHING;
    `,
  },
  {
    id: '0005_collaboration_runtime',
    sql: `
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_type text NOT NULL DEFAULT 'user';
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name text;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text';
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
      CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages(conversation_id, created_at, id);
      CREATE TABLE IF NOT EXISTS conversation_agents (
        conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        role text NOT NULL DEFAULT 'member',
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (conversation_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
        conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
        name text NOT NULL,
        mime_type text NOT NULL DEFAULT 'text/plain',
        content text NOT NULL DEFAULT '',
        size_bytes bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS artifacts_identity_created_idx ON artifacts(identity_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS conversation_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        trigger_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
        status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
        mode text NOT NULL DEFAULT 'balanced',
        current_agent text,
        result jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS conversation_runs_conversation_idx ON conversation_runs(conversation_id, updated_at DESC);
    `,
  },
  {
    id: '0006_official_model_catalog',
    sql: `
      ALTER TABLE models ADD COLUMN IF NOT EXISTS base_url text;
      ALTER TABLE models ADD COLUMN IF NOT EXISTS is_official boolean NOT NULL DEFAULT false;
      INSERT INTO models (id, name, provider, base_url, is_official, capabilities) VALUES
        ('deepseek-v4-flash', 'DeepSeek V4 Flash', 'deepseek', 'https://zhenze-huhehaote.cmecloud.cn/v1', true, '{"thinking":false,"streaming":true,"context":128000}'),
        ('deepseek-chat', 'DeepSeek Chat', 'deepseek', 'https://api.deepseek.com/v1', true, '{"thinking":false,"streaming":true,"context":64000}'),
        ('deepseek-reasoner', 'DeepSeek Reasoner', 'deepseek', 'https://api.deepseek.com/v1', true, '{"thinking":true,"streaming":true,"context":64000}'),
        ('zhipu/glm-5.3-flash', 'GLM 5.3 Flash', 'zhipu', 'https://moma.cmecloud.cn/v1', true, '{"vision":true,"thinking":false,"streaming":true,"context":128000}'),
        ('glm-4-air', 'GLM 4 Air', 'zhipu', 'https://open.bigmodel.cn/api/paas/v4', true, '{"thinking":false,"streaming":true,"context":128000}'),
        ('qwen-plus', 'Qwen Plus', 'qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', true, '{"thinking":true,"streaming":true,"context":128000}'),
        ('qwen-turbo', 'Qwen Turbo', 'qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', true, '{"thinking":false,"streaming":true,"context":128000}'),
        ('gpt-4o', 'GPT-4o', 'openai', 'https://api.openai.com/v1', true, '{"vision":true,"streaming":true,"context":128000}'),
        ('claude-3-5-sonnet', 'Claude 3.5 Sonnet', 'anthropic', 'https://api.anthropic.com/v1', true, '{"vision":true,"thinking":true,"streaming":true,"context":200000}')
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, provider=EXCLUDED.provider, base_url=EXCLUDED.base_url, is_official=true, capabilities=EXCLUDED.capabilities;
    `,
  },
];

export async function runMigrations(pool: Pool, schema = 'kla'): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error('非法数据库 schema 名称');
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}" AUTHORIZATION CURRENT_USER`);
  const setupClient = await pool.connect();
  await setupClient.query(`SET search_path TO "${schema}", public`);
  await setupClient.query('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  setupClient.release();
  for (const migration of migrations) {
    const checkClient = await pool.connect();
    await checkClient.query(`SET search_path TO "${schema}", public`);
    const existing = await checkClient.query('SELECT 1 FROM schema_migrations WHERE id = $1', [migration.id]);
    checkClient.release();
    if (existing.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}", public`);
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

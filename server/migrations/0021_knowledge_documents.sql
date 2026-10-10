-- 0021: 知识文档目录与文档级访问策略
--
-- 背景：文档与切片由远端知识服务持有（/v1/documents、/v1/documents/{id}/slices），
-- 本地此前只在 knowledge_client_state.bindings.json 里记录「本机上传过」的少量 doc_id，
-- 其余文档的 doc_id 只存在于服务端内存，权限无处落地。
--
-- 本迁移分两张表：
--   knowledge_documents        远端文档的本地目录（doc_id 落库锚点，供权限与统计引用）
--   document_access_policy     文档级访问策略（谁能看哪个文档；切片权限经 doc_id 继承）
--
-- 不为切片单独建表：切片永远跟随父文档，切片 id 在文档内自增（重新切片即变化），
-- 单独存储既冗余又无法保持一致。

CREATE TABLE IF NOT EXISTS knowledge_documents (
  doc_id text PRIMARY KEY,
  collection text NOT NULL,
  name text NOT NULL,
  ext text NOT NULL DEFAULT '',
  abs_path text NOT NULL DEFAULT '',
  size_bytes bigint NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  modified_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE knowledge_documents IS '远端知识服务文档的本地目录，doc_id 是权限与统计的锚点';

CREATE INDEX IF NOT EXISTS knowledge_documents_collection_idx ON knowledge_documents (collection);
CREATE INDEX IF NOT EXISTS knowledge_documents_modified_idx ON knowledge_documents (modified_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS document_access_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  doc_id text NOT NULL,
  collection text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('company', 'project', 'personal')),
  -- 个人知识库：owner 就是本人；项目知识库：归属项目；公司知识库：两者皆空
  owner_identity_id uuid REFERENCES identities(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES identities(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 同一人对同一文档只保留一条授权，重复授权用 upsert 更新
  UNIQUE (identity_id, doc_id)
);
COMMENT ON TABLE document_access_policy IS '文档级访问策略；切片等子资源经 doc_id 继承，不再单表';

CREATE INDEX IF NOT EXISTS document_access_policy_identity_scope_idx ON document_access_policy (identity_id, scope);
CREATE INDEX IF NOT EXISTS document_access_policy_project_idx ON document_access_policy (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS document_access_policy_collection_idx ON document_access_policy (collection);
-- 按 doc_id 反查「哪些人有权」，用于检索命中过滤时批量裁决
CREATE INDEX IF NOT EXISTS document_access_policy_doc_idx ON document_access_policy (doc_id);

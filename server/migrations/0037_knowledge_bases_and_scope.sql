-- 0037: 知识库归属（企业/项目/个人）与上传意图
--
-- 依据 docs/KNOWLEDGE_SCOPE_API_AND_ACL_PLAN.md（2026-10-10 设计方案）：
--   1) knowledge_bases        权威知识库目录（scope + 三个归属列 + CHECK 互斥约束）
--   2) knowledge_documents    扩展 knowledge_base_id（迁移期可空）与 access_mode
--   3) document_access_policy 增补 knowledge_base_id（仅作单文档收紧授权）
--   4) knowledge_uploads      上传意图/任务关联（超时恢复按意图，不按显示名猜归属）
--
-- 前置依赖（均已存在）：identities(type,organization_id)、projects(organization_id, owner_identity_id)、
-- conversations(project_id)、knowledge_documents、document_access_policy。
-- 注意：不修改已应用的 0021；历史文档 knowledge_base_id 保持 NULL 并隔离，不自动判归属。

-- ============================================================
-- 1) knowledge_bases：权威知识库目录
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  collection text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('company', 'project', 'personal')),
  organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
  owner_identity_id uuid REFERENCES identities(id) ON DELETE RESTRICT,
  created_by_identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 归属互斥：企业库只带企业 ID；项目库必须带项目 ID 且个人所有者为空；
  -- 个人库只带个人所有者 ID。项目库的企业 ID 可空（容纳个人项目）。
  CONSTRAINT knowledge_bases_scope_shape CHECK (
    (scope = 'company'
      AND organization_id IS NOT NULL AND project_id IS NULL AND owner_identity_id IS NULL)
    OR
    (scope = 'project'
      AND project_id IS NOT NULL AND owner_identity_id IS NULL)
    OR
    (scope = 'personal'
      AND organization_id IS NULL AND project_id IS NULL AND owner_identity_id IS NOT NULL)
  )
);
COMMENT ON TABLE knowledge_bases IS '权威知识库目录；归属与范围创建后不可直接修改，改动走经审计的迁移流程';
COMMENT ON COLUMN knowledge_bases.collection IS '远端集合映射；不是权限边界，同一集合可被多个库共享，权限过滤必须叠加 knowledge_base_id';

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_bases_scope_collection_org_uq
  ON knowledge_bases (scope, collection, organization_id)
  WHERE scope = 'company';
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_bases_scope_collection_project_uq
  ON knowledge_bases (scope, collection, project_id)
  WHERE scope = 'project';
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_bases_scope_collection_owner_uq
  ON knowledge_bases (scope, collection, owner_identity_id)
  WHERE scope = 'personal';
CREATE INDEX IF NOT EXISTS knowledge_bases_organization_idx ON knowledge_bases (organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS knowledge_bases_project_idx ON knowledge_bases (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS knowledge_bases_owner_idx ON knowledge_bases (owner_identity_id) WHERE owner_identity_id IS NOT NULL;

-- ============================================================
-- 2) knowledge_documents：关联知识库 + 访问模式
-- ============================================================
ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS knowledge_base_id uuid REFERENCES knowledge_bases(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'inherited'
    CHECK (access_mode IN ('inherited', 'allowlist'));

-- 迁移初期允许 NULL：表示尚未确认归属的历史文档；未归属文档不得进入列表/全文/检索
-- （历史数据分类完成后再评估收紧为 NOT NULL，不按集合名自动猜归属）
COMMENT ON COLUMN knowledge_documents.knowledge_base_id IS '所属知识库；NULL=未归属的历史文档，不参与列表与检索';
COMMENT ON COLUMN knowledge_documents.access_mode IS 'inherited=按知识库归属与实时成员关系判权；allowlist=还须存在显式授权行';

CREATE INDEX IF NOT EXISTS knowledge_documents_kb_doc_idx
  ON knowledge_documents (knowledge_base_id, doc_id) WHERE knowledge_base_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS knowledge_documents_kb_idx
  ON knowledge_documents (knowledge_base_id) WHERE knowledge_base_id IS NOT NULL;

-- ============================================================
-- 3) document_access_policy：单文档收紧授权（非成员物化名单）
-- ============================================================
ALTER TABLE document_access_policy
  ADD COLUMN IF NOT EXISTS knowledge_base_id uuid REFERENCES knowledge_bases(id) ON DELETE RESTRICT;

-- knowledge_base_id 是知识库归属的冗余快照，必须与 knowledge_documents.knowledge_base_id 一致；
-- 由写入侧（应用事务）保证，另建部分索引便于按库审计。
CREATE INDEX IF NOT EXISTS document_access_policy_kb_idx
  ON document_access_policy (knowledge_base_id) WHERE knowledge_base_id IS NOT NULL;
COMMENT ON COLUMN document_access_policy.knowledge_base_id IS '冗余快照：须与文档所属知识库一致；不得通过修改授权行改变文档归属';

-- ============================================================
-- 4) knowledge_uploads：上传意图/任务关联（幂等恢复的锚点）
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_upload_id text NOT NULL UNIQUE,
  knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE RESTRICT,
  uploader_identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  collection text NOT NULL,
  remote_job_id text,
  stored_filename text NOT NULL DEFAULT '',
  remote_storage_path text NOT NULL DEFAULT '',
  doc_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'processing', 'completed', 'failed', 'cancelled')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE knowledge_uploads IS '上传意图与远端任务关联；任务完成后按 job/存储路径解析远端 doc_id 并绑定文档与库';
COMMENT ON COLUMN knowledge_uploads.doc_id IS '任务完成后回填；未回填前该文件不进入检索';

CREATE INDEX IF NOT EXISTS knowledge_uploads_job_idx ON knowledge_uploads (remote_job_id) WHERE remote_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS knowledge_uploads_kb_status_idx ON knowledge_uploads (knowledge_base_id, status);
CREATE INDEX IF NOT EXISTS knowledge_uploads_uploader_idx ON knowledge_uploads (uploader_identity_id, created_at DESC);

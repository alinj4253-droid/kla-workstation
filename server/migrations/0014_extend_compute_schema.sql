-- 0011: 扩展 A 侧算力表，支撑 B 侧 Key 管理（§7.2）与用量查询（§7.4）
-- A 侧 0010_compute_sub2api.sql 已创建 compute_keys / compute_usage 主体；
-- 此处只做增量 ALTER，不重建表，避免与 A 侧列定义漂移。
-- 额度单位统一 USD，NUMERIC(20,8) 与 Sub2API 一致。

-- Key：模型分组、Key 级 USD 配额、速率、IP 白名单、有效期、同步时间（§7.2）
ALTER TABLE compute_keys ADD COLUMN IF NOT EXISTS group_id text;
ALTER TABLE compute_keys ADD COLUMN IF NOT EXISTS quota numeric(20,8);
ALTER TABLE compute_keys ADD COLUMN IF NOT EXISTS rpm integer;
ALTER TABLE compute_keys ADD COLUMN IF NOT EXISTS ip_allow_list jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE compute_keys ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE compute_keys ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;
ALTER TABLE compute_keys ADD COLUMN IF NOT EXISTS created_by_identity_id uuid REFERENCES identities(id) ON DELETE SET NULL;
-- 每个身份至多一把默认 Key：默认 Key 不可删除，只能停用后重新生成（§7.2、§9.2）
CREATE UNIQUE INDEX IF NOT EXISTS compute_keys_one_default_per_identity ON compute_keys(identity_id) WHERE is_default;

-- 用量：业务标签与查询字段（§7.4 筛选、§8 业务标签注入）
-- 说明：Token/费用/时间沿用 A 侧 prompt_tokens / completion_tokens / amount_usd / recorded_at，不重复建列。
ALTER TABLE compute_usage ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE compute_usage ADD COLUMN IF NOT EXISTS key_id uuid REFERENCES compute_keys(id) ON DELETE SET NULL;
ALTER TABLE compute_usage ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE compute_usage ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE compute_usage ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE compute_usage ADD COLUMN IF NOT EXISTS latency_ms integer;
ALTER TABLE compute_usage ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'success';
CREATE INDEX IF NOT EXISTS idx_usage_organization_time ON compute_usage(organization_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_key ON compute_usage(key_id);
CREATE INDEX IF NOT EXISTS idx_usage_model_time ON compute_usage(model, recorded_at DESC);

-- §10 权限码种子（幂等）；角色与 role_permissions 绑定由 C 组负责
INSERT INTO permissions (code, description) VALUES
  ('compute.view', '查看本人算力余额与摘要'),
  ('compute.key.view', '查看本人 API Key 列表'),
  ('compute.key.create', '创建本人 API Key'),
  ('compute.key.update', '修改本人 API Key'),
  ('compute.key.disable', '停用本人 API Key'),
  ('compute.usage.view', '查看本人用量'),
  ('compute.organization.usage.view', '查看企业成员汇总用量'),
  ('compute.allocate', '分配企业额度给成员'),
  ('compute.reclaim', '回收成员未使用额度'),
  ('compute.recharge', '个人充值'),
  ('model.use', '通过 Model Gateway 调用模型'),
  ('model.catalog.view', '查看模型广场')
ON CONFLICT (code) DO NOTHING;
-- 禁止同一用户重复加入同一企业（(user_id, organization_id) 在 active 企业身份上唯一）。
-- 先清理存量重复：保留每个 (user_id, organization_id) 最早的 active 企业身份，其余置为 disabled。

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY user_id, organization_id ORDER BY created_at ASC) AS rn
  FROM identities
  WHERE type = 'enterprise' AND status = 'active'
)
UPDATE identities
SET status = 'disabled'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 部分唯一索引：仅对 active 的企业身份生效（个人身份 organization_id 为 NULL，不受影响）。
CREATE UNIQUE INDEX IF NOT EXISTS identities_user_org_unique_active
  ON identities (user_id, organization_id)
  WHERE type = 'enterprise' AND status = 'active';

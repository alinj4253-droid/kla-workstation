-- 0020: 算力点口径与工具类计费项（P1-11 步骤 3）
-- 依据：docs/DESIGN_POINTS_BASED_BILLING.md §4、docs/DESIGN_BOCHA_SEARCH_INTEGRATION.md §5.1
-- 全部为增量加列/建表，不改动既有列语义；历史行的 amount 继续表示 USD，迁移期与 points 双写。

-- 1. 额度池：算力点主口径字段（numeric(20,3) = 毫积分；USD 四件套保留为影子，迁移期双写）
ALTER TABLE compute_entitlements ADD COLUMN IF NOT EXISTS points_total    numeric(20,3) NOT NULL DEFAULT 0;
ALTER TABLE compute_entitlements ADD COLUMN IF NOT EXISTS points_granted  numeric(20,3) NOT NULL DEFAULT 0;
ALTER TABLE compute_entitlements ADD COLUMN IF NOT EXISTS points_used     numeric(20,3) NOT NULL DEFAULT 0;
ALTER TABLE compute_entitlements ADD COLUMN IF NOT EXISTS points_reserved numeric(20,3) NOT NULL DEFAULT 0;

-- 2. 额度流水：amount 继续为 USD（历史语义不变）；积分金额与逐笔汇率快照显式落列（历史可解释）
ALTER TABLE compute_allocation_ledger ADD COLUMN IF NOT EXISTS amount_points numeric(20,3) NOT NULL DEFAULT 0;
ALTER TABLE compute_allocation_ledger ADD COLUMN IF NOT EXISTS rate_snapshot numeric(20,8) NOT NULL DEFAULT 1000;

-- 3. 用量：算力点口径冗余（byModel/byDay 聚合直接 SUM）+ 计费通道（kind 默认 model 兼容历史行）
ALTER TABLE compute_usage ADD COLUMN IF NOT EXISTS amount_points numeric(20,3) NOT NULL DEFAULT 0;
ALTER TABLE compute_usage ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'model'; -- model | tool
ALTER TABLE compute_usage ADD COLUMN IF NOT EXISTS tool_id text;
-- 工具用量按月对账查询（次数 × 单价 ≈ 上游月账单）
CREATE INDEX IF NOT EXISTS idx_usage_tool_time ON compute_usage(tool_id, recorded_at DESC) WHERE kind = 'tool';

-- 4. 工具类计费项定价（按次计费，直接定"点"，不经 USD/CNY 换算；cost_per_call_cny 为财务影子）
CREATE TABLE IF NOT EXISTS compute_tool_pricing (
  tool_id           text PRIMARY KEY,
  points_per_call   numeric(20,3) NOT NULL,
  cost_per_call_cny numeric(20,8),
  pricing_version   integer NOT NULL DEFAULT 1,
  enabled           boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- 占位定价：博查 Web Search（约 ¥0.036/次 ≈ 5 点/次），最终以运营核价为准
INSERT INTO compute_tool_pricing (tool_id, points_per_call, cost_per_call_cny)
VALUES ('bocha-web-search', 5, 0.036)
ON CONFLICT (tool_id) DO NOTHING;

-- 5. 权限码种子与既有角色回填（沿用 0014 风格；绑定规则：已能调用模型的即授予按次工具）
INSERT INTO permissions (code, description) VALUES
  ('tool.search.use', '使用联网搜索等按次计费工具')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE p.code = 'tool.search.use'
  AND EXISTS (
    SELECT 1 FROM role_permissions rp
    JOIN permissions m ON m.id = rp.permission_id
    WHERE rp.role_id = r.id AND m.code = 'model.use'
  )
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions existing
    WHERE existing.role_id = r.id AND existing.permission_id = p.id
  );

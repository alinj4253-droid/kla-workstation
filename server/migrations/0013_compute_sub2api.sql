-- KLA Workstation 算力板块与 Sub2API 集成：账号绑定、额度台账、密钥、用量、建号作业、同步日志、Outbox
-- 依赖：0004_identity_organizations.sql（identities, organizations, users）
-- 额度单位统一为 USD（NUMERIC(20,8)），与 Sub2API 计价一致。

-- 1. 身份 → Sub2API 账号绑定
CREATE TABLE IF NOT EXISTS compute_bindings (
  identity_id       uuid PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  sub2api_user_id   text NOT NULL UNIQUE,
  sub2api_username  text NOT NULL,
  managed_password  text,                       -- 字段级加密（AES-256-GCM，base64）；用户不可见
  sub2api_status    text NOT NULL DEFAULT 'pending', -- pending | provisioning | user_created | balance_granted | default_key_created | ready | disabled | failed | dead_letter
  provision_job_id  uuid,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 2. 额度池（个人池 = identity 独占；企业池 = organization 共享）
-- owner_type XOR 约束：个人池 identity_id 非空且 organization_id 为空；企业池反之。
CREATE TABLE IF NOT EXISTS compute_entitlements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id       uuid REFERENCES identities(id) ON DELETE CASCADE,
  organization_id   uuid REFERENCES organizations(id) ON DELETE CASCADE,
  quota_total       NUMERIC(20,8) NOT NULL DEFAULT 0,  -- 充值/平台发放累计
  quota_granted     NUMERIC(20,8) NOT NULL DEFAULT 0,  -- 从企业池分配到个人池（仅个人池有意义）
  quota_used        NUMERIC(20,8) NOT NULL DEFAULT 0,  -- 已扣减（已 commit）
  quota_reserved    NUMERIC(20,8) NOT NULL DEFAULT 0,  -- 预扣中（reserve 未 commit/release）
  version           integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlements_owner_xor CHECK (
    (identity_id IS NOT NULL AND organization_id IS NULL) OR
    (identity_id IS NULL AND organization_id IS NOT NULL)
  )
);

-- 个人池：每个 identity 唯一；企业池：每个 organization 唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlements_identity ON compute_entitlements(identity_id) WHERE identity_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlements_org ON compute_entitlements(organization_id) WHERE organization_id IS NOT NULL;

-- 3. 额度流水（发放 / 分配 / 回收 / 预扣 / 扣减 / 释放 / 充值）
CREATE TABLE IF NOT EXISTS compute_allocation_ledger (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id    uuid NOT NULL REFERENCES compute_entitlements(id) ON DELETE CASCADE,
  operation         text NOT NULL, -- grant | allocate | reclaim | reserve | commit | release | recharge
  amount            NUMERIC(20,8) NOT NULL,
  status            text NOT NULL DEFAULT 'pending', -- pending | completed | failed | released
  idempotency_key   text NOT NULL UNIQUE,             -- 幂等：grant:{owner}:{requestId} 等
  request_id        text,
  related_ledger_id uuid REFERENCES compute_allocation_ledger(id) ON DELETE SET NULL,
  sub2api_synced    boolean NOT NULL DEFAULT false,   -- 是否已同步到 Sub2API（commit/recharge）
  operator_identity_id uuid,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_entitlement ON compute_allocation_ledger(entitlement_id, created_at DESC);

-- 4. API Key 引用（明文由 Sub2API 持有，KLA 仅保存引用/前缀/指纹）
CREATE TABLE IF NOT EXISTS compute_keys (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id       uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  sub2api_key_id    text NOT NULL UNIQUE,
  key_prefix        text NOT NULL,
  key_fingerprint   text NOT NULL,
  name              text NOT NULL,
  is_default        boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'active', -- active | disabled | deleted
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_keys_identity ON compute_keys(identity_id);

-- 5. 用量记录（从 Sub2API 回流 + KLA Gateway 写入）
CREATE TABLE IF NOT EXISTS compute_usage (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id       uuid REFERENCES identities(id) ON DELETE SET NULL,
  ledger_id         uuid REFERENCES compute_allocation_ledger(id) ON DELETE SET NULL,
  sub2api_usage_id  text,
  model             text,
  amount_usd        NUMERIC(20,8) NOT NULL DEFAULT 0,
  prompt_tokens     bigint,
  completion_tokens bigint,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_hash       text NOT NULL UNIQUE,            -- sha256(id:userId:timestamp) 防重复回流
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_identity ON compute_usage(identity_id, recorded_at DESC);

-- 6. 建号作业记录
CREATE TABLE IF NOT EXISTS compute_provision_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id       uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'pending', -- pending | provisioning | user_created | balance_granted | default_key_created | ready | failed | dead_letter
  attempts          integer NOT NULL DEFAULT 0,
  max_attempts      integer NOT NULL DEFAULT 5,
  last_error        text,
  sub2api_user_id   text,
  sub2api_key_id    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provision_identity ON compute_provision_jobs(identity_id);
CREATE INDEX IF NOT EXISTS idx_provision_status ON compute_provision_jobs(status);

-- 7. 同步/对账日志
CREATE TABLE IF NOT EXISTS compute_sync_logs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_type         text NOT NULL, -- usage | reconciliation | balance
  identity_id       uuid REFERENCES identities(id) ON DELETE SET NULL,
  organization_id   uuid REFERENCES organizations(id) ON DELETE SET NULL,
  kla_amount        NUMERIC(20,8),
  sub2api_amount    NUMERIC(20,8),
  drift_usd         NUMERIC(20,8),
  status            text NOT NULL DEFAULT 'ok', -- ok | warning | error
  message           text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sync_logs_type ON compute_sync_logs(sync_type, created_at DESC);

-- 8. Outbox 事件（建号、停用、额度同步等异步任务）
CREATE TABLE IF NOT EXISTS outbox_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type    text NOT NULL,  -- identity | entitlement
  aggregate_id      text NOT NULL,  -- identityId / entitlementId (text，避免 FK 跨表)
  event_type        text NOT NULL,  -- provision_identity_compute | disable_identity_compute | sync_balance_to_sub2api
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key   text NOT NULL,  -- provision:{identityId} / disable:{identityId} / balance:{ledgerId}
  status            text NOT NULL DEFAULT 'pending', -- pending | processing | completed | failed | dead_letter
  attempts          integer NOT NULL DEFAULT 0,
  max_attempts      integer NOT NULL DEFAULT 5,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_idempotency ON outbox_events(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_events(status, next_attempt_at);

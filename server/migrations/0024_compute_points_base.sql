-- User-facing compute balance is denominated in points. USD remains an upstream cost shadow.
ALTER TABLE compute_entitlements ADD COLUMN IF NOT EXISTS points_total numeric(20,3) NOT NULL DEFAULT 0;
ALTER TABLE compute_entitlements ADD COLUMN IF NOT EXISTS points_granted numeric(20,3) NOT NULL DEFAULT 0;
ALTER TABLE compute_entitlements ADD COLUMN IF NOT EXISTS points_used numeric(20,3) NOT NULL DEFAULT 0;
ALTER TABLE compute_entitlements ADD COLUMN IF NOT EXISTS points_reserved numeric(20,3) NOT NULL DEFAULT 0;
ALTER TABLE compute_allocation_ledger ADD COLUMN IF NOT EXISTS amount_points numeric(20,3) NOT NULL DEFAULT 0;
ALTER TABLE compute_allocation_ledger ADD COLUMN IF NOT EXISTS rate_snapshot numeric(20,8) NOT NULL DEFAULT 1000;
ALTER TABLE compute_usage ADD COLUMN IF NOT EXISTS amount_points numeric(20,3) NOT NULL DEFAULT 0;

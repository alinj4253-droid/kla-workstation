-- Idempotent in-place conversion. The original USD columns are retained for reconciliation.
-- A nonzero points row is never overwritten, so retries cannot grant balance twice.
UPDATE compute_entitlements
SET points_total = round(quota_total * 1000, 3),
    points_granted = round(quota_granted * 1000, 3),
    points_used = round(quota_used * 1000, 3),
    points_reserved = round(quota_reserved * 1000, 3)
WHERE points_total = 0 AND points_granted = 0 AND points_used = 0 AND points_reserved = 0
  AND (quota_total <> 0 OR quota_granted <> 0 OR quota_used <> 0 OR quota_reserved <> 0);

UPDATE compute_allocation_ledger
SET amount_points = round(amount * rate_snapshot, 3)
WHERE amount_points = 0 AND amount <> 0;

UPDATE compute_usage
SET amount_points = round(amount_usd * 1000, 3)
WHERE amount_points = 0 AND amount_usd <> 0;

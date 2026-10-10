-- A legacy worker could have written USD after the initial backfill but before
-- the compatibility trigger was installed. Align the shadow once at deployment.
UPDATE compute_entitlements
SET points_total = round(quota_total * 1000, 3),
    points_granted = round(quota_granted * 1000, 3),
    points_used = round(quota_used * 1000, 3),
    points_reserved = round(quota_reserved * 1000, 3)
WHERE points_total IS DISTINCT FROM round(quota_total * 1000, 3)
   OR points_granted IS DISTINCT FROM round(quota_granted * 1000, 3)
   OR points_used IS DISTINCT FROM round(quota_used * 1000, 3)
   OR points_reserved IS DISTINCT FROM round(quota_reserved * 1000, 3);

UPDATE compute_allocation_ledger
SET amount_points = round(amount * rate_snapshot, 3)
WHERE amount_points = 0 AND amount <> 0;

UPDATE compute_usage
SET amount_points = round(amount_usd * 1000, 3)
WHERE amount_points = 0 AND amount_usd <> 0;

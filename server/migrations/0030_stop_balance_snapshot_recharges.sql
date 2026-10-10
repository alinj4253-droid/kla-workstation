-- A Sub2API user's balance is not an identity recharge event. In particular,
-- multiple KLA identities may share one upstream user during migration.
-- Reject the legacy read-side reconciliation writer after billing cutover;
-- its entitlement update and this insert share a transaction and roll back.
CREATE OR REPLACE FUNCTION compute_reject_balance_snapshot_recharge() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM compute_billing_cutover)
    AND NEW.operation = 'recharge'
    AND NEW.metadata->>'source' = 'sub2api_reconciliation' THEN
    RAISE EXCEPTION 'Sub2API balance snapshot cannot create KLA credits';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS compute_reject_balance_snapshot_recharge_trigger ON compute_allocation_ledger;
CREATE TRIGGER compute_reject_balance_snapshot_recharge_trigger
BEFORE INSERT ON compute_allocation_ledger
FOR EACH ROW EXECUTE FUNCTION compute_reject_balance_snapshot_recharge();

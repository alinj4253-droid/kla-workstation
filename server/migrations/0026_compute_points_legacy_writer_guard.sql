-- Keep old USD-only workers consistent during a rolling deployment.
-- New workers update both columns; old workers update only quota_* / amount_usd.
CREATE OR REPLACE FUNCTION compute_entitlement_points_compat() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.points_total = 0 AND NEW.quota_total <> 0 THEN NEW.points_total := round(NEW.quota_total * 1000, 3); END IF;
    IF NEW.points_granted = 0 AND NEW.quota_granted <> 0 THEN NEW.points_granted := round(NEW.quota_granted * 1000, 3); END IF;
    IF NEW.points_used = 0 AND NEW.quota_used <> 0 THEN NEW.points_used := round(NEW.quota_used * 1000, 3); END IF;
    IF NEW.points_reserved = 0 AND NEW.quota_reserved <> 0 THEN NEW.points_reserved := round(NEW.quota_reserved * 1000, 3); END IF;
  ELSE
    IF NEW.points_total IS NOT DISTINCT FROM OLD.points_total AND NEW.quota_total IS DISTINCT FROM OLD.quota_total THEN NEW.points_total := round(NEW.quota_total * 1000, 3); END IF;
    IF NEW.points_granted IS NOT DISTINCT FROM OLD.points_granted AND NEW.quota_granted IS DISTINCT FROM OLD.quota_granted THEN NEW.points_granted := round(NEW.quota_granted * 1000, 3); END IF;
    IF NEW.points_used IS NOT DISTINCT FROM OLD.points_used AND NEW.quota_used IS DISTINCT FROM OLD.quota_used THEN NEW.points_used := round(NEW.quota_used * 1000, 3); END IF;
    IF NEW.points_reserved IS NOT DISTINCT FROM OLD.points_reserved AND NEW.quota_reserved IS DISTINCT FROM OLD.quota_reserved THEN NEW.points_reserved := round(NEW.quota_reserved * 1000, 3); END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS compute_entitlement_points_compat_trigger ON compute_entitlements;
CREATE TRIGGER compute_entitlement_points_compat_trigger BEFORE INSERT OR UPDATE ON compute_entitlements
FOR EACH ROW EXECUTE FUNCTION compute_entitlement_points_compat();

CREATE OR REPLACE FUNCTION compute_ledger_points_compat() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_points = 0 AND NEW.amount <> 0 THEN NEW.amount_points := round(NEW.amount * NEW.rate_snapshot, 3); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS compute_ledger_points_compat_trigger ON compute_allocation_ledger;
CREATE TRIGGER compute_ledger_points_compat_trigger BEFORE INSERT ON compute_allocation_ledger
FOR EACH ROW EXECUTE FUNCTION compute_ledger_points_compat();

CREATE OR REPLACE FUNCTION compute_usage_points_compat() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_points = 0 AND NEW.amount_usd <> 0 THEN NEW.amount_points := round(NEW.amount_usd * 1000, 3); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS compute_usage_points_compat_trigger ON compute_usage;
CREATE TRIGGER compute_usage_points_compat_trigger BEFORE INSERT ON compute_usage
FOR EACH ROW EXECUTE FUNCTION compute_usage_points_compat();

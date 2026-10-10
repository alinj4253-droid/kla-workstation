-- Once the actual-cost worker starts, old gateways may still write a fixed
-- estimated charge. Keep their hold/release behavior, but discard that charge.
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
    IF EXISTS (SELECT 1 FROM compute_billing_cutover)
      AND current_setting('kla.upstream_usage', true) IS DISTINCT FROM 'on' THEN
      NEW.quota_used := OLD.quota_used;
      NEW.points_used := OLD.points_used;
    ELSIF NEW.points_used IS NOT DISTINCT FROM OLD.points_used AND NEW.quota_used IS DISTINCT FROM OLD.quota_used THEN
      NEW.points_used := round(NEW.quota_used * 1000, 3);
    END IF;
    IF NEW.points_reserved IS NOT DISTINCT FROM OLD.points_reserved AND NEW.quota_reserved IS DISTINCT FROM OLD.quota_reserved THEN NEW.points_reserved := round(NEW.quota_reserved * 1000, 3); END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION compute_usage_points_compat() RETURNS trigger AS $$
BEGIN
  IF NEW.ledger_id IS NOT NULL AND EXISTS (SELECT 1 FROM compute_billing_cutover)
    AND EXISTS (SELECT 1 FROM compute_allocation_ledger WHERE id = NEW.ledger_id AND operation = 'reserve') THEN
    NEW.amount_usd := 0;
    NEW.amount_points := 0;
    NEW.status := 'pending_cost';
  ELSIF NEW.amount_points = 0 AND NEW.amount_usd <> 0 THEN
    NEW.amount_points := round(NEW.amount_usd * 1000, 3);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

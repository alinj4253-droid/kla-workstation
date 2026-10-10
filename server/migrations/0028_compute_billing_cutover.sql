-- The first new billing worker records its start time. Historical placeholder
-- charges are not replayed, and restarts retain the same cursor.
CREATE TABLE IF NOT EXISTS compute_billing_cutover (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  started_at timestamptz NOT NULL DEFAULT now()
);

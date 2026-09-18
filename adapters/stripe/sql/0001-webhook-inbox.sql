-- UNAPPLIED. WP-055 webhook inbox (tenant-scoped). Do not migrate from this package.
-- Sequence + event_id uniqueness encode duplicate and gap-check.
CREATE TABLE IF NOT EXISTS stripe.webhook_inbox (
  tenant_id text NOT NULL,
  event_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  event_type text NOT NULL,
  payload_ref text NOT NULL,
  effect_key text NOT NULL,
  received_at timestamptz NOT NULL,
  applied boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, sequence)
);

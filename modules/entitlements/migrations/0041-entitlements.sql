-- WP-053 entitlements consume journal. Re-runnable. Unapplied until stack-grant.
CREATE SCHEMA IF NOT EXISTS entitlements;

CREATE TABLE IF NOT EXISTS entitlements.consumption (
  tenant_id text NOT NULL,
  consumption_id text NOT NULL,
  member_ref text NOT NULL,
  vintage_id text NOT NULL,
  sku_ref text NOT NULL,
  idempotency_key text NOT NULL,
  payer text NOT NULL CHECK (payer IN ('member','employer')),
  allowed_discount_cents integer NOT NULL CHECK (allowed_discount_cents >= 0),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, consumption_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, member_ref, vintage_id, sku_ref)
);

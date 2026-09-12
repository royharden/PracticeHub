-- WP-031 versioned catalog, paid orders and append-only thin fulfillment events.
CREATE SCHEMA IF NOT EXISTS catalog_cash;
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_catalog_cash') THEN
    CREATE ROLE module_catalog_cash NOLOGIN;
  END IF;
END $roles$;
GRANT module_catalog_cash TO practicehub_app;
GRANT USAGE ON SCHEMA catalog_cash TO module_catalog_cash;

CREATE TABLE IF NOT EXISTS catalog_cash.catalog_offer (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  offer_version_ref text NOT NULL,
  catalog_version_ref text NOT NULL,
  opaque_processor_sku_ref text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  expires_at timestamptz NOT NULL,
  component_lines jsonb NOT NULL CHECK (jsonb_typeof(component_lines) = 'array' AND jsonb_array_length(component_lines) > 0),
  cancellation_policy_ref text NOT NULL,
  refund_policy_ref text NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, offer_version_ref)
);

CREATE TABLE IF NOT EXISTS catalog_cash.paid_service_order (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  order_id text NOT NULL,
  buyer_ref text NOT NULL,
  member_ref text NOT NULL,
  offer_version_ref text NOT NULL,
  idempotency_key text NOT NULL,
  canonical_payload_hash text NOT NULL CHECK (canonical_payload_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('reconciled','failed_not_landed','reconciliation_held','identity_held','refunded')),
  payment_journal_ref text,
  work_item_ref text,
  occurred_at timestamptz NOT NULL,
  refund_idempotency_key text,
  refund_request_hash text CHECK (refund_request_hash IS NULL OR refund_request_hash ~ '^[0-9a-f]{64}$'),
  order_snapshot jsonb NOT NULL CHECK (jsonb_typeof(order_snapshot) = 'object'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, order_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, offer_version_ref) REFERENCES catalog_cash.catalog_offer (tenant_id, offer_version_ref),
  CHECK ((refund_idempotency_key IS NULL) = (refund_request_hash IS NULL)),
  CHECK (state <> 'reconciled' OR payment_journal_ref IS NOT NULL),
  CHECK (state NOT IN ('reconciliation_held','identity_held') OR work_item_ref IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS catalog_cash.paid_service_attempt (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  operation text NOT NULL CHECK (operation IN ('purchase','refund')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  authority_hash text NOT NULL CHECK (authority_hash ~ '^[0-9a-f]{64}$'),
  order_ref text NOT NULL,
  rail_effect_ref text,
  rail_outcome text CHECK (rail_outcome IN ('landed','not_landed','unknown')),
  external_receipt_ref text,
  effect_observed_at timestamptz,
  work_item_ref text,
  rail_submitted boolean NOT NULL DEFAULT false,
  state text NOT NULL CHECK (state IN ('reserved','submitted','effect_observed','reconciliation_held','completed')),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, operation, idempotency_key),
  CHECK ((rail_effect_ref IS NULL AND rail_outcome IS NULL AND effect_observed_at IS NULL)
      OR (rail_effect_ref IS NOT NULL AND rail_outcome IS NOT NULL AND effect_observed_at IS NOT NULL)),
  CHECK (rail_effect_ref IS NULL OR rail_submitted),
  CHECK (state <> 'reconciliation_held' OR work_item_ref IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_refund_attempt_per_order
  ON catalog_cash.paid_service_attempt (tenant_id, order_ref)
  WHERE operation = 'refund';

CREATE TABLE IF NOT EXISTS catalog_cash.fulfillment_event (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  fulfillment_event_id text NOT NULL,
  obligation_id text NOT NULL,
  order_ref text NOT NULL,
  offer_version_ref text NOT NULL,
  component_ref text NOT NULL,
  owner_role text NOT NULL,
  state text NOT NULL CHECK (state IN ('paid','reconciliation_held','identity_held','unmapped','refunded')),
  due_at timestamptz,
  refundable_state text,
  occurred_at timestamptz NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, fulfillment_event_id),
  FOREIGN KEY (tenant_id, order_ref) REFERENCES catalog_cash.paid_service_order (tenant_id, order_id)
);

GRANT SELECT, INSERT ON catalog_cash.catalog_offer, catalog_cash.fulfillment_event TO module_catalog_cash;
GRANT SELECT, INSERT, UPDATE ON catalog_cash.paid_service_order TO module_catalog_cash;
GRANT SELECT, INSERT, UPDATE ON catalog_cash.paid_service_attempt TO module_catalog_cash;
REVOKE UPDATE, DELETE ON catalog_cash.catalog_offer, catalog_cash.fulfillment_event FROM module_catalog_cash;
REVOKE DELETE ON catalog_cash.paid_service_order FROM module_catalog_cash;
REVOKE DELETE ON catalog_cash.paid_service_attempt FROM module_catalog_cash;
-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE catalog_cash.catalog_offer ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_cash.catalog_offer FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON catalog_cash.catalog_offer;
CREATE POLICY tenant_isolation ON catalog_cash.catalog_offer
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE catalog_cash.fulfillment_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_cash.fulfillment_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON catalog_cash.fulfillment_event;
CREATE POLICY tenant_isolation ON catalog_cash.fulfillment_event
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE catalog_cash.paid_service_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_cash.paid_service_attempt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON catalog_cash.paid_service_attempt;
CREATE POLICY tenant_isolation ON catalog_cash.paid_service_attempt
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE catalog_cash.paid_service_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_cash.paid_service_order FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON catalog_cash.paid_service_order;
CREATE POLICY tenant_isolation ON catalog_cash.paid_service_order
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

DO $coverage$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO offender
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'catalog_cash'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('catalog_offer', 'fulfillment_event', 'paid_service_attempt', 'paid_service_order'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema catalog_cash: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end

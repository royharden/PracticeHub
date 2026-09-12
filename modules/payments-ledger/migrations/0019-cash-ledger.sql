-- WP-031 payments ledger. App-owned authority; processor references are opaque.
CREATE SCHEMA IF NOT EXISTS payments_ledger;
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_payments_ledger') THEN
    CREATE ROLE module_payments_ledger NOLOGIN;
  END IF;
END $roles$;
GRANT module_payments_ledger TO practicehub_app;
GRANT USAGE ON SCHEMA payments_ledger TO module_payments_ledger;

CREATE TABLE IF NOT EXISTS payments_ledger.payment_intent (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  payment_intent_id text NOT NULL,
  idempotency_key text NOT NULL,
  canonical_payload_hash text NOT NULL CHECK (canonical_payload_hash ~ '^[0-9a-f]{64}$'),
  processor_account_ref text NOT NULL,
  opaque_sku_ref text,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state text NOT NULL CHECK (state IN ('prepared','submitted','landed_unreconciled','reconciled','failed_not_landed','unknown')),
  processor_effect_ref text,
  external_receipt_ref text,
  occurred_at timestamptz NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, payment_intent_id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (state <> 'reconciled' OR (processor_effect_ref IS NOT NULL AND external_receipt_ref IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS payments_ledger.journal (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  journal_id text NOT NULL,
  correlation_id text NOT NULL,
  idempotency_key text NOT NULL,
  canonical_payload_hash text NOT NULL CHECK (canonical_payload_hash ~ '^[0-9a-f]{64}$'),
  processor_effect_ref text,
  external_receipt_ref text,
  reversal_of_journal_id text,
  posting_xid bigint NOT NULL DEFAULT txid_current(),
  occurred_at timestamptz NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, journal_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, reversal_of_journal_id) REFERENCES payments_ledger.journal (tenant_id, journal_id)
);

CREATE TABLE IF NOT EXISTS payments_ledger.journal_line (
  tenant_id text NOT NULL,
  journal_id text NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  account_ref text NOT NULL,
  side text NOT NULL CHECK (side IN ('debit','credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source_ref text NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, journal_id, line_no),
  FOREIGN KEY (tenant_id, journal_id) REFERENCES payments_ledger.journal (tenant_id, journal_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS journal_one_reversal
  ON payments_ledger.journal (tenant_id, reversal_of_journal_id)
  WHERE reversal_of_journal_id IS NOT NULL;

CREATE OR REPLACE FUNCTION payments_ledger.assert_balanced_journal()
RETURNS trigger
LANGUAGE plpgsql
AS $balance$
DECLARE
  target_tenant text := NEW.tenant_id;
  target_journal text := NEW.journal_id;
  original_journal text;
BEGIN
  IF (SELECT count(*) FROM payments_ledger.journal_line
       WHERE tenant_id = target_tenant AND journal_id = target_journal) < 2 THEN
    RAISE EXCEPTION 'journal % requires at least two lines', target_journal USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT currency FROM payments_ledger.journal_line
     WHERE tenant_id = target_tenant AND journal_id = target_journal
     GROUP BY currency
    HAVING sum(CASE WHEN side = 'debit' THEN amount_minor ELSE 0 END)
        <> sum(CASE WHEN side = 'credit' THEN amount_minor ELSE 0 END)
       OR sum(CASE WHEN side = 'debit' THEN amount_minor ELSE 0 END) > 9007199254740991
       OR sum(CASE WHEN side = 'credit' THEN amount_minor ELSE 0 END) > 9007199254740991
  ) THEN
    RAISE EXCEPTION 'journal % is not balanced', target_journal USING ERRCODE = '23514';
  END IF;
  SELECT reversal_of_journal_id INTO original_journal
    FROM payments_ledger.journal
   WHERE tenant_id = target_tenant AND journal_id = target_journal;
  IF original_journal IS NOT NULL AND (
    (SELECT reversal_of_journal_id IS NOT NULL FROM payments_ledger.journal
      WHERE tenant_id = target_tenant AND journal_id = original_journal)
    OR
    (SELECT count(*) FROM payments_ledger.journal_line
      WHERE tenant_id = target_tenant AND journal_id = original_journal)
      <>
    (SELECT count(*) FROM payments_ledger.journal_line
      WHERE tenant_id = target_tenant AND journal_id = target_journal)
    OR EXISTS (
      SELECT 1
        FROM payments_ledger.journal_line source
        LEFT JOIN payments_ledger.journal_line reversal
          ON reversal.tenant_id = source.tenant_id
         AND reversal.journal_id = target_journal
         AND reversal.line_no = source.line_no
       WHERE source.tenant_id = target_tenant
         AND source.journal_id = original_journal
         AND (reversal.line_no IS NULL
           OR reversal.account_ref <> source.account_ref
           OR reversal.currency <> source.currency
           OR reversal.amount_minor <> source.amount_minor
           OR reversal.source_ref <> source.source_ref
           OR reversal.side = source.side)
    )
  ) THEN
    RAISE EXCEPTION 'journal % is not an exact reversal of %', target_journal, original_journal USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$balance$;

CREATE OR REPLACE FUNCTION payments_ledger.assert_open_posting()
RETURNS trigger
LANGUAGE plpgsql
AS $posting$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payments_ledger.journal
     WHERE tenant_id = NEW.tenant_id AND journal_id = NEW.journal_id
  ) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM payments_ledger.journal
     WHERE tenant_id = NEW.tenant_id AND journal_id = NEW.journal_id
       AND posting_xid = txid_current()
  ) THEN
    RAISE EXCEPTION 'journal % posting is frozen outside its creation transaction', NEW.journal_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$posting$;

DROP TRIGGER IF EXISTS journal_client_posting ON payments_ledger.journal_line;
CREATE TRIGGER journal_client_posting
BEFORE INSERT ON payments_ledger.journal_line
FOR EACH ROW EXECUTE FUNCTION payments_ledger.assert_open_posting();

DROP TRIGGER IF EXISTS journal_balance_on_header ON payments_ledger.journal;
CREATE CONSTRAINT TRIGGER journal_balance_on_header
AFTER INSERT ON payments_ledger.journal
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION payments_ledger.assert_balanced_journal();
DROP TRIGGER IF EXISTS journal_balance_on_line ON payments_ledger.journal_line;
CREATE CONSTRAINT TRIGGER journal_balance_on_line
AFTER INSERT ON payments_ledger.journal_line
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION payments_ledger.assert_balanced_journal();

GRANT SELECT, INSERT ON payments_ledger.payment_intent, payments_ledger.journal, payments_ledger.journal_line TO module_payments_ledger;
REVOKE UPDATE, DELETE ON payments_ledger.payment_intent, payments_ledger.journal, payments_ledger.journal_line FROM module_payments_ledger;

-- Cross-module read API: entitlement authority is verified without a cross-schema FK/write.
CREATE OR REPLACE FUNCTION payments_ledger.is_entitlement_authority(
  target_tenant text,
  target_journal text,
  expected_original text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, payments_ledger
AS $authority$
  SELECT EXISTS (
    SELECT 1 FROM payments_ledger.journal
     WHERE tenant_id = target_tenant
       AND journal_id = target_journal
       AND ((expected_original IS NULL AND reversal_of_journal_id IS NULL)
         OR reversal_of_journal_id = expected_original)
  )
$authority$;
REVOKE ALL ON FUNCTION payments_ledger.is_entitlement_authority(text,text,text) FROM PUBLIC;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE payments_ledger.journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments_ledger.journal FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payments_ledger.journal;
CREATE POLICY tenant_isolation ON payments_ledger.journal
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE payments_ledger.journal_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments_ledger.journal_line FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payments_ledger.journal_line;
CREATE POLICY tenant_isolation ON payments_ledger.journal_line
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE payments_ledger.payment_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments_ledger.payment_intent FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payments_ledger.payment_intent;
CREATE POLICY tenant_isolation ON payments_ledger.payment_intent
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
   WHERE n.nspname = 'payments_ledger'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('journal', 'journal_line', 'payment_intent'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema payments_ledger: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end

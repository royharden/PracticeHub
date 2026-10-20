-- WP-056 rework 1 (review D46-WP-056-a1-review-1). Forward-only: 0019 and 0021 stay as landed.
-- Every statement is idempotent so the migration can be re-applied by the DB tests.

-- 1. A write-off is bound to one receivable, names a separate approver and requester,
--    and its approval is single-use. Rows written before 0068 are left unchecked (NOT VALID).
ALTER TABLE payments_ledger.write_off ADD COLUMN IF NOT EXISTS target_ref text;
ALTER TABLE payments_ledger.write_off ADD COLUMN IF NOT EXISTS approval_hash text;
ALTER TABLE payments_ledger.write_off ADD COLUMN IF NOT EXISTS approver_actor_id text;
ALTER TABLE payments_ledger.write_off ADD COLUMN IF NOT EXISTS requester_actor_id text;
ALTER TABLE payments_ledger.write_off DROP CONSTRAINT IF EXISTS write_off_governed;
ALTER TABLE payments_ledger.write_off ADD CONSTRAINT write_off_governed CHECK (
  target_ref IS NOT NULL AND target_ref <> ''
  AND approval_hash IS NOT NULL AND approval_hash ~ '^[0-9a-f]{64}$'
  AND approver_actor_id IS NOT NULL AND approver_actor_id <> ''
  AND requester_actor_id IS NOT NULL AND requester_actor_id <> ''
  AND approver_actor_id <> requester_actor_id
) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS write_off_one_use_per_approval
  ON payments_ledger.write_off (tenant_id, approval_hash)
  WHERE approval_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS write_off_one_per_journal
  ON payments_ledger.write_off (tenant_id, journal_id);

-- 2. The journal carries the approval it was posted under.
ALTER TABLE payments_ledger.journal ADD COLUMN IF NOT EXISTS write_off_approval_hash text;
ALTER TABLE payments_ledger.journal DROP CONSTRAINT IF EXISTS journal_write_off_approval_hash;
ALTER TABLE payments_ledger.journal ADD CONSTRAINT journal_write_off_approval_hash
  CHECK (write_off_approval_hash IS NULL OR write_off_approval_hash ~ '^[0-9a-f]{64}$');

-- A write_off row must point at a journal posted under the same approval, whose
-- accounts-receivable credit is the written-off receivable, amount and currency.
CREATE OR REPLACE FUNCTION payments_ledger.assert_write_off_journal()
RETURNS trigger
LANGUAGE plpgsql
AS $write_off$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payments_ledger.journal
     WHERE tenant_id = NEW.tenant_id
       AND journal_id = NEW.journal_id
       AND write_off_approval_hash = NEW.approval_hash
  ) OR NOT EXISTS (
    SELECT 1 FROM payments_ledger.journal_line
     WHERE tenant_id = NEW.tenant_id
       AND journal_id = NEW.journal_id
       AND account_ref = 'accounts-receivable'
       AND side = 'credit'
       AND amount_minor = NEW.amount_minor
       AND currency = NEW.currency
       AND source_ref = NEW.target_ref
  ) THEN
    RAISE EXCEPTION 'write-off % does not match journal %', NEW.write_off_id, NEW.journal_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$write_off$;

DROP TRIGGER IF EXISTS write_off_matches_journal ON payments_ledger.write_off;
CREATE CONSTRAINT TRIGGER write_off_matches_journal
AFTER INSERT ON payments_ledger.write_off
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION payments_ledger.assert_write_off_journal();

-- 3. A reversal keeps the original's rail and payout_ref (ledger-api-v2 decision 1).
--    Same body as 0019 plus the rail/payout_ref comparison.
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
    (SELECT original.rail IS DISTINCT FROM reversal.rail
         OR original.payout_ref IS DISTINCT FROM reversal.payout_ref
       FROM payments_ledger.journal original, payments_ledger.journal reversal
      WHERE original.tenant_id = target_tenant AND original.journal_id = original_journal
        AND reversal.tenant_id = target_tenant AND reversal.journal_id = target_journal)
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

-- 4. Re-reconciling a payout may open a new drift item: each reconciliation run that
--    drifts is its own row, keyed by reconciliation_id. Rows from 0021 get 'legacy-0021'.
ALTER TABLE payments_ledger.payout_drift_work_item
  ADD COLUMN IF NOT EXISTS reconciliation_id text NOT NULL DEFAULT 'legacy-0021';
ALTER TABLE payments_ledger.payout_drift_work_item ALTER COLUMN reconciliation_id DROP DEFAULT;
ALTER TABLE payments_ledger.payout_drift_work_item
  DROP CONSTRAINT IF EXISTS payout_drift_work_item_reconciliation_id;
ALTER TABLE payments_ledger.payout_drift_work_item
  ADD CONSTRAINT payout_drift_work_item_reconciliation_id CHECK (reconciliation_id <> '');
ALTER TABLE payments_ledger.payout_drift_work_item DROP CONSTRAINT IF EXISTS payout_drift_work_item_pkey;
ALTER TABLE payments_ledger.payout_drift_work_item
  ADD CONSTRAINT payout_drift_work_item_pkey PRIMARY KEY (tenant_id, payout_ref, currency, reconciliation_id);

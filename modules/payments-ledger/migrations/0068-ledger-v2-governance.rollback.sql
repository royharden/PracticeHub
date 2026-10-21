-- Rollback for 0068-ledger-v2-governance.sql. Restores the 0021 shape.
-- Step 4 fails loudly when a payout has more than one drift item, because the
-- 0021 key cannot hold them; resolve or archive the extra rows first.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM payments_ledger.payout_drift_work_item
     GROUP BY tenant_id, payout_ref, currency HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'rollback 0068: a payout has more than one drift item';
  END IF;
END
$guard$;
ALTER TABLE payments_ledger.payout_drift_work_item DROP CONSTRAINT IF EXISTS payout_drift_work_item_pkey;
ALTER TABLE payments_ledger.payout_drift_work_item
  ADD CONSTRAINT payout_drift_work_item_pkey PRIMARY KEY (tenant_id, payout_ref, currency);
ALTER TABLE payments_ledger.payout_drift_work_item
  DROP CONSTRAINT IF EXISTS payout_drift_work_item_reconciliation_id;
ALTER TABLE payments_ledger.payout_drift_work_item DROP COLUMN IF EXISTS reconciliation_id;

-- The 0019 reversal check, verbatim.
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

DROP TRIGGER IF EXISTS write_off_matches_journal ON payments_ledger.write_off;
DROP FUNCTION IF EXISTS payments_ledger.assert_write_off_journal();
ALTER TABLE payments_ledger.journal DROP CONSTRAINT IF EXISTS journal_write_off_approval_hash;
ALTER TABLE payments_ledger.journal DROP COLUMN IF EXISTS write_off_approval_hash;
DROP INDEX IF EXISTS payments_ledger.write_off_one_per_journal;
DROP INDEX IF EXISTS payments_ledger.write_off_one_use_per_approval;
ALTER TABLE payments_ledger.write_off DROP CONSTRAINT IF EXISTS write_off_governed;
ALTER TABLE payments_ledger.write_off DROP COLUMN IF EXISTS requester_actor_id;
ALTER TABLE payments_ledger.write_off DROP COLUMN IF EXISTS approver_actor_id;
ALTER TABLE payments_ledger.write_off DROP COLUMN IF EXISTS approval_hash;
ALTER TABLE payments_ledger.write_off DROP COLUMN IF EXISTS target_ref;

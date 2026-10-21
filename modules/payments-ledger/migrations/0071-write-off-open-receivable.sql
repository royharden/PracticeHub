-- 0071: WP-057 hardening H-21 (review D46-WP-056-a2-review-2, note on write-off.ts:336).
-- UNAPPLIED. Apply after 0068 with the other payments-ledger migrations.
--
-- A governed write-off may not take its receivable below zero: for the write-off's
-- (tenant_id, target_ref, currency), accounts-receivable debits minus credits in
-- payments_ledger.journal_line must stay >= 0. Two approvals with different
-- write_off_ids therefore cannot write off the same receivable twice.
--
-- The check is a DEFERRABLE INITIALLY DEFERRED constraint trigger, so it runs at
-- commit, after the write-off journal's lines and the write_off row are both in
-- place, whichever order the transaction inserts them in. It creates no table and
-- touches no RLS section. Pre-0071 rows are not rechecked.
--
-- Nothing is issued-statement related here: payments_ledger.statement already has
-- PRIMARY KEY (tenant_id, statement_id) (0022), which is the durable record NR-141
-- needs; the TS registry mirrors it.

CREATE OR REPLACE FUNCTION payments_ledger.assert_write_off_within_receivable()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
AS $$
DECLARE
  open_minor numeric;
BEGIN
  IF current_setting('transaction_isolation', true) IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'governed write-off insertion requires READ COMMITTED isolation'
      USING ERRCODE = '23514';
  END IF;
  -- Separate statements are essential: after a lock wait, VOLATILE queries at
  -- READ COMMITTED obtain a fresh snapshot for the balance below. The lock stays
  -- held even when callers force deferred checks before transaction completion.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array('payments-ledger/write-off-open-receivable/v1',
      NEW.tenant_id, NEW.target_ref, NEW.currency)::text, 0));
  SELECT coalesce(sum(CASE WHEN side = 'debit' THEN amount_minor ELSE -amount_minor END), 0)
    INTO open_minor
    FROM payments_ledger.journal_line
   WHERE tenant_id = NEW.tenant_id
     AND account_ref = 'accounts-receivable'
     AND source_ref = NEW.target_ref
     AND currency = NEW.currency;
  IF open_minor < 0 THEN
    RAISE EXCEPTION 'write-off % takes receivable % below zero', NEW.write_off_id, NEW.target_ref
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS write_off_within_receivable ON payments_ledger.write_off;
CREATE CONSTRAINT TRIGGER write_off_within_receivable
  AFTER INSERT ON payments_ledger.write_off
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payments_ledger.assert_write_off_within_receivable();

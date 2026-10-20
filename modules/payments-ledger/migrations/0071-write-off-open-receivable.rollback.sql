-- Rollback for 0071-write-off-open-receivable.sql: removes the open-receivable
-- constraint trigger and its function. No table or data is touched.
DROP TRIGGER IF EXISTS write_off_within_receivable ON payments_ledger.write_off;
DROP FUNCTION IF EXISTS payments_ledger.assert_write_off_within_receivable();

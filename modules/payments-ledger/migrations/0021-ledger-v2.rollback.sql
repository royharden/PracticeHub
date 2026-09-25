ALTER TABLE payments_ledger.journal DROP CONSTRAINT IF EXISTS journal_payout_rail;
ALTER TABLE payments_ledger.journal DROP CONSTRAINT IF EXISTS journal_rail;
ALTER TABLE payments_ledger.journal DROP COLUMN IF EXISTS payout_ref;
ALTER TABLE payments_ledger.journal DROP COLUMN IF EXISTS rail;
DROP TABLE IF EXISTS payments_ledger.payout_drift_work_item;
DROP TABLE IF EXISTS payments_ledger.write_off;

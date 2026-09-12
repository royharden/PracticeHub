DROP FUNCTION IF EXISTS payments_ledger.assert_balanced_journal() CASCADE;
DROP FUNCTION IF EXISTS payments_ledger.assert_open_posting() CASCADE;
DROP FUNCTION IF EXISTS payments_ledger.is_entitlement_authority(text,text,text);
DROP TABLE IF EXISTS payments_ledger.journal_line;
DROP TABLE IF EXISTS payments_ledger.journal;
DROP TABLE IF EXISTS payments_ledger.payment_intent;
DROP SCHEMA IF EXISTS payments_ledger;
REVOKE module_payments_ledger FROM practicehub_app;

-- Rollback for 0069-dunning-deceased-stop.sql. Rows already stopped stay stopped;
-- only the transition function, the guard and the irreversibility trigger are removed.
DROP FUNCTION IF EXISTS payments_ledger.assert_dunning_allowed(text, text);
DROP TRIGGER IF EXISTS dunning_account_transition ON payments_ledger.dunning_account;
DROP FUNCTION IF EXISTS payments_ledger.assert_dunning_transition();
DROP FUNCTION IF EXISTS payments_ledger.record_deceased_stop(text, text);

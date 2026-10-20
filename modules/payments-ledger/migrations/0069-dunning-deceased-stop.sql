-- WP-057 rework 1 (review D46-WP-057-a1-review-1). Forward-only: 0022 stays as landed.
-- dunning_account keeps UPDATE revoked from module_payments_ledger. The only way an
-- existing account changes is this guarded transition, which records deceased and
-- stops dunning in one statement. It creates no table, so the RLS sections are unchanged.

CREATE OR REPLACE FUNCTION payments_ledger.record_deceased_stop(
  target_tenant text,
  target_account text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, payments_ledger
AS $deceased$
BEGIN
  IF target_tenant IS DISTINCT FROM current_setting('practicehub.tenant_id', true) THEN
    RAISE EXCEPTION 'record_deceased_stop: tenant % is not the bound tenant', target_tenant
      USING ERRCODE = '42501';
  END IF;
  UPDATE payments_ledger.dunning_account
     SET deceased = true, dunning = 'stopped', stopped_reason = 'deceased'
   WHERE tenant_id = target_tenant AND account_ref = target_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_deceased_stop: account % not found', target_account
      USING ERRCODE = 'P0002';
  END IF;
END
$deceased$;
REVOKE ALL ON FUNCTION payments_ledger.record_deceased_stop(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payments_ledger.record_deceased_stop(text, text) TO module_payments_ledger;

-- A deceased stop can never be undone, and an account's identity never changes.
CREATE OR REPLACE FUNCTION payments_ledger.assert_dunning_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $transition$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.account_ref <> OLD.account_ref THEN
    RAISE EXCEPTION 'dunning account identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.deceased AND NOT NEW.deceased) OR (OLD.dunning = 'stopped' AND NEW.dunning <> 'stopped') THEN
    RAISE EXCEPTION 'dunning stop for % cannot be reversed', OLD.account_ref USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$transition$;

DROP TRIGGER IF EXISTS dunning_account_transition ON payments_ledger.dunning_account;
CREATE TRIGGER dunning_account_transition
BEFORE UPDATE ON payments_ledger.dunning_account
FOR EACH ROW EXECUTE FUNCTION payments_ledger.assert_dunning_transition();

-- Called before any dunning notice is sent: refuses a stopped or deceased account,
-- and an account with no dunning row at all.
CREATE OR REPLACE FUNCTION payments_ledger.assert_dunning_allowed(
  target_tenant text,
  target_account text
)
RETURNS void
LANGUAGE plpgsql
STABLE
AS $allowed$
DECLARE
  current_row payments_ledger.dunning_account%ROWTYPE;
BEGIN
  SELECT * INTO current_row FROM payments_ledger.dunning_account
   WHERE tenant_id = target_tenant AND account_ref = target_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dunning account % not found', target_account USING ERRCODE = 'P0002';
  END IF;
  IF current_row.deceased OR current_row.dunning = 'stopped' THEN
    RAISE EXCEPTION 'dunning is stopped for %', target_account USING ERRCODE = '23514';
  END IF;
END
$allowed$;
REVOKE ALL ON FUNCTION payments_ledger.assert_dunning_allowed(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payments_ledger.assert_dunning_allowed(text, text) TO module_payments_ledger;

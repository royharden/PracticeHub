REVOKE EXECUTE ON FUNCTION payments_ledger.is_entitlement_authority(text,text,text)
  FROM module_membership_entitlements;
DROP TABLE IF EXISTS membership_entitlements.entitlement_event;
DROP FUNCTION IF EXISTS membership_entitlements.assert_exact_reversal();
DROP SCHEMA IF EXISTS membership_entitlements;
REVOKE module_membership_entitlements FROM practicehub_app;

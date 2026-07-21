-- WP-013 rollback: drop the identity module schema objects (package rollback
-- expectation: drop schema). The module role is dropped last; platform_core
-- objects (0001..0003) are untouched.

DROP TABLE IF EXISTS identity.identity_timeline;
DROP TABLE IF EXISTS identity.source_identifier;
DROP TABLE IF EXISTS identity.endpoint_association;
DROP TABLE IF EXISTS identity.channel_endpoint;
DROP TABLE IF EXISTS identity.proxy_grant;
DROP TABLE IF EXISTS identity.guarantor_role;
DROP TABLE IF EXISTS identity.staff_account;
DROP TABLE IF EXISTS identity.patient_record;
DROP TABLE IF EXISTS identity.person_name;
DROP TABLE IF EXISTS identity.person;
DROP SCHEMA IF EXISTS identity;

DO $roles$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_identity') THEN
    REVOKE module_identity FROM practicehub_app;
    DROP ROLE module_identity;
  END IF;
END
$roles$;

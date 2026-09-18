DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'tenant_white_label') THEN
    DROP TABLE IF EXISTS tenant_white_label.profile;
    DROP SCHEMA IF EXISTS tenant_white_label;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_tenant_white_label') THEN
    DROP ROLE module_tenant_white_label;
  END IF;
END
$guard$;

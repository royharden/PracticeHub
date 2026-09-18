-- WP-126 tenant-2 white-label. Unapplied. Simulated isolation proof.
CREATE SCHEMA IF NOT EXISTS tenant_white_label;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_tenant_white_label') THEN
    CREATE ROLE module_tenant_white_label NOLOGIN;
  END IF;
END
$roles$;
GRANT module_tenant_white_label TO practicehub_app;
GRANT USAGE ON SCHEMA tenant_white_label TO module_tenant_white_label;

CREATE TABLE IF NOT EXISTS tenant_white_label.profile (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  wordmark text NOT NULL,
  primary_color text NOT NULL,
  timezone text NOT NULL,
  fax_cover_ref text NOT NULL,
  letterhead_ref text NOT NULL,
  fax_number_ref text NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic = true),
  PRIMARY KEY (tenant_id)
);

GRANT SELECT, INSERT, UPDATE ON tenant_white_label.profile TO module_tenant_white_label;

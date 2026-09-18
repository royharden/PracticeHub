-- WP-117 synthetic acquisition rehearsal. Unapplied.
CREATE SCHEMA IF NOT EXISTS acquisition_rehearsal;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_acquisition_rehearsal') THEN
    CREATE ROLE module_acquisition_rehearsal NOLOGIN;
  END IF;
END
$roles$;
GRANT module_acquisition_rehearsal TO practicehub_app;
GRANT USAGE ON SCHEMA acquisition_rehearsal TO module_acquisition_rehearsal;

CREATE TABLE IF NOT EXISTS acquisition_rehearsal.rehearsal_run (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  run_id text NOT NULL CHECK (run_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  panel_id text NOT NULL,
  imported integer NOT NULL,
  cut_over integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ready-20-of-20','failed-cutover','post-freeze-restored')),
  frozen boolean NOT NULL,
  restored boolean NOT NULL,
  rekeyed boolean NOT NULL,
  work_item_id text,
  synthetic boolean NOT NULL CHECK (synthetic = true),
  PRIMARY KEY (tenant_id, run_id)
);

GRANT SELECT, INSERT, UPDATE ON acquisition_rehearsal.rehearsal_run TO module_acquisition_rehearsal;

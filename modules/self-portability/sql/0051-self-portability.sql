-- UNAPPLIED. WP-121 self-portability export jobs. Do not migrate from this package.
-- Named 0051-self-portability.sql per assignments/D20-WP-121-paths.md.
CREATE SCHEMA IF NOT EXISTS self_portability;
CREATE TABLE IF NOT EXISTS self_portability.export_job (
  tenant_id text NOT NULL,
  legal_entity_id text,
  job_id text NOT NULL,
  exported_at timestamptz NOT NULL,
  schema_id text NOT NULL,
  envelope_ref text NOT NULL,
  PRIMARY KEY (tenant_id, job_id)
);

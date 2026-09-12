-- WP-076 analytics read-model migration. This schema stores versioned metric
-- definitions, immutable projection snapshots, source lineage, and one shared
-- disclosure history per tenant/dataset/cohort/purpose. It contains synthetic
-- data only in this increment and has no foreign keys into operational modules.
-- Idempotent: safe to re-apply. Rollback: 0026-analytics.rollback.sql.

CREATE SCHEMA IF NOT EXISTS analytics;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_analytics') THEN
    CREATE ROLE module_analytics NOLOGIN;
  END IF;
END
$roles$;

GRANT module_analytics TO practicehub_app;
GRANT USAGE ON SCHEMA analytics TO module_analytics;

CREATE TABLE IF NOT EXISTS analytics.metric_definition (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  metric_id text NOT NULL CHECK (metric_id ~ '^[a-z0-9][a-z0-9:./-]{0,199}$'),
  metric_version integer NOT NULL CHECK (metric_version >= 1),
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('draft', 'active', 'superseded')),
  denominator_ref text NOT NULL,
  allowed_event_types text[] NOT NULL CHECK (cardinality(allowed_event_types) >= 1),
  required_source_refs text[] NOT NULL CHECK (cardinality(required_source_refs) >= 1),
  freshness_objective_minutes integer NOT NULL CHECK (freshness_objective_minutes > 0),
  dimensions text[] NOT NULL CHECK (
    dimensions <@ ARRAY['location', 'cohort', 'service', 'channel', 'status', 'owner']::text[]
  ),
  minimum_cell_count integer NOT NULL CHECK (minimum_cell_count >= 2),
  maximum_classification text NOT NULL CHECK (
    maximum_classification IN ('none', 'demographic', 'PHI')
  ),
  accountable_owner_ref text NOT NULL,
  release_family jsonb NOT NULL CHECK (jsonb_typeof(release_family) = 'object'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, metric_id, metric_version),
  UNIQUE (tenant_id, metric_id, metric_version, definition_hash)
);

CREATE TABLE IF NOT EXISTS analytics.projection_version (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  version_ref text NOT NULL,
  legal_entity_id text,
  dataset_id text NOT NULL,
  cohort_ref text NOT NULL,
  metric_id text NOT NULL,
  metric_version integer NOT NULL CHECK (metric_version >= 1),
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  built_at timestamptz NOT NULL,
  event_ids text[] NOT NULL CHECK (cardinality(event_ids) >= 1),
  maximum_classification text NOT NULL CHECK (
    maximum_classification IN ('none', 'demographic', 'PHI')
  ),
  partition_tags text[] NOT NULL DEFAULT '{}' CHECK (
    partition_tags <@ ARRAY['chd', 'part2', 'biometric']::text[]
  ),
  verification_status text NOT NULL CHECK (
    verification_status IN ('verified', 'quarantined')
  ),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  supersedes_version_ref text,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, version_ref),
  UNIQUE (tenant_id, dataset_id, cohort_ref, metric_id, metric_version, version_ref),
  FOREIGN KEY (tenant_id, metric_id, metric_version, definition_hash)
    REFERENCES analytics.metric_definition
      (tenant_id, metric_id, metric_version, definition_hash)
);

CREATE TABLE IF NOT EXISTS analytics.projection_cell (
  tenant_id text NOT NULL,
  version_ref text NOT NULL,
  cell_id text NOT NULL,
  member_count integer NOT NULL CHECK (member_count >= 0),
  measure_value bigint NOT NULL CHECK (
    measure_value BETWEEN -9007199254740991 AND 9007199254740991
  ),
  work_item_refs text[] NOT NULL DEFAULT '{}',
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, version_ref, cell_id),
  FOREIGN KEY (tenant_id, version_ref)
    REFERENCES analytics.projection_version (tenant_id, version_ref)
);

CREATE TABLE IF NOT EXISTS analytics.projection_source_offset (
  tenant_id text NOT NULL,
  version_ref text NOT NULL,
  source_ref text NOT NULL,
  high_water_mark text NOT NULL,
  loaded_at timestamptz NOT NULL,
  receipt_ref text,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, version_ref, source_ref),
  FOREIGN KEY (tenant_id, version_ref)
    REFERENCES analytics.projection_version (tenant_id, version_ref)
);

CREATE TABLE IF NOT EXISTS analytics.projection_event (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  event_id text NOT NULL,
  legal_entity_id text,
  event_type text NOT NULL,
  metric_id text NOT NULL,
  metric_version integer NOT NULL CHECK (metric_version >= 1),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  source_ref text NOT NULL,
  source_offset text NOT NULL CHECK (source_offset ~ '^(0|[1-9][0-9]*)$'),
  source_receipt_ref text NOT NULL,
  supersedes_event_id text CHECK (
    supersedes_event_id IS NULL OR supersedes_event_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'
  ),
  reversal_of_event_id text CHECK (
    reversal_of_event_id IS NULL OR reversal_of_event_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'
  ),
  cell_id text NOT NULL,
  measure_value bigint NOT NULL,
  data_classification text NOT NULL CHECK (
    data_classification IN ('none', 'demographic', 'PHI')
  ),
  partition_tags text[] NOT NULL DEFAULT '{}' CHECK (
    partition_tags <@ ARRAY['chd', 'part2', 'biometric']::text[]
  ),
  work_item_refs text[] NOT NULL DEFAULT '{}',
  fact_hash text NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
  synthetic boolean NOT NULL CHECK (synthetic),
  CHECK (supersedes_event_id IS NULL OR reversal_of_event_id IS NULL),
  PRIMARY KEY (tenant_id, metric_id, metric_version, event_id),
  FOREIGN KEY (tenant_id, metric_id, metric_version)
    REFERENCES analytics.metric_definition (tenant_id, metric_id, metric_version)
);

CREATE TABLE IF NOT EXISTS analytics.projection_disclosure (
  tenant_id text NOT NULL,
  disclosure_id text NOT NULL,
  dataset_id text NOT NULL,
  cohort_ref text NOT NULL,
  metric_id text NOT NULL,
  projection_version_ref text NOT NULL,
  purpose text NOT NULL,
  node_id text NOT NULL,
  surface text NOT NULL CHECK (surface IN ('view', 'export')),
  occurred_at timestamptz NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, disclosure_id),
  FOREIGN KEY (tenant_id, projection_version_ref)
    REFERENCES analytics.projection_version (tenant_id, version_ref)
);

CREATE INDEX IF NOT EXISTS projection_disclosure_scope
  ON analytics.projection_disclosure
    (tenant_id, dataset_id, cohort_ref, metric_id, projection_version_ref, purpose);

CREATE TABLE IF NOT EXISTS analytics.projection_export_receipt (
  tenant_id text NOT NULL,
  export_receipt_id text NOT NULL,
  disclosure_id text NOT NULL,
  artifact_ref text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  exported_at timestamptz NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, export_receipt_id),
  FOREIGN KEY (tenant_id, disclosure_id)
    REFERENCES analytics.projection_disclosure (tenant_id, disclosure_id)
);

GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO module_analytics;
GRANT INSERT ON
  analytics.projection_version,
  analytics.projection_cell,
  analytics.projection_source_offset,
  analytics.projection_event,
  analytics.projection_disclosure,
  analytics.projection_export_receipt
TO module_analytics;
REVOKE INSERT ON analytics.metric_definition FROM module_analytics;
REVOKE UPDATE, DELETE ON ALL TABLES IN SCHEMA analytics FROM module_analytics;

ALTER TABLE analytics.metric_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.metric_definition FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON analytics.metric_definition;
CREATE POLICY tenant_isolation ON analytics.metric_definition
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE analytics.projection_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.projection_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON analytics.projection_version;
CREATE POLICY tenant_isolation ON analytics.projection_version
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE analytics.projection_cell ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.projection_cell FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON analytics.projection_cell;
CREATE POLICY tenant_isolation ON analytics.projection_cell
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE analytics.projection_source_offset ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.projection_source_offset FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON analytics.projection_source_offset;
CREATE POLICY tenant_isolation ON analytics.projection_source_offset
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE analytics.projection_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.projection_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON analytics.projection_event;
CREATE POLICY tenant_isolation ON analytics.projection_event
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE analytics.projection_disclosure ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.projection_disclosure FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON analytics.projection_disclosure;
CREATE POLICY tenant_isolation ON analytics.projection_disclosure
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE analytics.projection_export_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.projection_export_receipt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON analytics.projection_export_receipt;
CREATE POLICY tenant_isolation ON analytics.projection_export_receipt
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

DO $coverage$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO offender
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'analytics'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema analytics: %', offender;
  END IF;
END
$coverage$;

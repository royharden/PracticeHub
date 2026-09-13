-- WP-110 M27 migration workbench staging evidence. This schema is effect-free:
-- it owns no target-domain table and conveys no wave-import authority.
-- Contract: docs/contracts/migration-workbench-api.md.

CREATE SCHEMA IF NOT EXISTS migration;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_migration') THEN
    CREATE ROLE module_migration NOLOGIN;
  END IF;
END
$roles$;

GRANT module_migration TO practicehub_app;
GRANT USAGE ON SCHEMA migration TO module_migration;

CREATE TABLE IF NOT EXISTS migration.mapping_version (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  mapping_version_ref text NOT NULL CHECK (mapping_version_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  source_system_ref text NOT NULL CHECK (source_system_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  mapping_version_hash text NOT NULL CHECK (mapping_version_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('review-required', 'approved')),
  approved_by text CHECK (approved_by IS NULL OR approved_by ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  approval_evidence_ref text CHECK (approval_evidence_ref IS NULL OR approval_evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  rules_json jsonb NOT NULL CHECK (jsonb_typeof(rules_json) = 'array'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, mapping_version_ref),
  CONSTRAINT mv_approval_shape CHECK (
    (status = 'approved' AND approved_by IS NOT NULL AND approval_evidence_ref IS NOT NULL)
    OR (status = 'review-required' AND approved_by IS NULL AND approval_evidence_ref IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS migration.source_manifest (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  source_manifest_ref text NOT NULL CHECK (source_manifest_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  source_system_ref text NOT NULL CHECK (source_system_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  source_manifest_hash text NOT NULL CHECK (source_manifest_hash ~ '^[0-9a-f]{64}$'),
  structurally_readable boolean NOT NULL,
  in_scope_record_count integer CHECK (in_scope_record_count IS NULL OR in_scope_record_count > 0),
  source_fields text[] NOT NULL CHECK (cardinality(source_fields) > 0),
  artifact_refs text[] NOT NULL CHECK (cardinality(artifact_refs) > 0),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, source_manifest_ref)
);

CREATE TABLE IF NOT EXISTS migration.batch_event (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  batch_ref text NOT NULL CHECK (batch_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  version integer NOT NULL CHECK (version > 0),
  event_ref text NOT NULL CHECK (event_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  event_type text NOT NULL CHECK (event_type IN ('initialized', 'dry-run-recorded', 'review-workitem-linked', 'rollback-approved', 'rollback-recorded')),
  source_system_ref text CHECK (source_system_ref IS NULL OR source_system_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  run_ref text CHECK (run_ref IS NULL OR run_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  readiness text CHECK (readiness IN ('blocked', 'ready-for-review')),
  work_item_ref text CHECK (work_item_ref IS NULL OR work_item_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, batch_ref, version),
  UNIQUE (tenant_id, event_ref),
  CONSTRAINT be_event_shape CHECK (
    (event_type = 'initialized' AND version = 1 AND source_system_ref IS NOT NULL AND run_ref IS NULL AND readiness IS NULL AND work_item_ref IS NULL)
    OR (event_type = 'dry-run-recorded' AND run_ref IS NOT NULL AND readiness IS NOT NULL AND source_system_ref IS NULL AND work_item_ref IS NULL)
    OR (event_type = 'review-workitem-linked' AND work_item_ref IS NOT NULL AND source_system_ref IS NULL AND run_ref IS NOT NULL AND readiness IS NULL)
    OR (event_type IN ('rollback-approved', 'rollback-recorded') AND source_system_ref IS NULL AND run_ref IS NULL AND readiness IS NULL AND work_item_ref IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS migration.batch_state (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  batch_ref text NOT NULL CHECK (batch_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  source_system_ref text NOT NULL CHECK (source_system_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  version integer NOT NULL CHECK (version > 0),
  latest_run_ref text CHECK (latest_run_ref IS NULL OR latest_run_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  latest_readiness text CHECK (latest_readiness IN ('blocked', 'ready-for-review')),
  review_work_item_ref text CHECK (review_work_item_ref IS NULL OR review_work_item_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, batch_ref),
  CONSTRAINT bs_last_event_same_tenant FOREIGN KEY (tenant_id, batch_ref, version)
    REFERENCES migration.batch_event (tenant_id, batch_ref, version)
);

CREATE TABLE IF NOT EXISTS migration.validation_run (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  run_ref text NOT NULL CHECK (run_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  predecessor_run_ref text CHECK (predecessor_run_ref IS NULL OR predecessor_run_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  source_manifest_ref text NOT NULL,
  mapping_version_ref text NOT NULL,
  source_manifest_hash text NOT NULL CHECK (source_manifest_hash ~ '^[0-9a-f]{64}$'),
  mapping_version_hash text NOT NULL CHECK (mapping_version_hash ~ '^[0-9a-f]{64}$'),
  failed_record_count integer NOT NULL CHECK (failed_record_count >= 0),
  in_scope_record_count integer NOT NULL CHECK (in_scope_record_count > 0 AND failed_record_count <= in_scope_record_count),
  threshold_basis_points integer NOT NULL CHECK (threshold_basis_points BETWEEN 0 AND 10000),
  previously_threshold_blocked boolean NOT NULL,
  threshold_state text NOT NULL CHECK (threshold_state IN ('clear', 'blocked', 'held-until-below')),
  readiness text NOT NULL CHECK (readiness IN ('blocked', 'ready-for-review')),
  blocker_codes text[] NOT NULL,
  code_version_ref text NOT NULL CHECK (code_version_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  config_version_ref text NOT NULL CHECK (config_version_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  sample_evidence_refs text[] NOT NULL CHECK (cardinality(sample_evidence_refs) > 0),
  runtime_milliseconds integer NOT NULL CHECK (runtime_milliseconds >= 0),
  signoff_refs text[] NOT NULL CHECK (cardinality(signoff_refs) > 0),
  proposed_write_set_hash text NOT NULL CHECK (proposed_write_set_hash ~ '^[0-9a-f]{64}$'),
  comparison_json jsonb NOT NULL CHECK (jsonb_typeof(comparison_json) = 'object'),
  failed_record_count_change integer,
  target_data_writes integer NOT NULL DEFAULT 0 CHECK (target_data_writes = 0),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, run_ref),
  CONSTRAINT vr_manifest_same_tenant FOREIGN KEY (tenant_id, source_manifest_ref)
    REFERENCES migration.source_manifest (tenant_id, source_manifest_ref),
  CONSTRAINT vr_mapping_same_tenant FOREIGN KEY (tenant_id, mapping_version_ref)
    REFERENCES migration.mapping_version (tenant_id, mapping_version_ref),
  CONSTRAINT vr_predecessor_same_tenant FOREIGN KEY (tenant_id, predecessor_run_ref)
    REFERENCES migration.validation_run (tenant_id, run_ref)
);

CREATE OR REPLACE FUNCTION migration.enforce_validation_run_chain()
RETURNS trigger LANGUAGE plpgsql AS $chain$
DECLARE
  predecessor_state text;
  predecessor_failed integer;
  predecessor_manifest_ref text;
  predecessor_threshold_basis_points integer;
  stored_manifest_hash text;
  stored_manifest_count integer;
  stored_manifest_source text;
  stored_mapping_hash text;
  stored_mapping_source text;
  stored_mapping_status text;
  derived_previously_blocked boolean;
  expected_threshold_state text;
  key_field text;
  key_counts jsonb;
BEGIN
  SELECT source_manifest_hash, in_scope_record_count, source_system_ref
    INTO stored_manifest_hash, stored_manifest_count, stored_manifest_source
    FROM migration.source_manifest
   WHERE tenant_id = NEW.tenant_id AND source_manifest_ref = NEW.source_manifest_ref;
  SELECT mapping_version_hash, source_system_ref, status
    INTO stored_mapping_hash, stored_mapping_source, stored_mapping_status
    FROM migration.mapping_version
   WHERE tenant_id = NEW.tenant_id AND mapping_version_ref = NEW.mapping_version_ref;
  IF stored_manifest_hash IS NULL OR stored_mapping_hash IS NULL OR
     NEW.source_manifest_hash <> stored_manifest_hash OR
     NEW.mapping_version_hash <> stored_mapping_hash OR
     NEW.in_scope_record_count IS DISTINCT FROM stored_manifest_count OR
     stored_manifest_source IS DISTINCT FROM stored_mapping_source OR
     stored_mapping_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'validation run hashes do not match immutable source and mapping evidence';
  END IF;
  IF NOT (NEW.comparison_json ?& ARRAY[
      'sourceRecordCount', 'candidateRecordCount', 'keyFieldCompleteness',
      'identityMatchResults', 'outcomeCounts'
    ]) OR (SELECT count(*) FROM jsonb_object_keys(NEW.comparison_json)) <> 5 OR
    jsonb_typeof(NEW.comparison_json -> 'keyFieldCompleteness') <> 'object' OR
    jsonb_typeof(NEW.comparison_json -> 'identityMatchResults') <> 'object' OR
    jsonb_typeof(NEW.comparison_json -> 'outcomeCounts') <> 'object' OR
    NOT ((NEW.comparison_json -> 'identityMatchResults') ?&
      ARRAY['matched', 'candidate', 'ambiguous', 'unmatched']) OR
    (SELECT count(*) FROM jsonb_object_keys(
      NEW.comparison_json -> 'identityMatchResults')) <> 4 OR
    NOT ((NEW.comparison_json -> 'outcomeCounts') ?&
      ARRAY['created', 'updated', 'merged', 'flagged']) OR
    (SELECT count(*) FROM jsonb_object_keys(
      NEW.comparison_json -> 'outcomeCounts')) <> 4 OR
    jsonb_typeof(NEW.comparison_json -> 'sourceRecordCount') <> 'number' OR
    jsonb_typeof(NEW.comparison_json -> 'candidateRecordCount') <> 'number' OR
    jsonb_typeof(NEW.comparison_json -> 'identityMatchResults' -> 'matched') <> 'number' OR
    jsonb_typeof(NEW.comparison_json -> 'identityMatchResults' -> 'candidate') <> 'number' OR
    jsonb_typeof(NEW.comparison_json -> 'identityMatchResults' -> 'ambiguous') <> 'number' OR
    jsonb_typeof(NEW.comparison_json -> 'identityMatchResults' -> 'unmatched') <> 'number' OR
    jsonb_typeof(NEW.comparison_json -> 'outcomeCounts' -> 'created') <> 'number' OR
    jsonb_typeof(NEW.comparison_json -> 'outcomeCounts' -> 'updated') <> 'number' OR
    jsonb_typeof(NEW.comparison_json -> 'outcomeCounts' -> 'merged') <> 'number' OR
    jsonb_typeof(NEW.comparison_json -> 'outcomeCounts' -> 'flagged') <> 'number' OR
    COALESCE((NEW.comparison_json ->> 'sourceRecordCount')::integer, -1) <>
      NEW.in_scope_record_count OR
    COALESCE((NEW.comparison_json ->> 'candidateRecordCount')::integer, -1) < 0 OR
    COALESCE((NEW.comparison_json -> 'identityMatchResults' ->> 'matched')::integer, -1) < 0 OR
    COALESCE((NEW.comparison_json -> 'identityMatchResults' ->> 'candidate')::integer, -1) < 0 OR
    COALESCE((NEW.comparison_json -> 'identityMatchResults' ->> 'ambiguous')::integer, -1) < 0 OR
    COALESCE((NEW.comparison_json -> 'identityMatchResults' ->> 'unmatched')::integer, -1) < 0 OR
    COALESCE((NEW.comparison_json -> 'outcomeCounts' ->> 'created')::integer, -1) < 0 OR
    COALESCE((NEW.comparison_json -> 'outcomeCounts' ->> 'updated')::integer, -1) < 0 OR
    COALESCE((NEW.comparison_json -> 'outcomeCounts' ->> 'merged')::integer, -1) < 0 OR
    COALESCE((NEW.comparison_json -> 'outcomeCounts' ->> 'flagged')::integer, -1) < 0 OR
    (COALESCE((NEW.comparison_json -> 'identityMatchResults' ->> 'matched')::integer, -1) +
     COALESCE((NEW.comparison_json -> 'identityMatchResults' ->> 'candidate')::integer, -1) +
     COALESCE((NEW.comparison_json -> 'identityMatchResults' ->> 'ambiguous')::integer, -1) +
     COALESCE((NEW.comparison_json -> 'identityMatchResults' ->> 'unmatched')::integer, -1)) <>
      NEW.in_scope_record_count THEN
    RAISE EXCEPTION 'validation comparison does not match the frozen source population';
  END IF;
  FOR key_field, key_counts IN
    SELECT key, value FROM jsonb_each(NEW.comparison_json -> 'keyFieldCompleteness')
  LOOP
    IF key_field !~ '^[a-z][a-z0-9-]{0,63}$' OR
       jsonb_typeof(key_counts) <> 'object' OR
       NOT (key_counts ?& ARRAY['sourceCompleteCount', 'candidateCompleteCount']) OR
       (SELECT count(*) FROM jsonb_object_keys(key_counts)) <> 2 OR
       jsonb_typeof(key_counts -> 'sourceCompleteCount') <> 'number' OR
       jsonb_typeof(key_counts -> 'candidateCompleteCount') <> 'number' OR
       COALESCE((key_counts ->> 'sourceCompleteCount')::integer, -1) < 0 OR
       COALESCE((key_counts ->> 'sourceCompleteCount')::integer, -1) >
         NEW.in_scope_record_count OR
       COALESCE((key_counts ->> 'candidateCompleteCount')::integer, -1) < 0 OR
       COALESCE((key_counts ->> 'candidateCompleteCount')::integer, -1) >
         (NEW.comparison_json ->> 'candidateRecordCount')::integer THEN
      RAISE EXCEPTION 'validation key-field completeness has an invalid shape or range';
    END IF;
  END LOOP;
  IF NEW.predecessor_run_ref IS NULL THEN
    IF NEW.previously_threshold_blocked OR NEW.failed_record_count_change IS NOT NULL THEN
      RAISE EXCEPTION 'initial validation run cannot claim predecessor state';
    END IF;
    derived_previously_blocked := false;
  ELSE
    SELECT threshold_state, failed_record_count, source_manifest_ref, threshold_basis_points
      INTO predecessor_state, predecessor_failed, predecessor_manifest_ref,
        predecessor_threshold_basis_points
      FROM migration.validation_run
     WHERE tenant_id = NEW.tenant_id AND run_ref = NEW.predecessor_run_ref;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'validation predecessor is missing';
    END IF;
    derived_previously_blocked := predecessor_state <> 'clear';
    IF NEW.previously_threshold_blocked <> derived_previously_blocked THEN
      RAISE EXCEPTION 'validation predecessor threshold state mismatch';
    END IF;
    IF predecessor_manifest_ref IS DISTINCT FROM NEW.source_manifest_ref OR
       predecessor_threshold_basis_points IS DISTINCT FROM NEW.threshold_basis_points THEN
      RAISE EXCEPTION 'validation predecessor source or threshold policy mismatch';
    END IF;
    IF NEW.failed_record_count_change IS DISTINCT FROM NEW.failed_record_count - predecessor_failed THEN
      RAISE EXCEPTION 'validation predecessor failed-count delta mismatch';
    END IF;
  END IF;

  IF derived_previously_blocked THEN
    expected_threshold_state := CASE
      WHEN NEW.failed_record_count::bigint * 10000 <
           NEW.in_scope_record_count::bigint * NEW.threshold_basis_points::bigint
      THEN 'clear' ELSE 'held-until-below' END;
  ELSE
    expected_threshold_state := CASE
      WHEN NEW.failed_record_count::bigint * 10000 >
           NEW.in_scope_record_count::bigint * NEW.threshold_basis_points::bigint
      THEN 'blocked' ELSE 'clear' END;
  END IF;
  IF NEW.threshold_state <> expected_threshold_state THEN
    RAISE EXCEPTION 'validation threshold state does not match exact predecessor-bound rule';
  END IF;
  IF NEW.threshold_state <> 'clear' AND NEW.readiness <> 'blocked' THEN
    RAISE EXCEPTION 'threshold-blocked validation run must remain blocked';
  END IF;
  RETURN NEW;
END
$chain$;

DROP TRIGGER IF EXISTS validation_run_chain_guard ON migration.validation_run;
CREATE TRIGGER validation_run_chain_guard
BEFORE INSERT OR UPDATE ON migration.validation_run
FOR EACH ROW EXECUTE FUNCTION migration.enforce_validation_run_chain();

DO $batch_run_fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'be_run_same_tenant') THEN
    ALTER TABLE migration.batch_event ADD CONSTRAINT be_run_same_tenant
      FOREIGN KEY (tenant_id, run_ref)
      REFERENCES migration.validation_run (tenant_id, run_ref);
  END IF;
END
$batch_run_fk$;

CREATE OR REPLACE FUNCTION migration.enforce_batch_event_stream()
RETURNS trigger LANGUAGE plpgsql AS $stream$
DECLARE latest_run text;
BEGIN
  IF NEW.version = 1 THEN
    IF NEW.event_type <> 'initialized' THEN
      RAISE EXCEPTION 'migration batch stream must begin with initialized';
    END IF;
  ELSE
    IF NEW.event_type = 'initialized' OR NOT EXISTS (
      SELECT 1 FROM migration.batch_event
       WHERE tenant_id = NEW.tenant_id AND batch_ref = NEW.batch_ref
         AND version = NEW.version - 1
    ) THEN
      RAISE EXCEPTION 'migration batch stream has a missing predecessor';
    END IF;
  END IF;
  IF NEW.event_type = 'review-workitem-linked' THEN
    SELECT run_ref INTO latest_run FROM migration.batch_event
     WHERE tenant_id = NEW.tenant_id AND batch_ref = NEW.batch_ref
       AND event_type = 'dry-run-recorded'
     ORDER BY version DESC LIMIT 1;
    IF NEW.run_ref IS DISTINCT FROM latest_run THEN
      RAISE EXCEPTION 'review WorkItem is not bound to the latest validation run';
    END IF;
  END IF;
  RETURN NEW;
END
$stream$;

DROP TRIGGER IF EXISTS batch_event_stream_guard ON migration.batch_event;
CREATE TRIGGER batch_event_stream_guard
BEFORE INSERT ON migration.batch_event
FOR EACH ROW EXECUTE FUNCTION migration.enforce_batch_event_stream();

CREATE TABLE IF NOT EXISTS migration.validation_finding (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  run_ref text NOT NULL,
  finding_ref text NOT NULL CHECK (finding_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  record_ref text CHECK (record_ref IS NULL OR record_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  category text NOT NULL CHECK (category IN ('schema', 'required-field', 'business-rule', 'unmapped-field', 'type-mismatch', 'out-of-range', 'identity-ambiguity', 'genetic-misclassification', 'payer-panel-unmapped', 'file-structural-error')),
  triage text NOT NULL CHECK (triage IN ('auto-fixable', 'needs-source-correction', 'identity-review', 'file-level-quarantine')),
  mapping_rule_ref text CHECK (mapping_rule_ref IS NULL OR mapping_rule_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  observed_attribute_names text[] NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, run_ref, finding_ref),
  CONSTRAINT vf_run_same_tenant FOREIGN KEY (tenant_id, run_ref)
    REFERENCES migration.validation_run (tenant_id, run_ref),
  CONSTRAINT vf_file_shape CHECK ((category = 'file-structural-error' AND record_ref IS NULL) OR (category <> 'file-structural-error' AND record_ref IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS migration.control_total (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  run_ref text NOT NULL,
  total_ref text NOT NULL CHECK (total_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  side text NOT NULL CHECK (side IN ('source', 'candidate-target')),
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,63}$'),
  value_minor text NOT NULL CHECK (value_minor ~ '^(0|-?[1-9][0-9]*)$'),
  unit text NOT NULL CHECK (unit IN ('records', 'currency-minor')),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  reconciliation_state text NOT NULL CHECK (reconciliation_state IN ('reconciled', 'explained-difference', 'blocking')),
  explanation_ref text CHECK (explanation_ref IS NULL OR explanation_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, run_ref, total_ref),
  CONSTRAINT ct_semantic_unique UNIQUE NULLS NOT DISTINCT
    (tenant_id, run_ref, side, name, unit, currency),
  CONSTRAINT ct_run_same_tenant FOREIGN KEY (tenant_id, run_ref)
    REFERENCES migration.validation_run (tenant_id, run_ref),
  CONSTRAINT ct_currency_shape CHECK ((unit = 'currency-minor' AND currency IS NOT NULL) OR unit <> 'currency-minor'),
  CONSTRAINT ct_explanation_shape CHECK ((reconciliation_state = 'explained-difference' AND explanation_ref IS NOT NULL) OR (reconciliation_state <> 'explained-difference' AND explanation_ref IS NULL))
);

GRANT SELECT, INSERT ON migration.mapping_version, migration.source_manifest,
  migration.batch_event, migration.validation_run, migration.validation_finding,
  migration.control_total TO module_migration;
GRANT SELECT, INSERT, UPDATE ON migration.batch_state TO module_migration;

REVOKE UPDATE, DELETE ON migration.mapping_version, migration.source_manifest,
  migration.batch_event, migration.validation_run, migration.validation_finding,
  migration.control_total FROM module_migration;
REVOKE DELETE ON migration.batch_state FROM module_migration;

ALTER TABLE migration.mapping_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration.mapping_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration.mapping_version;
CREATE POLICY tenant_isolation ON migration.mapping_version USING (tenant_id = current_setting('practicehub.tenant_id', true)) WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE migration.source_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration.source_manifest FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration.source_manifest;
CREATE POLICY tenant_isolation ON migration.source_manifest USING (tenant_id = current_setting('practicehub.tenant_id', true)) WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE migration.batch_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration.batch_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration.batch_event;
CREATE POLICY tenant_isolation ON migration.batch_event USING (tenant_id = current_setting('practicehub.tenant_id', true)) WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE migration.batch_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration.batch_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration.batch_state;
CREATE POLICY tenant_isolation ON migration.batch_state USING (tenant_id = current_setting('practicehub.tenant_id', true)) WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE migration.validation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration.validation_run FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration.validation_run;
CREATE POLICY tenant_isolation ON migration.validation_run USING (tenant_id = current_setting('practicehub.tenant_id', true)) WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE migration.validation_finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration.validation_finding FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration.validation_finding;
CREATE POLICY tenant_isolation ON migration.validation_finding USING (tenant_id = current_setting('practicehub.tenant_id', true)) WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE migration.control_total ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration.control_total FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON migration.control_total;
CREATE POLICY tenant_isolation ON migration.control_total USING (tenant_id = current_setting('practicehub.tenant_id', true)) WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

DO $coverage$
DECLARE offender text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO offender
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'migration' AND c.relkind = 'r'
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('batch_event', 'batch_state', 'control_total',
            'mapping_version', 'source_manifest', 'validation_finding', 'validation_run'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema migration: %', offender;
  END IF;
END
$coverage$;

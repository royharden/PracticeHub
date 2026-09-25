-- WP-064 labs tables (M15). Contract: docs/contracts/lab-api.md (FROZEN).
-- Orders, versioned results, critical-result closure, and expected-result aging.
-- Manual outage rows stay provisional and keep their read-back.
-- Idempotent: safe to re-apply. Rollback: modules/labs/migrations/0064-labs.rollback.sql.
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('labs', labsRlsSpecs, labsRlsSpecs).

CREATE SCHEMA IF NOT EXISTS labs;

CREATE TABLE IF NOT EXISTS labs.lab_order (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  order_id text NOT NULL CHECK (order_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  subject_ref text NOT NULL CHECK (subject_ref ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  loinc_code text NOT NULL CHECK (char_length(loinc_code) BETWEEN 1 AND 200),
  loinc_display text NOT NULL CHECK (char_length(loinc_display) BETWEEN 1 AND 200),
  ordered_at timestamptz NOT NULL,
  expected_result_by timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('awaiting-result', 'resulted')),
  service_request_id text NOT NULL CHECK (service_request_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  current_result_id text CHECK (
    current_result_id IS NULL OR current_result_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'
  ),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, order_id),
  CONSTRAINT lab_order_expected_after_ordered CHECK (expected_result_by > ordered_at)
);

CREATE TABLE IF NOT EXISTS labs.lab_result (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  result_id text NOT NULL CHECK (result_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  order_id text NOT NULL CHECK (order_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  supersedes_result_id text CHECK (
    supersedes_result_id IS NULL OR supersedes_result_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'
  ),
  value_text text NOT NULL CHECK (char_length(value_text) BETWEEN 1 AND 200),
  critical boolean NOT NULL,
  recorded_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('electronic', 'manual', 'device')),
  provisional boolean NOT NULL,
  reconciliation text NOT NULL CHECK (
    reconciliation IN (
      'not-applicable',
      'pending',
      'matched',
      'conflict',
      'adjudicated-manual',
      'adjudicated-electronic'
    )
  ),
  read_back_by text CHECK (
    read_back_by IS NULL OR read_back_by ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'
  ),
  read_back_at timestamptz,
  read_back_value text CHECK (
    read_back_value IS NULL OR char_length(read_back_value) BETWEEN 1 AND 200
  ),
  observation_id text NOT NULL CHECK (observation_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  report_id text NOT NULL CHECK (report_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, result_id),
  UNIQUE (tenant_id, order_id, result_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES labs.lab_order (tenant_id, order_id),
  CONSTRAINT lab_result_not_self_supersede CHECK (
    supersedes_result_id IS NULL OR supersedes_result_id <> result_id
  ),
  CONSTRAINT lab_result_manual_read_back CHECK (
    source <> 'manual'
    OR (
      provisional
      AND read_back_by IS NOT NULL
      AND read_back_at IS NOT NULL
      AND read_back_value = value_text
    )
  ),
  CONSTRAINT lab_result_provisional_shape CHECK (
    (source = 'manual' AND provisional)
    OR (source IN ('electronic', 'device') AND provisional = (reconciliation = 'conflict'))
  )
);

CREATE TABLE IF NOT EXISTS labs.critical_closure (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  closure_id text NOT NULL CHECK (closure_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  order_id text NOT NULL CHECK (order_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  result_id text NOT NULL CHECK (result_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  phase text NOT NULL CHECK (phase IN ('paged', 'acknowledged', 'contacted', 'closed')),
  paged_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  acknowledged_by text CHECK (
    acknowledged_by IS NULL OR acknowledged_by ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'
  ),
  contacted_at timestamptz,
  contact_evidence text CHECK (
    contact_evidence IS NULL OR char_length(contact_evidence) BETWEEN 1 AND 200
  ),
  closed_at timestamptz,
  closed_by text CHECK (closed_by IS NULL OR closed_by ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  work_item_id text NOT NULL CHECK (work_item_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, closure_id),
  UNIQUE (tenant_id, result_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES labs.lab_order (tenant_id, order_id),
  FOREIGN KEY (tenant_id, result_id) REFERENCES labs.lab_result (tenant_id, result_id),
  CONSTRAINT critical_closure_steps CHECK (
    (
      phase = 'paged'
      AND acknowledged_at IS NULL
      AND contacted_at IS NULL
      AND closed_at IS NULL
    )
    OR (
      phase = 'acknowledged'
      AND acknowledged_at IS NOT NULL
      AND acknowledged_by IS NOT NULL
      AND contacted_at IS NULL
      AND closed_at IS NULL
    )
    OR (
      phase = 'contacted'
      AND acknowledged_at IS NOT NULL
      AND contacted_at IS NOT NULL
      AND contact_evidence IS NOT NULL
      AND closed_at IS NULL
    )
    OR (
      phase = 'closed'
      AND acknowledged_at IS NOT NULL
      AND contacted_at IS NOT NULL
      AND contact_evidence IS NOT NULL
      AND closed_at IS NOT NULL
      AND closed_by IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS labs.expected_result_age (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  order_id text NOT NULL CHECK (order_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  aged_at timestamptz NOT NULL,
  expected_result_by timestamptz NOT NULL,
  work_item_id text NOT NULL CHECK (work_item_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, order_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES labs.lab_order (tenant_id, order_id)
);

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE labs.critical_closure ENABLE ROW LEVEL SECURITY;
ALTER TABLE labs.critical_closure FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON labs.critical_closure;
CREATE POLICY tenant_isolation ON labs.critical_closure
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE labs.expected_result_age ENABLE ROW LEVEL SECURITY;
ALTER TABLE labs.expected_result_age FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON labs.expected_result_age;
CREATE POLICY tenant_isolation ON labs.expected_result_age
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE labs.lab_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE labs.lab_order FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON labs.lab_order;
CREATE POLICY tenant_isolation ON labs.lab_order
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE labs.lab_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE labs.lab_result FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON labs.lab_result;
CREATE POLICY tenant_isolation ON labs.lab_result
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
   WHERE n.nspname = 'labs'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('critical_closure', 'device_calibration', 'device_recall', 'expected_result_age', 'lab_order', 'lab_result'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema labs: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end

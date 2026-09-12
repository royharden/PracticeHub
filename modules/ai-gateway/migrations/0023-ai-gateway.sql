-- WP-100 synthetic-only AI gateway policy snapshots, exact-cohort containment,
-- and append-only refs/hashes evidence. Bodies remain in object storage.
CREATE SCHEMA IF NOT EXISTS ai_gateway;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_ai_gateway') THEN
    CREATE ROLE module_ai_gateway NOLOGIN;
  END IF;
END
$roles$;

GRANT module_ai_gateway TO practicehub_app;
GRANT USAGE ON SCHEMA ai_gateway TO module_ai_gateway;

CREATE TABLE IF NOT EXISTS ai_gateway.model_binding (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  use_case text NOT NULL CHECK (use_case ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  cohort_ref text NOT NULL CHECK (cohort_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  binding_ref text NOT NULL CHECK (binding_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  vendor_id text NOT NULL CHECK (vendor_id ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  model_ref text NOT NULL CHECK (model_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  pinned_model_version text NOT NULL CHECK (pinned_model_version ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  prompt_template_version text NOT NULL CHECK (prompt_template_version ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  system_policy_ref text NOT NULL CHECK (system_policy_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  version integer NOT NULL CHECK (version >= 1),
  mode text NOT NULL CHECK (mode = 'dev'),
  enabled boolean NOT NULL DEFAULT false,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, binding_ref),
  UNIQUE (tenant_id, use_case, cohort_ref, version)
);

CREATE TABLE IF NOT EXISTS ai_gateway.tool_grant (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  actor_ref text NOT NULL CHECK (actor_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  subject_ref text NOT NULL CHECK (subject_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  cohort_ref text NOT NULL CHECK (cohort_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  ai_system_ref text NOT NULL CHECK (ai_system_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  purpose text NOT NULL CHECK (purpose ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  version integer NOT NULL CHECK (version >= 1),
  allowed_tool_ids text[] NOT NULL DEFAULT '{}',
  allowed_argument_keys_by_tool jsonb NOT NULL DEFAULT '{}',
  required_argument_keys_by_tool jsonb NOT NULL DEFAULT '{}',
  allow_draft_side_effect boolean NOT NULL DEFAULT false,
  human_approval_required boolean NOT NULL CHECK (human_approval_required),
  enabled boolean NOT NULL DEFAULT false,
  environment text NOT NULL CHECK (environment = 'dev'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, actor_ref, subject_ref, cohort_ref, ai_system_ref, version),
  CONSTRAINT tool_grant_argument_maps_are_objects CHECK (
    jsonb_typeof(allowed_argument_keys_by_tool) = 'object'
    AND jsonb_typeof(required_argument_keys_by_tool) = 'object'
  )
);

CREATE TABLE IF NOT EXISTS ai_gateway.cohort_containment (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  use_case text NOT NULL CHECK (use_case ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  cohort_ref text NOT NULL CHECK (cohort_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  binding_ref text NOT NULL CHECK (binding_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  incident_ref text NOT NULL CHECK (incident_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  fallback_ref text NOT NULL CHECK (fallback_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  reason text NOT NULL CHECK (reason ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  contained_at timestamptz NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, use_case, cohort_ref, binding_ref)
);

CREATE TABLE IF NOT EXISTS ai_gateway.interaction (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  subject_ref text NOT NULL CHECK (subject_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  interaction_ref text NOT NULL CHECK (interaction_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  use_case text NOT NULL CHECK (use_case ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  cohort_ref text NOT NULL CHECK (cohort_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  actor_ref text NOT NULL CHECK (actor_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  purpose text NOT NULL CHECK (purpose ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  event_id text NOT NULL, audit_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  occurred_at timestamptz NOT NULL,
  model_ref text NOT NULL CHECK (model_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  model_version text NOT NULL CHECK (model_version ~ '^[A-Za-z0-9][A-Za-z0-9+._/-]{0,127}$'),
  model_version_hash text NOT NULL CHECK (model_version_hash ~ '^[0-9a-f]{64}$'),
  audit_model_version_ref text NOT NULL CHECK (audit_model_version_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  binding_version integer NOT NULL CHECK (binding_version >= 1),
  grant_version integer NOT NULL CHECK (grant_version >= 1),
  prompt_ref text NOT NULL CHECK (prompt_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  prompt_hash text NOT NULL CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  output_ref text NOT NULL CHECK (output_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  output_hash text NOT NULL CHECK (output_hash ~ '^[0-9a-f]{64}$'),
  tool_decision_ref text NOT NULL CHECK (tool_decision_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  tool_decision_hash text NOT NULL CHECK (tool_decision_hash ~ '^[0-9a-f]{64}$'),
  tool_decision_count integer NOT NULL CHECK (tool_decision_count >= 0),
  provider_receipt_ref text CHECK (provider_receipt_ref IS NULL OR provider_receipt_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  decision text NOT NULL CHECK (decision IN ('completed', 'blocked', 'stale', 'contained')),
  reason text NOT NULL CHECK (reason ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, interaction_ref),
  UNIQUE (tenant_id, event_id), UNIQUE (tenant_id, audit_id), UNIQUE (tenant_id, idempotency_key)
);

GRANT SELECT, INSERT, UPDATE ON ai_gateway.model_binding TO module_ai_gateway;
GRANT SELECT, INSERT, UPDATE ON ai_gateway.tool_grant TO module_ai_gateway;
GRANT SELECT, INSERT, UPDATE ON ai_gateway.cohort_containment TO module_ai_gateway;
GRANT SELECT, INSERT ON ai_gateway.interaction TO module_ai_gateway;
REVOKE DELETE ON ai_gateway.model_binding, ai_gateway.tool_grant, ai_gateway.cohort_containment FROM module_ai_gateway;
REVOKE UPDATE, DELETE ON ai_gateway.interaction FROM module_ai_gateway;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE ai_gateway.cohort_containment ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_gateway.cohort_containment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_gateway.cohort_containment;
CREATE POLICY tenant_isolation ON ai_gateway.cohort_containment
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE ai_gateway.interaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_gateway.interaction FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_gateway.interaction;
CREATE POLICY tenant_isolation ON ai_gateway.interaction
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE ai_gateway.model_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_gateway.model_binding FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_gateway.model_binding;
CREATE POLICY tenant_isolation ON ai_gateway.model_binding
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE ai_gateway.tool_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_gateway.tool_grant FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_gateway.tool_grant;
CREATE POLICY tenant_isolation ON ai_gateway.tool_grant
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
   WHERE n.nspname = 'ai_gateway'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('cohort_containment', 'interaction', 'model_binding', 'tool_grant'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema ai_gateway: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end

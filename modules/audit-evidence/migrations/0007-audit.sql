-- WP-020 audit-evidence migration (M04: append-only audit store, hash chain,
-- retention schedules, legal hold, destruction evidence). Contract:
-- docs/contracts/audit-emit.md (FROZEN). Architecture: ADR-008.
-- Idempotent: safe to re-apply; the DB suite re-applies it as its idempotency
-- proof. Rollback: modules/audit-evidence/migrations/0007-audit.rollback.sql.
-- Depends on modules/platform-core/migrations/0001-tenancy.sql (tenant table
-- + practicehub_app role); the migration runner orders module migrations by
-- file number across modules.
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('audit_evidence', auditEvidenceRlsSpecs,
-- auditEvidenceSchemaRlsSpecs); a drift test compares this file against a
-- fresh emission.

CREATE SCHEMA IF NOT EXISTS audit_evidence;

-- Module role pattern (ARCHITECTURE: no cross-module table writes, DB-role
-- enforced): audit_evidence-schema access grants only through
-- module_audit_evidence; practicehub_app (created by 0001-tenancy.sql)
-- receives the module role and owns nothing.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_audit_evidence') THEN
    CREATE ROLE module_audit_evidence NOLOGIN;
  END IF;
END
$roles$;

GRANT module_audit_evidence TO practicehub_app;
GRANT USAGE ON SCHEMA audit_evidence TO module_audit_evidence;

-- The audit store (R6-REQ-001): one append-only table, eight streams, hash
-- chain per tenant-day. Structural rules, enforced by CHECK rather than
-- review memory:
--   * per-stream completeness mirrors the contract table — an access record
--     without subject/decision/reason, or an AI interaction without model +
--     version and prompt/output ref+hash pairs (R6-REQ-102), is
--     unrepresentable;
--   * chain link 1 carries prev_hash 'genesis', later links carry a sha-256;
--   * payload fields are refs and hashes; free text has no column.
-- Domain events are NOT audit (ADR-008 Decision 2): subject/correlation refs
-- are soft references, never cross-module FKs — the store must record
-- subjects and denials that exist in no other table.
CREATE TABLE IF NOT EXISTS audit_evidence.audit_event (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  audit_id text NOT NULL CHECK (audit_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  stream text NOT NULL CHECK (
    stream IN ('access', 'disclosure', 'break-glass', 'ai-interaction', 'config-change',
               'consent-event', 'authority-decision', 'capability-transition')
  ),
  action text NOT NULL CHECK (action ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  actor_ref text NOT NULL CHECK (actor_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  subject_ref text CHECK (subject_ref IS NULL OR subject_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  decision text CHECK (decision IN ('allow', 'deny')),
  reason text CHECK (
    reason IN ('treatment', 'payment', 'operations', 'patient-request',
               'break-glass-emergency', 'investigation', 'legal-obligation',
               'system-maintenance')
  ),
  source_ref text,
  correlation_ref text,
  recipient_ref text,
  purpose text,
  model_ref text,
  model_version text,
  prompt_ref text,
  prompt_hash text CHECK (prompt_hash IS NULL OR prompt_hash ~ '^[0-9a-f]{64}$'),
  output_ref text,
  output_hash text CHECK (output_hash IS NULL OR output_hash ~ '^[0-9a-f]{64}$'),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  partition_tags text[] NOT NULL DEFAULT '{}' CHECK (
    partition_tags <@ ARRAY['gipa-genetic', 'chd', 'biometric', 'part2']::text[]
  ),
  chain_day date NOT NULL,
  chain_seq integer NOT NULL CHECK (chain_seq >= 1),
  prev_hash text NOT NULL CHECK (prev_hash = 'genesis' OR prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash text NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, audit_id),
  CONSTRAINT audit_event_chain_position UNIQUE (tenant_id, chain_day, chain_seq),
  CONSTRAINT audit_event_genesis_only_first CHECK (
    (chain_seq = 1) = (prev_hash = 'genesis')
  ),
  CONSTRAINT audit_event_access_complete CHECK (
    stream <> 'access'
    OR (subject_ref IS NOT NULL AND decision IS NOT NULL AND reason IS NOT NULL)
  ),
  CONSTRAINT audit_event_disclosure_complete CHECK (
    stream <> 'disclosure'
    OR (decision IS NOT NULL AND recipient_ref IS NOT NULL AND purpose IS NOT NULL)
  ),
  CONSTRAINT audit_event_break_glass_reasoned CHECK (
    stream <> 'break-glass' OR (subject_ref IS NOT NULL AND reason IS NOT NULL)
  ),
  CONSTRAINT audit_event_ai_interaction_complete CHECK (
    stream <> 'ai-interaction'
    OR (subject_ref IS NOT NULL AND model_ref IS NOT NULL AND model_version IS NOT NULL
        AND prompt_ref IS NOT NULL AND prompt_hash IS NOT NULL
        AND output_ref IS NOT NULL AND output_hash IS NOT NULL)
  ),
  CONSTRAINT audit_event_config_change_ref CHECK (
    stream <> 'config-change' OR detail ? 'config_ref'
  ),
  CONSTRAINT audit_event_consent_pointer CHECK (
    stream <> 'consent-event' OR correlation_ref IS NOT NULL
  ),
  CONSTRAINT audit_event_authority_decision_complete CHECK (
    stream <> 'authority-decision'
    OR (decision IS NOT NULL AND detail ? 'capability_id' AND detail ? 'grant_state'
        AND detail ? 'checkpoint')
  ),
  CONSTRAINT audit_event_capability_transition_pointer CHECK (
    stream <> 'capability-transition' OR correlation_ref IS NOT NULL
  )
);

-- Retention schedules (R6-SR-080, R6-REQ-052): counsel-owned reference data,
-- one entry per record class per version. Runtime-read-only (REVOKE below):
-- schedule changes are a counsel data-change, never an application write.
CREATE TABLE IF NOT EXISTS audit_evidence.retention_schedule (
  record_class text NOT NULL CHECK (
    record_class IN ('clinical-record', 'consent-artifact', 'audit-log', 'ai-interaction',
                     'gfe-record', 'disclosure-accounting')
  ),
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('draft', 'counsel-signed')),
  basis text NOT NULL CHECK (basis IN ('jurisdiction-resolver', 'fixed-term')),
  fixed_term_years integer CHECK (fixed_term_years IS NULL OR fixed_term_years >= 1),
  minimum_years integer NOT NULL CHECK (minimum_years >= 1),
  minors_extension text NOT NULL CHECK (
    minors_extension IN ('age-of-majority-anchor', 'none')
  ),
  age_of_majority_years integer NOT NULL CHECK (age_of_majority_years >= 18),
  basis_ref text NOT NULL CHECK (basis_ref <> ''),
  change_control_ref text NOT NULL CHECK (change_control_ref <> ''),
  synthetic boolean NOT NULL,
  PRIMARY KEY (record_class, version),
  CONSTRAINT retention_schedule_fixed_term_carries_years CHECK (
    basis <> 'fixed-term' OR fixed_term_years IS NOT NULL
  )
);

-- Legal hold (contract decision 8): first-class row at (tenant,
-- legal-entity?, matter) scope, optionally narrowed to record classes.
-- Release carries released-by + evidence by CHECK; holds release, they are
-- never deleted (REVOKE below).
CREATE TABLE IF NOT EXISTS audit_evidence.legal_hold (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  hold_id text NOT NULL CHECK (hold_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  matter_ref text NOT NULL CHECK (matter_ref <> ''),
  legal_entity_id text,
  record_classes text[] NOT NULL DEFAULT '{}' CHECK (
    record_classes <@ ARRAY['clinical-record', 'consent-artifact', 'audit-log',
                            'ai-interaction', 'gfe-record', 'disclosure-accounting']::text[]
  ),
  status text NOT NULL CHECK (status IN ('active', 'released')),
  placed_by text NOT NULL CHECK (placed_by <> ''),
  placed_basis_ref text NOT NULL CHECK (placed_basis_ref <> ''),
  released_by text,
  release_evidence_ref text,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, hold_id),
  CONSTRAINT legal_hold_release_carries_evidence CHECK (
    status <> 'released' OR (released_by IS NOT NULL AND release_evidence_ref IS NOT NULL)
  ),
  CONSTRAINT legal_hold_active_carries_no_release CHECK (
    status <> 'active' OR (released_by IS NULL AND release_evidence_ref IS NULL)
  ),
  CONSTRAINT legal_hold_entity_same_tenant
    FOREIGN KEY (tenant_id, legal_entity_id)
    REFERENCES platform_core.legal_entity (tenant_id, legal_entity_id)
);

-- Destruction evidence (ADR-008 Decision 4): what, why, authority, manifest
-- hash — append-only, referencing its audit record in the same tenant.
CREATE TABLE IF NOT EXISTS audit_evidence.destruction_evidence (
  tenant_id text NOT NULL,
  destruction_id text NOT NULL CHECK (destruction_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  record_class text NOT NULL CHECK (
    record_class IN ('clinical-record', 'consent-artifact', 'audit-log', 'ai-interaction',
                     'gfe-record', 'disclosure-accounting')
  ),
  record_refs text[] NOT NULL CHECK (cardinality(record_refs) > 0),
  why_basis_refs text[] NOT NULL CHECK (cardinality(why_basis_refs) > 0),
  authority_ref text NOT NULL CHECK (authority_ref <> ''),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  audit_id text NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, destruction_id),
  CONSTRAINT destruction_evidence_audit_same_tenant
    FOREIGN KEY (tenant_id, audit_id)
    REFERENCES audit_evidence.audit_event (tenant_id, audit_id)
);

-- Deterministic grants for this migration's tables.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON audit_evidence.audit_event, audit_evidence.legal_hold,
     audit_evidence.destruction_evidence
  TO module_audit_evidence;
GRANT SELECT ON audit_evidence.retention_schedule TO module_audit_evidence;

-- Append-only postures (R6-REQ-001: the log cannot be edited or deleted by
-- any app role). Holds are never deleted — they release. The retention
-- registry is runtime-read-only. Re-asserted on every pass.
REVOKE UPDATE, DELETE ON audit_evidence.audit_event FROM module_audit_evidence;
REVOKE UPDATE, DELETE ON audit_evidence.destruction_evidence FROM module_audit_evidence;
REVOKE DELETE ON audit_evidence.legal_hold FROM module_audit_evidence;
REVOKE INSERT, UPDATE, DELETE ON audit_evidence.retention_schedule FROM module_audit_evidence;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE audit_evidence.audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_evidence.audit_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_evidence.audit_event;
CREATE POLICY tenant_isolation ON audit_evidence.audit_event
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE audit_evidence.destruction_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_evidence.destruction_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_evidence.destruction_evidence;
CREATE POLICY tenant_isolation ON audit_evidence.destruction_evidence
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE audit_evidence.legal_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_evidence.legal_hold FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_evidence.legal_hold;
CREATE POLICY tenant_isolation ON audit_evidence.legal_hold
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE audit_evidence.retention_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_evidence.retention_schedule FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_evidence.retention_schedule;
-- platform-global: Counsel-owned retention reference data; clocks are tenant-independent statutory content (ADR-008 Decision 4, R6-SR-080)
CREATE POLICY tenant_isolation ON audit_evidence.retention_schedule
  USING (true)
  WITH CHECK (true);

DO $coverage$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO offender
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'audit_evidence'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('audit_event', 'destruction_evidence', 'legal_hold', 'retention_schedule'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema audit_evidence: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end

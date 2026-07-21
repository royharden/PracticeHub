-- WP-015 PDP migration (M02: role templates/assignments/overrides,
-- proxy/guardian authority records, deceased person flags, GIPA partition
-- tags + authorizations). Contract: docs/contracts/pdp-api.md (FROZEN).
-- Executes the REQ-ID-018 versioned-template model, the REQ-ID-006..014
-- authority record, the REQ-ID-021 flag stream, and the REQ-ID-019
-- partition registry as STRUCTURE â€” CHECKs, not review memory.
-- Idempotent: safe to re-apply; the DB suite re-applies it as its
-- idempotency proof. Rollback: modules/identity/migrations/0008-pdp.rollback.sql.
-- Depends on modules/identity/migrations/0004-identity.sql (identity schema,
-- module_identity role, person/staff tables); the migration runner orders
-- module migrations by file number across modules.
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('identity', pdpRlsSpecs, identitySchemaRlsSpecs);
-- a drift test compares this file against a fresh emission.

-- Role templates (REQ-ID-018 AC-1/AC-6/AC-9): the MINIMUM segment x action
-- set per canonical role, versioned. Rows are immutable per version â€” the
-- UPDATE grant below covers ONLY the status column (supersede), DELETE is
-- revoked â€” so "who changed what and why" is a new attributed version, never
-- an in-place rewrite.
CREATE TABLE IF NOT EXISTS identity.role_template (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  role_key text NOT NULL CHECK (
    role_key IN ('front-desk', 'ma-nurse', 'physician-app', 'biller-coder',
                 'practice-manager', 'it-security-admin', 'compliance-privacy-officer',
                 'employer-sponsor-admin')
  ),
  version integer NOT NULL CHECK (version >= 1),
  permits jsonb NOT NULL CHECK (jsonb_typeof(permits) = 'array'),
  status text NOT NULL CHECK (status IN ('active', 'superseded')),
  changed_by text NOT NULL CHECK (changed_by <> ''),
  change_reason text NOT NULL CHECK (change_reason <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, role_key, version)
);

-- Role assignments (REQ-ID-018 AC-7 / EX-4): the template reference IS the
-- permit set; an ended assignment carries who ended it and why.
CREATE TABLE IF NOT EXISTS identity.role_assignment (
  tenant_id text NOT NULL,
  assignment_id text NOT NULL CHECK (assignment_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  staff_account_id text NOT NULL,
  staff_person_id text NOT NULL,
  role_key text NOT NULL,
  template_version integer NOT NULL,
  location_scope text[] NOT NULL DEFAULT '{}',
  effective_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'ended')),
  ended_reason text,
  ended_by text,
  assigned_by text NOT NULL CHECK (assigned_by <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, assignment_id),
  CONSTRAINT role_assignment_ended_attributed CHECK (
    status <> 'ended' OR (ended_reason IS NOT NULL AND ended_by IS NOT NULL)
  ),
  CONSTRAINT role_assignment_template_same_tenant
    FOREIGN KEY (tenant_id, role_key, template_version)
    REFERENCES identity.role_template (tenant_id, role_key, version),
  CONSTRAINT role_assignment_staff_same_tenant
    FOREIGN KEY (tenant_id, staff_account_id)
    REFERENCES identity.staff_account (tenant_id, staff_account_id),
  CONSTRAINT role_assignment_person_same_tenant
    FOREIGN KEY (tenant_id, staff_person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- Beyond-template overrides (REQ-ID-018 AC-8 / EX-2): justified, approved,
-- TIME-BOXED, always review-flagged â€” and structurally never the genetic
-- segment (REQ-ID-019 AC-5/EX-3: no override escape hatch for the partition).
CREATE TABLE IF NOT EXISTS identity.access_override (
  tenant_id text NOT NULL,
  override_id text NOT NULL CHECK (override_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  staff_account_id text NOT NULL,
  segment text NOT NULL CHECK (
    segment IN ('demographics', 'scheduling', 'messaging', 'statements', 'payment-methods',
                'clinical-notes', 'results', 'medications', 'documents',
                'confidential-adolescent')
  ),
  actions text[] NOT NULL CHECK (
    cardinality(actions) >= 1 AND actions <@ ARRAY['view', 'edit', 'export']::text[]
  ),
  justification text NOT NULL CHECK (justification <> ''),
  approved_by text NOT NULL CHECK (approved_by <> ''),
  expires_on date NOT NULL,
  flagged_for_review boolean NOT NULL CHECK (flagged_for_review),
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, override_id),
  CONSTRAINT access_override_staff_same_tenant
    FOREIGN KEY (tenant_id, staff_account_id)
    REFERENCES identity.staff_account (tenant_id, staff_account_id)
);

-- Proxy/guardian authority records (REQ-ID-006..014): versioned, evidenced,
-- kind-scoped. Emancipation is the ONLY self-directed kind; time-limited
-- kinds expire by construction; an active incapacity authority carries its
-- triggering determination â€” an assertion alone is unrepresentable.
CREATE TABLE IF NOT EXISTS identity.authority_record (
  tenant_id text NOT NULL,
  authority_id text NOT NULL CHECK (authority_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  version integer NOT NULL CHECK (version >= 1),
  kind text NOT NULL CHECK (
    kind IN ('guardian-minor', 'caregiver-grant', 'court-order-guardian',
             'temporary-guardianship', 'emancipation', 'incapacity-contingent')
  ),
  grantee_person_id text NOT NULL,
  subject_person_id text NOT NULL,
  scope jsonb NOT NULL CHECK (
    jsonb_typeof(scope) = 'array' AND jsonb_array_length(scope) >= 1
  ),
  jurisdiction text,
  evidence_ref text NOT NULL CHECK (evidence_ref <> ''),
  triggering_evidence_ref text,
  written_consent_ref text,
  consent_captured_on date,
  confidential_access_basis_ref text,
  effective_date date NOT NULL,
  expires_on date,
  renewal_owner_ref text,
  verified_by text,
  status text NOT NULL CHECK (
    status IN ('pending-verification', 'active', 'held-conflict', 'suspended-majority',
               'expired', 'ended', 'superseded', 'blocked')
  ),
  supersedes_version integer,
  ended_reason text,
  decided_by text NOT NULL CHECK (decided_by <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, authority_id, version),
  CONSTRAINT authority_emancipation_only_self CHECK (
    (kind = 'emancipation') = (grantee_person_id = subject_person_id)
  ),
  CONSTRAINT authority_time_limited_kinds_expire CHECK (
    kind NOT IN ('temporary-guardianship', 'incapacity-contingent') OR expires_on IS NOT NULL
  ),
  CONSTRAINT authority_temporary_names_renewal_owner CHECK (
    kind <> 'temporary-guardianship' OR renewal_owner_ref IS NOT NULL
  ),
  CONSTRAINT authority_incapacity_active_carries_trigger CHECK (
    NOT (kind = 'incapacity-contingent' AND status = 'active')
    OR triggering_evidence_ref IS NOT NULL
  ),
  CONSTRAINT authority_active_carries_verifier CHECK (
    status <> 'active' OR verified_by IS NOT NULL
  ),
  CONSTRAINT authority_ended_carries_reason CHECK (
    status NOT IN ('ended', 'superseded') OR ended_reason IS NOT NULL
  ),
  CONSTRAINT authority_supersedes_earlier_version CHECK (
    supersedes_version IS NULL OR supersedes_version < version
  ),
  CONSTRAINT authority_grantee_same_tenant
    FOREIGN KEY (tenant_id, grantee_person_id)
    REFERENCES identity.person (tenant_id, person_id),
  CONSTRAINT authority_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- Deceased person flags (REQ-ID-021, lock half): an append-only event
-- stream (REVOKE below). Setting records the confirmation source; a
-- correction is DOCUMENTED evidence, never a toggle-back.
CREATE TABLE IF NOT EXISTS identity.person_flag (
  tenant_id text NOT NULL,
  flag_id text NOT NULL CHECK (flag_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  person_id text NOT NULL,
  kind text NOT NULL CHECK (kind = 'deceased'),
  action text NOT NULL CHECK (action IN ('set', 'corrected')),
  source_ref text,
  correction_evidence_ref text,
  actor_ref text NOT NULL CHECK (actor_ref <> ''),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, flag_id),
  CONSTRAINT person_flag_set_carries_source CHECK (
    action <> 'set' OR source_ref IS NOT NULL
  ),
  CONSTRAINT person_flag_correction_carries_evidence CHECK (
    action <> 'corrected' OR correction_evidence_ref IS NOT NULL
  ),
  CONSTRAINT person_flag_person_same_tenant
    FOREIGN KEY (tenant_id, person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- GIPA partition tags (REQ-ID-019 AC-1/AC-4/EX-1): genetic-classed
-- artifacts registered per ingestion path. Unreliable classification
-- quarantines â€” needs-review rows are blocked from release BY CHECK.
CREATE TABLE IF NOT EXISTS identity.partition_tag (
  tenant_id text NOT NULL,
  tag_id text NOT NULL CHECK (tag_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  subject_person_id text NOT NULL,
  artifact_ref text NOT NULL CHECK (artifact_ref <> ''),
  tag text NOT NULL CHECK (tag IN ('gipa-genetic', 'chd', 'part2', 'biometric')),
  ingest_path text NOT NULL CHECK (
    ingest_path IN ('manual-entry', 'migration-workbench', 'lab-interface', 'pa-payload')
  ),
  review_status text NOT NULL CHECK (
    review_status IN ('auto-confirmed', 'manually-confirmed', 'needs-classification-review')
  ),
  blocked_from_release boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, tag_id),
  CONSTRAINT partition_tag_needs_review_blocks_release CHECK (
    review_status <> 'needs-classification-review' OR blocked_from_release
  ),
  CONSTRAINT partition_tag_person_same_tenant
    FOREIGN KEY (tenant_id, subject_person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- GIPA disclosure authorizations (REQ-ID-019 AC-3/EX-2/EX-4): specific,
-- DATED, WRITTEN, and EXPIRING by construction; revoked, never deleted.
CREATE TABLE IF NOT EXISTS identity.gipa_authorization (
  tenant_id text NOT NULL,
  authorization_id text NOT NULL CHECK (authorization_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  subject_person_id text NOT NULL,
  scope_ref text NOT NULL CHECK (scope_ref <> ''),
  granted_on date NOT NULL,
  expires_on date NOT NULL,
  written_evidence_ref text NOT NULL CHECK (written_evidence_ref <> ''),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, authorization_id),
  CONSTRAINT gipa_authorization_person_same_tenant
    FOREIGN KEY (tenant_id, subject_person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- Deterministic grants for this migration's tables (0004's ALTER DEFAULT
-- PRIVILEGES already grants on newly created tables; re-asserting keeps the
-- posture explicit and idempotent).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON identity.role_template, identity.role_assignment, identity.access_override,
     identity.authority_record, identity.person_flag, identity.partition_tag,
     identity.gipa_authorization
  TO module_identity;

-- Structural postures, re-asserted on every pass (0002 pattern), and
-- re-asserted conditionally by 0004/0005 whose schema-wide GRANT would
-- otherwise re-open them on cross-re-apply:
--   * person_flag is append-only history;
--   * role_template versions are immutable except supersession (status);
--   * assignments/overrides/authority/tags/authorizations end or revoke,
--     they never vanish.
REVOKE UPDATE, DELETE ON identity.person_flag FROM module_identity;
REVOKE UPDATE, DELETE ON identity.role_template FROM module_identity;
GRANT UPDATE (status) ON identity.role_template TO module_identity;
REVOKE DELETE ON identity.role_assignment FROM module_identity;
REVOKE DELETE ON identity.access_override FROM module_identity;
REVOKE DELETE ON identity.authority_record FROM module_identity;
REVOKE DELETE ON identity.partition_tag FROM module_identity;
REVOKE DELETE ON identity.gipa_authorization FROM module_identity;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE identity.access_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.access_override FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.access_override;
CREATE POLICY tenant_isolation ON identity.access_override
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.authority_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.authority_record FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.authority_record;
CREATE POLICY tenant_isolation ON identity.authority_record
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.gipa_authorization ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.gipa_authorization FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.gipa_authorization;
CREATE POLICY tenant_isolation ON identity.gipa_authorization
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.partition_tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.partition_tag FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.partition_tag;
CREATE POLICY tenant_isolation ON identity.partition_tag
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.person_flag ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.person_flag FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.person_flag;
CREATE POLICY tenant_isolation ON identity.person_flag
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.role_assignment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.role_assignment;
CREATE POLICY tenant_isolation ON identity.role_assignment
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.role_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.role_template FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.role_template;
CREATE POLICY tenant_isolation ON identity.role_template
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
   WHERE n.nspname = 'identity'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('access_override', 'account_lockdown', 'auth_challenge', 'auth_credential', 'auth_device', 'auth_session', 'authority_record', 'channel_endpoint', 'endpoint_association', 'gipa_authorization', 'guarantor_role', 'identity_timeline', 'merge_case', 'merge_case_person', 'merge_event', 'merge_lineage', 'partition_tag', 'patient_record', 'person', 'person_flag', 'person_name', 'proxy_grant', 'role_assignment', 'role_template', 'source_identifier', 'staff_account'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema identity: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end

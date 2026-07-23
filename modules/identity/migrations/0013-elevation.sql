-- WP-017 elevation migration (M02: break-glass grants + mandatory reviews,
-- staff offboarding cases + reassignments, access-anomaly investigations,
-- access-recertification attestations). Contract:
-- docs/contracts/elevation-api.md (FROZEN). Executes REQ-ID-001/002/025/028 +
-- REQ-ADM-017/018/019 as STRUCTURE — CHECKs, not review memory: a break-glass
-- grant is read-only and auto-expiring by construction, a review is
-- independent by CHECK, an abrupt departure revokes the EPCS token by CHECK,
-- and every forensic signal set is non-empty by CHECK.
-- Idempotent: safe to re-apply; the DB suite re-applies it as its idempotency
-- proof. Rollback: modules/identity/migrations/0013-elevation.rollback.sql.
-- Depends on modules/identity/migrations/0004-identity.sql (identity schema,
-- module_identity role, person/staff tables); the migration runner orders
-- module migrations by file number across modules.
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('identity', elevationRlsSpecs, identitySchemaRlsSpecs);
-- a drift test compares this file against a fresh emission.

-- Break-glass grants (REQ-ID-001 AC / REQ-ADM-017): a TIME-LIMITED, SCOPED,
-- READ-ONLY emergency elevation with a NAMED REASON captured at time of use
-- (R6-REQ-003) and AUTO-EXPIRY. `scope` is an array of segments to READ —
-- there is no action column, so a write elevation is unrepresentable
-- (ADR-006 Decision 3: break-glass widens read scope only). Append-only: the
-- reason capture is evidence and is never rewritten or deleted (REVOKE below).
CREATE TABLE IF NOT EXISTS identity.break_glass_grant (
  tenant_id text NOT NULL,
  grant_id text NOT NULL CHECK (grant_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  staff_account_id text NOT NULL,
  accessor_person_id text NOT NULL,
  subject_person_id text NOT NULL,
  scope jsonb NOT NULL CHECK (
    jsonb_typeof(scope) = 'array' AND jsonb_array_length(scope) >= 1
  ),
  reason_code text NOT NULL CHECK (
    reason_code IN ('emergency-care', 'patient-safety', 'coverage-gap',
                    'disaster-continuity', 'urgent-records-request')
  ),
  justification_ref text NOT NULL CHECK (justification_ref <> ''),
  severity text NOT NULL CHECK (severity IN ('standard', 'elevated-genetic')),
  initiated_by text NOT NULL CHECK (initiated_by <> ''),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  review_due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, grant_id),
  CONSTRAINT break_glass_auto_expires CHECK (expires_at > effective_at),
  CONSTRAINT break_glass_review_after_expiry CHECK (review_due_at >= expires_at),
  CONSTRAINT break_glass_grant_staff_same_tenant
    FOREIGN KEY (tenant_id, staff_account_id)
    REFERENCES identity.staff_account (tenant_id, staff_account_id),
  CONSTRAINT break_glass_grant_accessor_same_tenant
    FOREIGN KEY (tenant_id, accessor_person_id)
    REFERENCES identity.person (tenant_id, person_id),
  CONSTRAINT break_glass_grant_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- Break-glass mandatory reviews (REQ-ID-001 AC / R6-REQ-003): the
-- after-the-fact review is INDEPENDENT — the reviewer can never be the accessor
-- who used the elevation (separation of duties BY CHECK), evidence is
-- mandatory, and there is exactly one review per grant. Append-only evidence.
CREATE TABLE IF NOT EXISTS identity.break_glass_review (
  tenant_id text NOT NULL,
  review_id text NOT NULL CHECK (review_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  grant_id text NOT NULL,
  subject_person_id text NOT NULL,
  accessor_person_id text NOT NULL,
  reviewer_person_id text NOT NULL,
  reviewer_role text NOT NULL CHECK (
    reviewer_role IN ('compliance-privacy-officer', 'it-security-admin')
  ),
  outcome text NOT NULL CHECK (
    outcome IN ('access-appropriate', 'access-inappropriate-escalate')
  ),
  evidence_ref text NOT NULL CHECK (evidence_ref <> ''),
  reviewed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, review_id),
  CONSTRAINT break_glass_review_one_per_grant UNIQUE (tenant_id, grant_id),
  CONSTRAINT break_glass_review_independent CHECK (reviewer_person_id <> accessor_person_id),
  CONSTRAINT break_glass_review_grant_same_tenant
    FOREIGN KEY (tenant_id, grant_id)
    REFERENCES identity.break_glass_grant (tenant_id, grant_id),
  CONSTRAINT break_glass_review_reviewer_same_tenant
    FOREIGN KEY (tenant_id, reviewer_person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- Offboarding cases (REQ-ID-025 / REQ-ID-028): the atomic offboarding
-- execution record. An abrupt provider departure MUST revoke sessions,
-- credentials, AND the EPCS token by CHECK (REQ-ID-028); a planned offboarding
-- MUST revoke sessions and role grants. Append-only evidence.
CREATE TABLE IF NOT EXISTS identity.offboarding_case (
  tenant_id text NOT NULL,
  offboarding_id text NOT NULL CHECK (offboarding_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  staff_account_id text NOT NULL,
  staff_person_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('planned', 'abrupt-departure')),
  reason_ref text NOT NULL CHECK (reason_ref <> ''),
  revoked_scopes text[] NOT NULL CHECK (
    cardinality(revoked_scopes) >= 1
    AND revoked_scopes <@ ARRAY['sessions', 'credentials', 'role-grants',
                                'epcs-token', 'device-tokens', 'on-call-slots']::text[]
  ),
  evidence_ref text NOT NULL CHECK (evidence_ref <> ''),
  executed_by text NOT NULL CHECK (executed_by <> ''),
  executed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, offboarding_id),
  CONSTRAINT offboarding_abrupt_revokes_epcs CHECK (
    kind <> 'abrupt-departure'
    OR revoked_scopes @> ARRAY['sessions', 'credentials', 'epcs-token']::text[]
  ),
  CONSTRAINT offboarding_planned_revokes_grants CHECK (
    kind <> 'planned'
    OR revoked_scopes @> ARRAY['sessions', 'role-grants']::text[]
  ),
  CONSTRAINT offboarding_case_staff_same_tenant
    FOREIGN KEY (tenant_id, staff_account_id)
    REFERENCES identity.staff_account (tenant_id, staff_account_id),
  CONSTRAINT offboarding_case_person_same_tenant
    FOREIGN KEY (tenant_id, staff_person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- Offboarding reassignments (REQ-ID-025): one row per owned work item / on-call
-- slot / panel handed off, each carrying a context package BY CHECK
-- (REQ-TASK-029 discipline). The zero-orphaned invariant is enforced in the
-- domain (every owned item gets a row or the offboarding fails); this table is
-- the append-only evidence of the handoff.
CREATE TABLE IF NOT EXISTS identity.offboarding_reassignment (
  tenant_id text NOT NULL,
  reassignment_id text NOT NULL CHECK (reassignment_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  offboarding_id text NOT NULL,
  owned_ref text NOT NULL CHECK (owned_ref <> ''),
  owned_kind text NOT NULL CHECK (owned_kind IN ('thread', 'on-call-slot', 'panel', 'task')),
  to_owner_ref text NOT NULL CHECK (to_owner_ref <> ''),
  context_package_ref text NOT NULL CHECK (context_package_ref <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, reassignment_id),
  CONSTRAINT offboarding_reassignment_one_per_item UNIQUE (tenant_id, offboarding_id, owned_ref),
  CONSTRAINT offboarding_reassignment_case_same_tenant
    FOREIGN KEY (tenant_id, offboarding_id)
    REFERENCES identity.offboarding_case (tenant_id, offboarding_id)
);

-- Access-anomaly investigations (REQ-ID-002 / REQ-ADM-019): a detected
-- credential-sharing / concurrent-session / snooping pattern opens a case with
-- the triggering signals recorded VERBATIM (forensic, non-empty BY CHECK).
-- Resolution advances status with a disposition, evidence, and attribution
-- (all present when resolved BY CHECK). DELETE is revoked — a case is evidence
-- and never vanishes (access_override precedent: resolution UPDATEs; the record
-- is retained).
CREATE TABLE IF NOT EXISTS identity.access_anomaly_case (
  tenant_id text NOT NULL,
  anomaly_id text NOT NULL CHECK (anomaly_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  pattern text NOT NULL CHECK (
    pattern IN ('credential-sharing', 'concurrent-session', 'snooping-access')
  ),
  subject_staff_person_id text NOT NULL,
  signals jsonb NOT NULL CHECK (
    jsonb_typeof(signals) = 'array' AND jsonb_array_length(signals) >= 1
  ),
  detected_at timestamptz NOT NULL,
  status text NOT NULL CHECK (
    status IN ('open', 'contained', 'remediated', 'false-positive')
  ),
  containment_ref text,
  disposition text CHECK (
    disposition IS NULL
    OR disposition IN ('confirmed-violation', 'policy-clarification', 'no-violation')
  ),
  remediation_evidence_ref text,
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, anomaly_id),
  CONSTRAINT access_anomaly_resolved_carries_disposition CHECK (
    status NOT IN ('remediated', 'false-positive')
    OR (disposition IS NOT NULL AND remediation_evidence_ref IS NOT NULL AND resolved_by IS NOT NULL)
  ),
  CONSTRAINT access_anomaly_case_person_same_tenant
    FOREIGN KEY (tenant_id, subject_staff_person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- Access-recertification attestations (REQ-ADM-018): one row per grant a
-- manager attested during a periodic recertification cycle — who attested,
-- their role, confirm/revoke, and the evidence. Append-only evidence of the
-- review workflow (the EVALUATION substrate is WP-015 runAccessReview).
CREATE TABLE IF NOT EXISTS identity.access_recertification (
  tenant_id text NOT NULL,
  attestation_id text NOT NULL CHECK (attestation_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  cycle_ref text NOT NULL CHECK (cycle_ref <> ''),
  staff_account_id text NOT NULL,
  grant_ref text NOT NULL CHECK (grant_ref <> ''),
  attester_person_id text NOT NULL CHECK (attester_person_id <> ''),
  attester_role text NOT NULL CHECK (
    attester_role IN ('practice-manager', 'compliance-privacy-officer', 'it-security-admin')
  ),
  decision text NOT NULL CHECK (decision IN ('confirmed', 'revoked')),
  evidence_ref text NOT NULL CHECK (evidence_ref <> ''),
  attested_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, attestation_id),
  CONSTRAINT access_recertification_staff_same_tenant
    FOREIGN KEY (tenant_id, staff_account_id)
    REFERENCES identity.staff_account (tenant_id, staff_account_id)
);

-- Deterministic grants for this migration's tables (0004's ALTER DEFAULT
-- PRIVILEGES already grants on newly created tables; re-asserting keeps the
-- posture explicit and idempotent).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON identity.break_glass_grant, identity.break_glass_review,
     identity.offboarding_case, identity.offboarding_reassignment,
     identity.access_anomaly_case, identity.access_recertification
  TO module_identity;

-- Structural postures, re-asserted on every pass (0002 pattern), and
-- re-asserted conditionally by 0004/0005 whose schema-wide GRANT would
-- otherwise re-open them on cross-re-apply:
--   * break-glass grants/reviews, offboarding cases/reassignments, and
--     recertification attestations are append-only evidence;
--   * anomaly cases end/resolve (UPDATE) but never vanish (DELETE revoked).
REVOKE UPDATE, DELETE ON identity.break_glass_grant FROM module_identity;
REVOKE UPDATE, DELETE ON identity.break_glass_review FROM module_identity;
REVOKE UPDATE, DELETE ON identity.offboarding_case FROM module_identity;
REVOKE UPDATE, DELETE ON identity.offboarding_reassignment FROM module_identity;
REVOKE UPDATE, DELETE ON identity.access_recertification FROM module_identity;
REVOKE DELETE ON identity.access_anomaly_case FROM module_identity;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE identity.access_anomaly_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.access_anomaly_case FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.access_anomaly_case;
CREATE POLICY tenant_isolation ON identity.access_anomaly_case
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.access_recertification ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.access_recertification FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.access_recertification;
CREATE POLICY tenant_isolation ON identity.access_recertification
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.break_glass_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.break_glass_grant FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.break_glass_grant;
CREATE POLICY tenant_isolation ON identity.break_glass_grant
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.break_glass_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.break_glass_review FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.break_glass_review;
CREATE POLICY tenant_isolation ON identity.break_glass_review
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.offboarding_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.offboarding_case FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.offboarding_case;
CREATE POLICY tenant_isolation ON identity.offboarding_case
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.offboarding_reassignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.offboarding_reassignment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.offboarding_reassignment;
CREATE POLICY tenant_isolation ON identity.offboarding_reassignment
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
          OR c.relname NOT IN ('access_anomaly_case', 'access_override', 'access_recertification', 'account_lockdown', 'auth_challenge', 'auth_credential', 'auth_device', 'auth_session', 'authority_record', 'break_glass_grant', 'break_glass_review', 'channel_endpoint', 'endpoint_association', 'gipa_authorization', 'guarantor_role', 'identity_timeline', 'merge_case', 'merge_case_person', 'merge_event', 'merge_lineage', 'offboarding_case', 'offboarding_reassignment', 'partition_tag', 'patient_record', 'person', 'person_flag', 'person_name', 'proxy_grant', 'role_assignment', 'role_template', 'source_identifier', 'staff_account'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema identity: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end

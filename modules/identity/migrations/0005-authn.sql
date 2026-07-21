-- WP-014 authn migration (M02: sessions, MFA credentials, devices,
-- challenges, lockdowns). Contract: docs/contracts/session-api.md (FROZEN).
-- Architecture: ADR-006 Decision 1.
-- Idempotent: safe to re-apply; the DB suite re-applies it as its idempotency
-- proof. Rollback: modules/identity/migrations/0005-authn.rollback.sql.
-- Depends on modules/identity/migrations/0004-identity.sql (identity schema,
-- module_identity role, person/staff/endpoint tables); the migration runner
-- orders module migrations by file number across modules.
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('identity', authnRlsSpecs, identitySchemaRlsSpecs);
-- a drift test compares this file against a fresh emission.

-- Credentials: opaque secret references only — NEVER secret material. MFA
-- factor rows carry enrollment attribution and evidence (asserted vs verified
-- facts carry evidence; ADR-005 Decision 3 pattern).
CREATE TABLE IF NOT EXISTS identity.auth_credential (
  tenant_id text NOT NULL,
  credential_id text NOT NULL CHECK (credential_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  person_id text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('staff', 'portal')),
  kind text NOT NULL CHECK (kind IN ('password', 'webauthn', 'totp')),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  secret_ref text NOT NULL CHECK (
    secret_ref ~ '^[A-Za-z0-9_:-]{8,128}$'
    AND position('@' IN secret_ref) = 0
  ),
  enrolled_by text NOT NULL,
  evidence_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, credential_id),
  CONSTRAINT auth_credential_person_same_tenant
    FOREIGN KEY (tenant_id, person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- Server-side device records (ADR-006 Decision 1). A revoked device carries
-- its reason.
CREATE TABLE IF NOT EXISTS identity.auth_device (
  tenant_id text NOT NULL,
  device_id text NOT NULL CHECK (device_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  person_id text NOT NULL,
  label text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  revoked_reason text,
  first_seen_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, device_id),
  CONSTRAINT auth_device_revoked_carries_reason
    CHECK (status <> 'revoked' OR revoked_reason IS NOT NULL),
  CONSTRAINT auth_device_person_same_tenant
    FOREIGN KEY (tenant_id, person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- Server-side sessions. A staff session below aal2 is unrepresentable at rest
-- (staff MFA is mandatory; session-api.md), and a staff session names its
-- staff account. Revocation carries its reason.
CREATE TABLE IF NOT EXISTS identity.auth_session (
  tenant_id text NOT NULL,
  session_id text NOT NULL CHECK (session_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  person_id text NOT NULL,
  principal text NOT NULL CHECK (principal IN ('staff', 'portal')),
  staff_account_id text,
  device_id text NOT NULL,
  assurance text NOT NULL CHECK (assurance IN ('aal1', 'aal2')),
  status text NOT NULL CHECK (status IN ('active', 'locked', 'revoked', 'expired')),
  created_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  step_up_at timestamptz,
  revoked_reason text,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, session_id),
  CONSTRAINT auth_session_staff_carries_mfa
    CHECK (principal <> 'staff' OR assurance = 'aal2'),
  CONSTRAINT auth_session_staff_names_account
    CHECK (principal <> 'staff' OR staff_account_id IS NOT NULL),
  CONSTRAINT auth_session_revoked_carries_reason
    CHECK (status <> 'revoked' OR revoked_reason IS NOT NULL),
  CONSTRAINT auth_session_person_same_tenant
    FOREIGN KEY (tenant_id, person_id)
    REFERENCES identity.person (tenant_id, person_id),
  CONSTRAINT auth_session_device_same_tenant
    FOREIGN KEY (tenant_id, device_id)
    REFERENCES identity.auth_device (tenant_id, device_id),
  CONSTRAINT auth_session_staff_account_same_tenant
    FOREIGN KEY (tenant_id, staff_account_id)
    REFERENCES identity.staff_account (tenant_id, staff_account_id)
);

-- Magic-link/OTP/step-up/elevation/recovery challenges: expiring and
-- attempt-bounded BY CONSTRUCTION — an unbounded challenge is
-- unrepresentable. Delivery endpoint FKs into the WP-013 endpoint model; the
-- verified-association rule is enforced at issuance (authn.ts issueChallenge).
CREATE TABLE IF NOT EXISTS identity.auth_challenge (
  tenant_id text NOT NULL,
  challenge_id text NOT NULL CHECK (challenge_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  person_id text NOT NULL,
  endpoint_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('portal-login', 'step-up', 'elevation', 'recovery')),
  method text NOT NULL CHECK (method IN ('magic-link', 'otp')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts >= 1),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, challenge_id),
  CONSTRAINT auth_challenge_expires_by_construction CHECK (expires_at > issued_at),
  CONSTRAINT auth_challenge_attempts_bounded CHECK (attempt_count <= max_attempts),
  CONSTRAINT auth_challenge_person_same_tenant
    FOREIGN KEY (tenant_id, person_id)
    REFERENCES identity.person (tenant_id, person_id),
  CONSTRAINT auth_challenge_endpoint_same_tenant
    FOREIGN KEY (tenant_id, endpoint_id)
    REFERENCES identity.channel_endpoint (tenant_id, endpoint_id)
);

-- Lockout/ATO cases. The triggering signals are the forensic record
-- (REQ-ID-029 AC-3) and are required non-empty; a release carries evidence
-- and attribution or the row is unrepresentable (fails closed).
CREATE TABLE IF NOT EXISTS identity.account_lockdown (
  tenant_id text NOT NULL,
  lockdown_id text NOT NULL CHECK (lockdown_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  person_id text NOT NULL,
  trigger_kind text NOT NULL
    CHECK (trigger_kind IN ('failed-attempts', 'ato-suspicion', 'device-lost', 'admin')),
  signals jsonb NOT NULL CHECK (jsonb_typeof(signals) = 'array' AND jsonb_array_length(signals) > 0),
  high_risk_frozen boolean NOT NULL CHECK (high_risk_frozen),
  notified_endpoint_id text,
  notification_fallback boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('active', 'released')),
  release_requirement text NOT NULL
    CHECK (release_requirement IN ('step-up', 're-identity-proofing', 'supervised-manual')),
  released_by text,
  released_evidence_ref text,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, lockdown_id),
  CONSTRAINT account_lockdown_release_carries_evidence
    CHECK (status <> 'released' OR (released_by IS NOT NULL AND released_evidence_ref IS NOT NULL)),
  CONSTRAINT account_lockdown_person_same_tenant
    FOREIGN KEY (tenant_id, person_id)
    REFERENCES identity.person (tenant_id, person_id),
  CONSTRAINT account_lockdown_endpoint_same_tenant
    FOREIGN KEY (tenant_id, notified_endpoint_id)
    REFERENCES identity.channel_endpoint (tenant_id, endpoint_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO module_identity;
ALTER DEFAULT PRIVILEGES IN SCHEMA identity
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO module_identity;

-- Re-assert the 0004 append-only posture after the schema-wide GRANT above
-- (deterministic on re-apply, 0002 pattern).
REVOKE UPDATE, DELETE ON identity.identity_timeline FROM module_identity;

-- WP-016 append-only postures: the schema-wide GRANT above re-grants on the
-- merge tables when this migration re-applies AFTER 0006-merge.sql, so each
-- pass re-asserts their REVOKEs. Conditional because a fresh database runs
-- this migration before 0006 creates the tables.
DO $mergeappendonly$
BEGIN
  IF to_regclass('identity.merge_event') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON identity.merge_event FROM module_identity;
  END IF;
  IF to_regclass('identity.merge_lineage') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON identity.merge_lineage FROM module_identity;
  END IF;
  IF to_regclass('identity.merge_case') IS NOT NULL THEN
    REVOKE DELETE ON identity.merge_case FROM module_identity;
  END IF;
  IF to_regclass('identity.merge_case_person') IS NOT NULL THEN
    REVOKE DELETE ON identity.merge_case_person FROM module_identity;
  END IF;
END
$mergeappendonly$;

-- WP-015 structural postures: the schema-wide GRANT above re-grants on the
-- PDP tables when this migration re-applies AFTER 0008-pdp.sql, so each
-- pass re-asserts their REVOKEs (and role_template's status-only UPDATE).
-- Conditional because a fresh database runs this migration before 0008
-- creates the tables.
DO $pdppostures$
BEGIN
  IF to_regclass('identity.person_flag') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON identity.person_flag FROM module_identity;
  END IF;
  IF to_regclass('identity.role_template') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON identity.role_template FROM module_identity;
    GRANT UPDATE (status) ON identity.role_template TO module_identity;
  END IF;
  IF to_regclass('identity.role_assignment') IS NOT NULL THEN
    REVOKE DELETE ON identity.role_assignment FROM module_identity;
  END IF;
  IF to_regclass('identity.access_override') IS NOT NULL THEN
    REVOKE DELETE ON identity.access_override FROM module_identity;
  END IF;
  IF to_regclass('identity.authority_record') IS NOT NULL THEN
    REVOKE DELETE ON identity.authority_record FROM module_identity;
  END IF;
  IF to_regclass('identity.partition_tag') IS NOT NULL THEN
    REVOKE DELETE ON identity.partition_tag FROM module_identity;
  END IF;
  IF to_regclass('identity.gipa_authorization') IS NOT NULL THEN
    REVOKE DELETE ON identity.gipa_authorization FROM module_identity;
  END IF;
END
$pdppostures$;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE identity.account_lockdown ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.account_lockdown FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.account_lockdown;
CREATE POLICY tenant_isolation ON identity.account_lockdown
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.auth_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.auth_challenge FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.auth_challenge;
CREATE POLICY tenant_isolation ON identity.auth_challenge
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.auth_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.auth_credential FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.auth_credential;
CREATE POLICY tenant_isolation ON identity.auth_credential
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.auth_device ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.auth_device FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.auth_device;
CREATE POLICY tenant_isolation ON identity.auth_device
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.auth_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.auth_session FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.auth_session;
CREATE POLICY tenant_isolation ON identity.auth_session
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

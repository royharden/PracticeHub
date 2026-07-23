-- WP-013 identity module migration (M02: person/roles/endpoints/source-id crosswalk).
-- Contract: docs/contracts/identity-types.md (FROZEN). Architecture: ADR-005 Decision 3.
-- Idempotent: safe to re-apply; the DB suite re-applies it as its idempotency proof.
-- Rollback: modules/identity/migrations/0004-identity.rollback.sql (drop schema objects).
-- Depends on modules/platform-core/migrations/0001-tenancy.sql (tenancy tables +
-- practicehub_app role); the migration runner orders module migrations by file
-- number across modules.
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('identity', identityRlsSpecs); a drift test
-- compares this file against a fresh emission.

CREATE SCHEMA IF NOT EXISTS identity;

-- Module role pattern (ARCHITECTURE: no cross-module table writes, DB-role
-- enforced): identity-schema access grants only through module_identity;
-- practicehub_app (created by 0001-tenancy.sql) receives the module role and
-- owns nothing.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_identity') THEN
    CREATE ROLE module_identity NOLOGIN;
  END IF;
END
$roles$;

GRANT module_identity TO practicehub_app;
GRANT USAGE ON SCHEMA identity TO module_identity;

-- A Person is a human, distinct from every role they hold. Verified facts
-- carry evidence (fails closed); provisional identities retain source and
-- consent provenance (REQ-ID-003 AC-3).
CREATE TABLE IF NOT EXISTS identity.person (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  person_id text NOT NULL CHECK (person_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  status text NOT NULL CHECK (status IN ('provisional', 'verified')),
  verification_evidence_ref text,
  birth_date date,
  provenance_source text NOT NULL,
  captured_by text NOT NULL,
  consent_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, person_id),
  CONSTRAINT person_verified_carries_evidence
    CHECK (status <> 'verified' OR verification_evidence_ref IS NOT NULL)
);

-- Affirmed vs legal names as distinct facts on ONE person (REQ-ID-015 AC-1).
CREATE TABLE IF NOT EXISTS identity.person_name (
  tenant_id text NOT NULL,
  person_id text NOT NULL,
  name_kind text NOT NULL CHECK (name_kind IN ('affirmed', 'legal')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  given_name text NOT NULL,
  family_name text NOT NULL,
  effective_date date,
  source text NOT NULL,
  unsafe_contexts text[] NOT NULL DEFAULT '{}',
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, person_id, name_kind, revision),
  CONSTRAINT person_name_person_same_tenant
    FOREIGN KEY (tenant_id, person_id)
    REFERENCES identity.person (tenant_id, person_id),
  CONSTRAINT person_name_contexts_vocabulary
    CHECK (unsafe_contexts <@ ARRAY['care', 'portal', 'payer', 'pharmacy', 'laboratory', 'legal-document']::text[])
);

-- One patient record per person per tenant: the longitudinal identity across
-- locations (REQ-ID-005). Acquisition duplicates surface as duplicate PERSONS
-- for governed merge review (WP-016), never as a second record on one person.
CREATE TABLE IF NOT EXISTS identity.patient_record (
  tenant_id text NOT NULL,
  patient_record_id text NOT NULL CHECK (patient_record_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  person_id text NOT NULL,
  legal_entity_id text NOT NULL,
  home_location_id text,
  status text NOT NULL CHECK (status IN ('active', 'inactive')),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, patient_record_id),
  CONSTRAINT patient_record_one_per_person UNIQUE (tenant_id, person_id),
  CONSTRAINT patient_record_person_same_tenant
    FOREIGN KEY (tenant_id, person_id)
    REFERENCES identity.person (tenant_id, person_id),
  CONSTRAINT patient_record_entity_same_tenant
    FOREIGN KEY (tenant_id, legal_entity_id)
    REFERENCES platform_core.legal_entity (tenant_id, legal_entity_id),
  CONSTRAINT patient_record_location_same_tenant
    FOREIGN KEY (tenant_id, home_location_id)
    REFERENCES platform_core.location (tenant_id, location_id)
);

CREATE TABLE IF NOT EXISTS identity.staff_account (
  tenant_id text NOT NULL,
  staff_account_id text NOT NULL CHECK (staff_account_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  person_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'suspended', 'offboarded')),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, staff_account_id),
  CONSTRAINT staff_account_one_per_person UNIQUE (tenant_id, person_id),
  CONSTRAINT staff_account_person_same_tenant
    FOREIGN KEY (tenant_id, person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- Financial-responsibility role: scoped, evidenced, never a merge of people.
CREATE TABLE IF NOT EXISTS identity.guarantor_role (
  tenant_id text NOT NULL,
  guarantor_role_id text NOT NULL CHECK (guarantor_role_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  guarantor_person_id text NOT NULL,
  patient_record_id text NOT NULL,
  scope text[] NOT NULL CHECK (cardinality(scope) > 0),
  evidence_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'ended')),
  ended_reason text,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, guarantor_role_id),
  CONSTRAINT guarantor_role_ended_carries_reason
    CHECK (status <> 'ended' OR ended_reason IS NOT NULL),
  CONSTRAINT guarantor_person_same_tenant
    FOREIGN KEY (tenant_id, guarantor_person_id)
    REFERENCES identity.person (tenant_id, person_id),
  CONSTRAINT guarantor_patient_same_tenant
    FOREIGN KEY (tenant_id, patient_record_id)
    REFERENCES identity.patient_record (tenant_id, patient_record_id)
);

-- Proxy authority is scoped AND expiring by construction (ADR-005 Decision 3):
-- an unbounded or self-referential proxy grant is unrepresentable.
CREATE TABLE IF NOT EXISTS identity.proxy_grant (
  tenant_id text NOT NULL,
  proxy_grant_id text NOT NULL CHECK (proxy_grant_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  grantee_person_id text NOT NULL,
  subject_person_id text NOT NULL,
  scope text[] NOT NULL CHECK (cardinality(scope) > 0),
  expires_on date NOT NULL,
  evidence_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, proxy_grant_id),
  CONSTRAINT proxy_grant_never_self CHECK (grantee_person_id <> subject_person_id),
  CONSTRAINT proxy_grantee_same_tenant
    FOREIGN KEY (tenant_id, grantee_person_id)
    REFERENCES identity.person (tenant_id, person_id),
  CONSTRAINT proxy_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- A shared phone or email is NEVER a person (REQ-ID-017; the WP-013 gate
-- property): the endpoint shape has no person column — people attach through
-- associations, any number of people may share one endpoint.
CREATE TABLE IF NOT EXISTS identity.channel_endpoint (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  endpoint_id text NOT NULL CHECK (endpoint_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  kind text NOT NULL CHECK (kind IN ('phone', 'email')),
  endpoint_value text NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, endpoint_id),
  CONSTRAINT channel_endpoint_value_unique UNIQUE (tenant_id, kind, endpoint_value)
);

-- Per-person attachment to an endpoint: relationship, verification state, and
-- attribution stay per PERSON (REQ-ID-017 AC-1) — consent, purpose, and
-- source never pool on the endpoint.
CREATE TABLE IF NOT EXISTS identity.endpoint_association (
  tenant_id text NOT NULL,
  endpoint_id text NOT NULL,
  person_id text NOT NULL,
  relationship text NOT NULL
    CHECK (relationship IN ('self', 'household', 'proxy', 'guarantor', 'unknown')),
  verification text NOT NULL CHECK (verification IN ('asserted', 'verified')),
  evidence_ref text,
  source text NOT NULL,
  consent_ref text,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, endpoint_id, person_id),
  CONSTRAINT endpoint_association_verified_carries_evidence
    CHECK (verification <> 'verified' OR evidence_ref IS NOT NULL),
  CONSTRAINT endpoint_association_endpoint_same_tenant
    FOREIGN KEY (tenant_id, endpoint_id)
    REFERENCES identity.channel_endpoint (tenant_id, endpoint_id),
  CONSTRAINT endpoint_association_person_same_tenant
    FOREIGN KEY (tenant_id, person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- Source-identifier crosswalk: each external id resolves to at most ONE
-- person (primary key), every source id is preserved, and payment-rail
-- references are opaque by construction — the payment processor never
-- carries names, dates, or contact detail (REQ-ID-004 AC-1).
CREATE TABLE IF NOT EXISTS identity.source_identifier (
  tenant_id text NOT NULL,
  source_system text NOT NULL CHECK (source_system ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  source_value text NOT NULL CHECK (source_value <> ''),
  person_id text NOT NULL,
  patient_record_id text,
  verification text NOT NULL CHECK (verification IN ('asserted', 'verified')),
  evidence_ref text,
  provenance_source text NOT NULL,
  ingest_ref text,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, source_system, source_value),
  CONSTRAINT source_identifier_verified_carries_evidence
    CHECK (verification <> 'verified' OR evidence_ref IS NOT NULL),
  CONSTRAINT source_identifier_payment_refs_opaque
    CHECK (
      source_system <> 'stripe'
      OR (
        source_value ~ '^[A-Za-z0-9_-]{8,128}$'
        AND source_value !~ '[0-9]{4}-[0-9]{2}-[0-9]{2}'
        AND position('@' IN source_value) = 0
      )
    ),
  CONSTRAINT source_identifier_person_same_tenant
    FOREIGN KEY (tenant_id, person_id)
    REFERENCES identity.person (tenant_id, person_id),
  CONSTRAINT source_identifier_record_same_tenant
    FOREIGN KEY (tenant_id, patient_record_id)
    REFERENCES identity.patient_record (tenant_id, patient_record_id)
);

-- Append-only identity timeline (REQ-ID-005 AC-3): registration, conversion,
-- cross-location encounters, name updates, reviews — actor, location, source,
-- timestamp on every entry.
CREATE TABLE IF NOT EXISTS identity.identity_timeline (
  tenant_id text NOT NULL,
  entry_id text NOT NULL CHECK (entry_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  person_id text NOT NULL,
  entry_kind text NOT NULL CHECK (
    entry_kind IN ('registered', 'converted', 'cross-location-encounter', 'name-updated',
                   'endpoint-linked', 'source-linked', 'review-opened')
  ),
  actor_ref text NOT NULL,
  location_id text,
  source text NOT NULL,
  occurred_at timestamptz NOT NULL,
  detail text,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, entry_id),
  CONSTRAINT identity_timeline_person_same_tenant
    FOREIGN KEY (tenant_id, person_id)
    REFERENCES identity.person (tenant_id, person_id),
  CONSTRAINT identity_timeline_location_same_tenant
    FOREIGN KEY (tenant_id, location_id)
    REFERENCES platform_core.location (tenant_id, location_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO module_identity;
ALTER DEFAULT PRIVILEGES IN SCHEMA identity
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO module_identity;

-- Append-only posture for the timeline: GRANT ALL above is deterministic on
-- re-apply, so this REVOKE re-applies the posture each pass (0002 pattern).
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

-- WP-017 elevation postures: the schema-wide GRANT above re-grants on the
-- elevation tables when this migration re-applies AFTER 0013-elevation.sql, so
-- each pass re-asserts their REVOKEs (append-only evidence; the anomaly case is
-- DELETE-revoked only, resolution UPDATEs). Conditional because a fresh
-- database runs this migration before 0013 creates the tables.
DO $elevationpostures$
BEGIN
  IF to_regclass('identity.break_glass_grant') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON identity.break_glass_grant FROM module_identity;
  END IF;
  IF to_regclass('identity.break_glass_review') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON identity.break_glass_review FROM module_identity;
  END IF;
  IF to_regclass('identity.offboarding_case') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON identity.offboarding_case FROM module_identity;
  END IF;
  IF to_regclass('identity.offboarding_reassignment') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON identity.offboarding_reassignment FROM module_identity;
  END IF;
  IF to_regclass('identity.access_recertification') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON identity.access_recertification FROM module_identity;
  END IF;
  IF to_regclass('identity.access_anomaly_case') IS NOT NULL THEN
    REVOKE DELETE ON identity.access_anomaly_case FROM module_identity;
  END IF;
END
$elevationpostures$;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE identity.channel_endpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.channel_endpoint FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.channel_endpoint;
CREATE POLICY tenant_isolation ON identity.channel_endpoint
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.endpoint_association ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.endpoint_association FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.endpoint_association;
CREATE POLICY tenant_isolation ON identity.endpoint_association
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.guarantor_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.guarantor_role FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.guarantor_role;
CREATE POLICY tenant_isolation ON identity.guarantor_role
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.identity_timeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.identity_timeline FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.identity_timeline;
CREATE POLICY tenant_isolation ON identity.identity_timeline
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.patient_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.patient_record FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.patient_record;
CREATE POLICY tenant_isolation ON identity.patient_record
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.person ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.person FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.person;
CREATE POLICY tenant_isolation ON identity.person
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.person_name ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.person_name FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.person_name;
CREATE POLICY tenant_isolation ON identity.person_name
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.proxy_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.proxy_grant FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.proxy_grant;
CREATE POLICY tenant_isolation ON identity.proxy_grant
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.source_identifier ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.source_identifier FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.source_identifier;
CREATE POLICY tenant_isolation ON identity.source_identifier
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.staff_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.staff_account FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.staff_account;
CREATE POLICY tenant_isolation ON identity.staff_account
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

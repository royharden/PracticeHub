-- WP-016 merge-governance migration (M02: merge cases, reversible
-- merge/unmerge events, lineage). Contract: docs/contracts/merge-governance.md
-- (FROZEN). Executes FWD-ID-016-UNMERGE from identity-types.md.
-- Idempotent: safe to re-apply; the DB suite re-applies it as its idempotency
-- proof. Rollback: modules/identity/migrations/0006-merge.rollback.sql.
-- Depends on modules/identity/migrations/0004-identity.sql (identity schema,
-- module_identity role, person table); the migration runner orders module
-- migrations by file number across modules.
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('identity', mergeRlsSpecs, identitySchemaRlsSpecs);
-- a drift test compares this file against a fresh emission.

-- Merge cases: the persisted possible-match queue (REQ-ID-003 AC-2 execution;
-- REQ-ID-009/-020/-026/-030 detection origins). A case carries attribute
-- NAMES only — record values never sit on the case (REQ-ID-003 exception 1).
-- Structural rules, enforced by CHECK rather than review memory:
--   resolution is attributed with a reason; link/merge carry approved
--   evidence; specialized patterns require their checks before link/merge;
--   a merged resolution names its merge event — a case edit cannot merge.
CREATE TABLE IF NOT EXISTS identity.merge_case (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  case_id text NOT NULL CHECK (case_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  kind text NOT NULL CHECK (
    kind IN ('possible-match', 'check-in-duplicate', 'staff-flagged-duplicate',
             'wrong-merge-suspect')
  ),
  status text NOT NULL CHECK (
    status IN ('open', 'resolved-linked', 'resolved-distinct', 'resolved-merged', 'dismissed')
  ),
  matched_attributes text[] NOT NULL CHECK (
    matched_attributes <@ ARRAY['given-name', 'family-name', 'birth-date', 'phone', 'email',
                                'postal-address']::text[]
  ),
  conflicting_attributes text[] NOT NULL DEFAULT '{}' CHECK (
    conflicting_attributes <@ ARRAY['given-name', 'family-name', 'birth-date', 'phone', 'email',
                                    'postal-address']::text[]
  ),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  contact_risk boolean NOT NULL DEFAULT false,
  pending_operations text[] NOT NULL DEFAULT '{}',
  source_id_refs text[] NOT NULL DEFAULT '{}',
  specialized_patterns text[] NOT NULL DEFAULT '{}' CHECK (
    specialized_patterns <@ ARRAY['minor-or-proxy', 'shared-household-contact', 'name-change',
                                  'sponsor-roster', 'duplicate-payment-rail-email']::text[]
  ),
  opened_by text NOT NULL,
  source text NOT NULL,
  resolved_kind text CHECK (
    resolved_kind IN ('linked', 'confirmed-distinct', 'merged', 'dismissed')
  ),
  resolved_by text,
  resolved_reason text,
  resolution_evidence_ref text,
  specialized_checks_ref text,
  do_not_reflag boolean NOT NULL DEFAULT false,
  merge_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, case_id),
  CONSTRAINT merge_case_status_matches_resolution CHECK (
    (status = 'open' AND resolved_kind IS NULL)
    OR (status = 'resolved-linked' AND resolved_kind = 'linked')
    OR (status = 'resolved-distinct' AND resolved_kind = 'confirmed-distinct')
    OR (status = 'resolved-merged' AND resolved_kind = 'merged')
    OR (status = 'dismissed' AND resolved_kind = 'dismissed')
  ),
  CONSTRAINT merge_case_resolution_attributed CHECK (
    resolved_kind IS NULL OR (resolved_by IS NOT NULL AND resolved_reason IS NOT NULL)
  ),
  CONSTRAINT merge_case_link_merge_carry_evidence CHECK (
    resolved_kind IS NULL
    OR resolved_kind IN ('confirmed-distinct', 'dismissed')
    OR resolution_evidence_ref IS NOT NULL
  ),
  CONSTRAINT merge_case_specialized_checks_before_merge CHECK (
    cardinality(specialized_patterns) = 0
    OR resolved_kind IS NULL
    OR resolved_kind IN ('confirmed-distinct', 'dismissed')
    OR specialized_checks_ref IS NOT NULL
  ),
  CONSTRAINT merge_case_merged_names_event CHECK (
    resolved_kind IS DISTINCT FROM 'merged' OR merge_event_id IS NOT NULL
  )
);

-- The identities under review — at least two, attached per person so
-- composite FKs keep every subject inside the tenant.
CREATE TABLE IF NOT EXISTS identity.merge_case_person (
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  person_id text NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, case_id, person_id),
  CONSTRAINT merge_case_person_case_same_tenant
    FOREIGN KEY (tenant_id, case_id)
    REFERENCES identity.merge_case (tenant_id, case_id),
  CONSTRAINT merge_case_person_person_same_tenant
    FOREIGN KEY (tenant_id, person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- Merge/unmerge events: append-only (REVOKE below). A merge event without
-- the authorization-basis floor is unrepresentable — at least two compared
-- attributes including one merge-sufficient (given-name/family-name/
-- birth-date); endpoint equality or household address can never carry the
-- decision (REQ-ID-017 exception, mirrored from assertMergeAuthorizationBasis).
-- An unmerge event names the merge event it reverses (REQ-ID-026 AC-4).
CREATE TABLE IF NOT EXISTS identity.merge_event (
  tenant_id text NOT NULL,
  event_id text NOT NULL CHECK (event_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  case_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('merge', 'unmerge')),
  survivor_person_id text NOT NULL,
  merged_person_id text NOT NULL,
  basis_attributes text[] NOT NULL DEFAULT '{}' CHECK (
    basis_attributes <@ ARRAY['given-name', 'family-name', 'birth-date', 'phone', 'email',
                              'postal-address']::text[]
  ),
  decided_by text NOT NULL CHECK (decided_by <> ''),
  rationale text NOT NULL CHECK (rationale <> ''),
  evidence_ref text,
  reverses_event_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT merge_event_never_self CHECK (survivor_person_id <> merged_person_id),
  CONSTRAINT merge_event_merge_carries_basis CHECK (
    kind <> 'merge'
    OR (
      cardinality(basis_attributes) >= 2
      AND basis_attributes && ARRAY['given-name', 'family-name', 'birth-date']::text[]
    )
  ),
  CONSTRAINT merge_event_merge_carries_evidence CHECK (
    kind <> 'merge' OR evidence_ref IS NOT NULL
  ),
  CONSTRAINT merge_event_unmerge_reverses CHECK (
    kind <> 'unmerge' OR reverses_event_id IS NOT NULL
  ),
  CONSTRAINT merge_event_merge_reverses_nothing CHECK (
    kind <> 'merge' OR reverses_event_id IS NULL
  ),
  CONSTRAINT merge_event_case_same_tenant
    FOREIGN KEY (tenant_id, case_id)
    REFERENCES identity.merge_case (tenant_id, case_id),
  CONSTRAINT merge_event_survivor_same_tenant
    FOREIGN KEY (tenant_id, survivor_person_id)
    REFERENCES identity.person (tenant_id, person_id),
  CONSTRAINT merge_event_merged_same_tenant
    FOREIGN KEY (tenant_id, merged_person_id)
    REFERENCES identity.person (tenant_id, person_id),
  CONSTRAINT merge_event_reverses_same_tenant
    FOREIGN KEY (tenant_id, reverses_event_id)
    REFERENCES identity.merge_event (tenant_id, event_id)
);

-- Lineage: one row per artifact the event re-attributed (or quarantined as
-- indeterminate during unmerge — held on the survivor, never guessed).
-- Append-only (REVOKE below): lineage is what makes every merge reversible.
CREATE TABLE IF NOT EXISTS identity.merge_lineage (
  tenant_id text NOT NULL,
  lineage_id text NOT NULL CHECK (lineage_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  event_id text NOT NULL,
  artifact_kind text NOT NULL CHECK (
    artifact_kind IN ('patient-record', 'person-name', 'endpoint-association',
                      'source-identifier', 'guarantor-role', 'proxy-grant', 'timeline-entry')
  ),
  artifact_ref text NOT NULL CHECK (artifact_ref <> ''),
  from_person_id text NOT NULL,
  to_person_id text NOT NULL,
  disposition text NOT NULL CHECK (
    disposition IN ('re-attributed', 'indeterminate-quarantined')
  ),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, lineage_id),
  CONSTRAINT merge_lineage_direction_matches_disposition CHECK (
    (disposition = 're-attributed' AND from_person_id <> to_person_id)
    OR (disposition = 'indeterminate-quarantined' AND from_person_id = to_person_id)
  ),
  CONSTRAINT merge_lineage_event_same_tenant
    FOREIGN KEY (tenant_id, event_id)
    REFERENCES identity.merge_event (tenant_id, event_id),
  CONSTRAINT merge_lineage_from_same_tenant
    FOREIGN KEY (tenant_id, from_person_id)
    REFERENCES identity.person (tenant_id, person_id),
  CONSTRAINT merge_lineage_to_same_tenant
    FOREIGN KEY (tenant_id, to_person_id)
    REFERENCES identity.person (tenant_id, person_id)
);

-- Deterministic grants for this migration's tables (0004's ALTER DEFAULT
-- PRIVILEGES already grants on newly created tables; re-asserting keeps the
-- posture explicit and idempotent).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON identity.merge_case, identity.merge_case_person,
     identity.merge_event, identity.merge_lineage
  TO module_identity;

-- Append-only postures: events and lineage are immutable history; cases are
-- never deleted — they resolve. Re-asserted on every pass (0002 pattern),
-- and re-asserted conditionally by 0004/0005 whose schema-wide GRANT would
-- otherwise re-open them on re-apply.
REVOKE UPDATE, DELETE ON identity.merge_event FROM module_identity;
REVOKE UPDATE, DELETE ON identity.merge_lineage FROM module_identity;
REVOKE DELETE ON identity.merge_case FROM module_identity;
REVOKE DELETE ON identity.merge_case_person FROM module_identity;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE identity.merge_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.merge_case FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.merge_case;
CREATE POLICY tenant_isolation ON identity.merge_case
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.merge_case_person ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.merge_case_person FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.merge_case_person;
CREATE POLICY tenant_isolation ON identity.merge_case_person
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.merge_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.merge_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.merge_event;
CREATE POLICY tenant_isolation ON identity.merge_event
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE identity.merge_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.merge_lineage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON identity.merge_lineage;
CREATE POLICY tenant_isolation ON identity.merge_lineage
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

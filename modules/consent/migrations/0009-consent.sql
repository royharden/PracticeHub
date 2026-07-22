-- WP-018 consent migration (M03: append-only communication + disclosure
-- consent ledger, folded projection, canSend choke point, jurisdiction
-- overlays). Contract: docs/contracts/cansend-api.md (FROZEN) +
-- docs/contracts/consent-ledger-schema.md (§4). Compliance: R6-REQ-070/071/
-- 072/074, R6-SR-020/031/040/041/042. Idempotent: safe to re-apply; the DB
-- suite re-applies it as its idempotency proof. Rollback:
-- modules/consent/migrations/0009-consent.rollback.sql.
-- Depends on modules/platform-core/migrations/0001-tenancy.sql (tenant table +
-- practicehub_app role); the migration runner orders module migrations by file
-- number across modules.
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('consent', consentRlsSpecs, consentSchemaRlsSpecs);
-- a drift test compares this file against a fresh emission.

CREATE SCHEMA IF NOT EXISTS consent;

-- Module role pattern (ARCHITECTURE: no cross-module table writes, DB-role
-- enforced): consent-schema access grants only through module_consent;
-- practicehub_app (created by 0001-tenancy.sql) receives the module role and
-- owns nothing.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_consent') THEN
    CREATE ROLE module_consent NOLOGIN;
  END IF;
END
$roles$;

GRANT module_consent TO practicehub_app;
GRANT USAGE ON SCHEMA consent TO module_consent;

-- The consent ledger (R6-REQ-070/071): one append-only event table, two scope
-- axes (communication = channel x purpose; disclosure = purpose x recipient x
-- record-type), folded into consent_state. Structural rules enforced by CHECK
-- rather than review memory:
--   * scope shape: a communication event carries a channel and no recipient/
--     record-type; a disclosure event carries recipient + record-type and no
--     channel — cross-axis rows are unrepresentable;
--   * action pairs to exactly one resulting state;
--   * a marketing GRANT needs an affirmative evidenced source (CHD opt-in
--     floor, R6-SR-020; NV SB370 unbundling — never inherited from treatment);
--   * a genetic event needs specific written authorization evidence
--     (R6-SR-031); a disclosure GRANT needs written consent (R6-SR-040 MHRA);
--   * refs are grammar-checked; free text has no column.
-- person_ref is a SOFT reference (no cross-module FK): the ledger records
-- subjects that may be migrated/quarantined, exactly like the audit store.
CREATE TABLE IF NOT EXISTS consent.consent_event (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  consent_event_id text NOT NULL CHECK (consent_event_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  person_ref text NOT NULL CHECK (person_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  scope_type text NOT NULL CHECK (scope_type IN ('communication', 'disclosure')),
  scope_key text NOT NULL CHECK (scope_key ~ '^[a-z0-9][a-z0-9|:._=/-]{0,254}$'),
  channel text CHECK (channel IN ('sms', 'voice', 'ai_voice', 'email', 'fax', 'portal')),
  purpose text NOT NULL CHECK (purpose IN ('treatment', 'payment', 'operations', 'marketing')),
  recipient_ref text CHECK (recipient_ref IS NULL OR recipient_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  record_type text CHECK (
    record_type IN ('general', 'genetic', 'mental-health', 'substance-use', 'all')
  ),
  action text NOT NULL CHECK (
    action IN ('grant', 'revoke', 'expire', 'block', 'unblock', 'renew')
  ),
  resulting_state text NOT NULL CHECK (
    resulting_state IN ('opted_in', 'opted_out', 'pending', 'expired', 'blocked')
  ),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  source text NOT NULL CHECK (
    source IN ('portal_form', 'sms_keyword', 'verbal_documented', 'paper_form',
               'api_import', 'staff_entry', 'double_optin', 'web_form')
  ),
  evidence_ref text CHECK (evidence_ref IS NULL OR evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  evidence_hash text CHECK (evidence_hash IS NULL OR evidence_hash ~ '^[0-9a-f]{64}$'),
  captured_by text CHECK (captured_by IS NULL OR captured_by ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  jurisdiction text NOT NULL CHECK (jurisdiction IN ('NV', 'FL', 'IL', 'MN', 'virtual')),
  policy_version text NOT NULL CHECK (policy_version <> ''),
  quiet_hours_tz text NOT NULL DEFAULT 'UTC' CHECK (quiet_hours_tz <> ''),
  partition_tags text[] NOT NULL DEFAULT '{}' CHECK (
    partition_tags <@ ARRAY['gipa-genetic', 'chd', 'biometric', 'part2']::text[]
  ),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, consent_event_id),
  CONSTRAINT consent_event_scope_shape CHECK (
    (scope_type = 'communication'
      AND channel IS NOT NULL AND recipient_ref IS NULL AND record_type IS NULL)
    OR
    (scope_type = 'disclosure'
      AND channel IS NULL AND recipient_ref IS NOT NULL AND record_type IS NOT NULL)
  ),
  CONSTRAINT consent_event_action_state CHECK (
    (action = 'grant' AND resulting_state = 'opted_in')
    OR (action = 'renew' AND resulting_state = 'opted_in')
    OR (action = 'revoke' AND resulting_state = 'opted_out')
    OR (action = 'expire' AND resulting_state = 'expired')
    OR (action = 'block' AND resulting_state = 'blocked')
    OR (action = 'unblock' AND resulting_state = 'pending')
  ),
  CONSTRAINT consent_event_marketing_optin_floor CHECK (
    NOT (purpose = 'marketing' AND action = 'grant')
    OR (source IN ('portal_form', 'paper_form', 'double_optin', 'web_form', 'verbal_documented')
        AND evidence_ref IS NOT NULL)
  ),
  CONSTRAINT consent_event_genetic_authorization CHECK (
    NOT (action IN ('grant', 'renew')
         AND (record_type = 'genetic' OR 'gipa-genetic' = ANY (partition_tags)))
    OR evidence_ref IS NOT NULL
  ),
  CONSTRAINT consent_event_disclosure_written CHECK (
    NOT (scope_type = 'disclosure' AND action = 'grant')
    OR evidence_ref IS NOT NULL
  ),
  CONSTRAINT consent_event_expiry_after_effective CHECK (
    expires_at IS NULL OR expires_at >= effective_at
  )
);

-- The folded projection (R6-REQ-071): one row per (tenant, person_ref,
-- scope_key), the latest event's resolved state. Rebuildable at any time by
-- foldConsentState — a materialized read model, never a second source of
-- truth. last_event_id points at its governing event in the same tenant.
CREATE TABLE IF NOT EXISTS consent.consent_state (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  person_ref text NOT NULL CHECK (person_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  scope_key text NOT NULL CHECK (scope_key ~ '^[a-z0-9][a-z0-9|:._=/-]{0,254}$'),
  scope_type text NOT NULL CHECK (scope_type IN ('communication', 'disclosure')),
  channel text CHECK (channel IN ('sms', 'voice', 'ai_voice', 'email', 'fax', 'portal')),
  purpose text NOT NULL CHECK (purpose IN ('treatment', 'payment', 'operations', 'marketing')),
  recipient_ref text CHECK (recipient_ref IS NULL OR recipient_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  record_type text CHECK (
    record_type IN ('general', 'genetic', 'mental-health', 'substance-use', 'all')
  ),
  current_state text NOT NULL CHECK (
    current_state IN ('opted_in', 'opted_out', 'pending', 'expired', 'blocked')
  ),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  last_event_id text NOT NULL,
  quiet_hours_tz text NOT NULL DEFAULT 'UTC' CHECK (quiet_hours_tz <> ''),
  jurisdiction text NOT NULL CHECK (jurisdiction IN ('NV', 'FL', 'IL', 'MN', 'virtual')),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, person_ref, scope_key),
  CONSTRAINT consent_state_scope_shape CHECK (
    (scope_type = 'communication'
      AND channel IS NOT NULL AND recipient_ref IS NULL AND record_type IS NULL)
    OR
    (scope_type = 'disclosure'
      AND channel IS NULL AND recipient_ref IS NOT NULL AND record_type IS NOT NULL)
  ),
  CONSTRAINT consent_state_last_event_same_tenant
    FOREIGN KEY (tenant_id, last_event_id)
    REFERENCES consent.consent_event (tenant_id, consent_event_id)
);

-- Deterministic grants for this migration's tables.
GRANT SELECT, INSERT ON consent.consent_event TO module_consent;
GRANT SELECT, INSERT, UPDATE ON consent.consent_state TO module_consent;

-- Append-only posture (R6-REQ-071: the log cannot be edited or deleted by any
-- app role; corrections are new events). The projection folds forward — it
-- never deletes. Re-asserted on every pass.
REVOKE UPDATE, DELETE ON consent.consent_event FROM module_consent;
REVOKE DELETE ON consent.consent_state FROM module_consent;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE consent.consent_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent.consent_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON consent.consent_event;
CREATE POLICY tenant_isolation ON consent.consent_event
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE consent.consent_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent.consent_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON consent.consent_state;
CREATE POLICY tenant_isolation ON consent.consent_state
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
   WHERE n.nspname = 'consent'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('consent_event', 'consent_state', 'obligation_clock', 'obligation_clock_event', 'obligation_clock_policy', 'policy_document'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema consent: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end

-- WP-019 policy/disclosure registry + obligation-clock engine (M03). Contract:
-- docs/contracts/clock-api.md (FROZEN). Source: ADR-007 Decision 3 (versioned,
-- effective-dated policy/disclosure registry) + Decision 4 (obligation-clock
-- engine generalizing C-05: clocks are obligation × jurisdiction, not one
-- 60-day breach clock). Temporal model: ADR-ADJ-002 shared effective-dating
-- (FWD-SR-019-TEMPORAL). Compliance: R6-SR-041 (MHRA renewal), R6-SR-102
-- (statute-tracker), R6-REQ-010 (records-request closure). Idempotent: safe to
-- re-apply; the DB suite re-applies it as its idempotency proof. Rollback:
-- modules/consent/migrations/0011-policy-clocks.rollback.sql.
-- Depends on modules/consent/migrations/0009-consent.sql (schema consent +
-- module_consent role). The migration runner orders module migrations by file
-- number across modules, so 0011 applies after 0010-events.sql.
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('consent', policyClockRlsSpecs, consentSchemaRlsSpecs);
-- a drift test compares this file against a fresh emission.

-- Counsel-owned, effective-dated clock durations per (obligation type ×
-- jurisdiction) — C-05: a shorter statutory deadline is stricter (FL 30-day
-- beats the HIPAA 60-day floor). Platform-global: statutory clock content is
-- tenant-independent reference, like platform_core.jurisdiction_rule_pack. The
-- `floor` pseudo-jurisdiction is the always-effective federal fail-closed floor.
-- Structural rules mirror the domain (clocks.ts obligationTypeSpecs):
--   * an anchor-basis obligation (mhra-renewal) carries no duration; a
--     duration-basis obligation requires one;
--   * counsel-signed status requires a sign-off reference (EW-025).
CREATE TABLE IF NOT EXISTS consent.obligation_clock_policy (
  obligation_type text NOT NULL CHECK (
    obligation_type IN ('breach-notification', 'mhra-renewal',
                        'records-request-closure', 'rule-pack-review')
  ),
  jurisdiction text NOT NULL CHECK (jurisdiction = 'floor' OR jurisdiction ~ '^[A-Z]{2}$'),
  version integer NOT NULL CHECK (version >= 1),
  effective_on date NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'counsel-signed')),
  counsel_signoff_ref text CHECK (
    counsel_signoff_ref IS NULL OR counsel_signoff_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'
  ),
  change_control_ref text NOT NULL CHECK (change_control_ref ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  duration_days integer CHECK (duration_days IS NULL OR duration_days >= 1),
  escalation_lead_days integer NOT NULL CHECK (escalation_lead_days >= 0),
  source_ref text NOT NULL CHECK (source_ref <> ''),
  synthetic boolean NOT NULL,
  PRIMARY KEY (obligation_type, jurisdiction, version),
  CONSTRAINT clock_policy_duration_basis CHECK (
    (obligation_type = 'mhra-renewal' AND duration_days IS NULL)
    OR (obligation_type <> 'mhra-renewal' AND duration_days IS NOT NULL)
  ),
  CONSTRAINT clock_policy_signed_needs_ref CHECK (
    status <> 'counsel-signed' OR counsel_signoff_ref IS NOT NULL
  )
);

-- Versioned, effective-dated policy documents (ToS, privacy, NPP, disclosure
-- authorizations, AI-disclosure strings, recording notices) with per-jurisdiction
-- variants (ADR-007 D3). Tenant/brand-scoped — the documents are the practice's.
-- The body lives in the document store; this registry holds a grammar-checked
-- content_ref + content_hash only (free text is never a column). Append-only:
-- a new document is a new version, never a rewrite.
CREATE TABLE IF NOT EXISTS consent.policy_document (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  document_type text NOT NULL CHECK (
    document_type IN ('terms-of-service', 'privacy-notice', 'notice-of-privacy-practices',
                     'disclosure-authorization', 'ai-disclosure', 'recording-notice')
  ),
  jurisdiction text NOT NULL CHECK (jurisdiction = 'floor' OR jurisdiction ~ '^[A-Z]{2}$'),
  version integer NOT NULL CHECK (version >= 1),
  effective_on date NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'counsel-signed')),
  counsel_signoff_ref text CHECK (
    counsel_signoff_ref IS NULL OR counsel_signoff_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'
  ),
  change_control_ref text NOT NULL CHECK (change_control_ref ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  content_ref text NOT NULL CHECK (content_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, document_type, jurisdiction, version),
  CONSTRAINT policy_document_signed_needs_ref CHECK (
    status <> 'counsel-signed' OR counsel_signoff_ref IS NOT NULL
  )
);

-- Append-only obligation-clock event log (ADR-009 event-sourced timers). Created
-- before obligation_clock so the projection's last_event_id FK resolves.
-- Structural rules mirror the domain (clocks.ts):
--   * a trigger names the computed deadline (due_at);
--   * a satisfy carries its evidence-of-completion (R6-REQ-006/052 trail).
CREATE TABLE IF NOT EXISTS consent.obligation_clock_event (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  clock_event_id text NOT NULL CHECK (clock_event_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  clock_id text NOT NULL CHECK (clock_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  obligation_type text NOT NULL CHECK (
    obligation_type IN ('breach-notification', 'mhra-renewal',
                        'records-request-closure', 'rule-pack-review')
  ),
  kind text NOT NULL CHECK (kind IN ('trigger', 'escalate', 'satisfy', 'cancel', 'expire-fired')),
  subject_ref text NOT NULL CHECK (subject_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  occurred_at timestamptz NOT NULL,
  due_at timestamptz,
  evidence_ref text CHECK (evidence_ref IS NULL OR evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  evidence_hash text CHECK (evidence_hash IS NULL OR evidence_hash ~ '^[0-9a-f]{64}$'),
  actor_ref text NOT NULL CHECK (actor_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  reason text,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, clock_event_id),
  CONSTRAINT clock_event_trigger_has_due CHECK (kind <> 'trigger' OR due_at IS NOT NULL),
  CONSTRAINT clock_event_satisfy_has_evidence CHECK (kind <> 'satisfy' OR evidence_ref IS NOT NULL)
);

-- The clock projection (one row per clock, latest event's derived status).
-- Rebuildable by foldClocks — a materialized read model, never a second source
-- of truth. Structural rules mirror the domain:
--   * a satisfied clock carries its evidence-of-completion;
--   * escalate_at is never after due_at (the near-deadline worklist point);
--   * last_event_id points at its governing event in the same tenant.
CREATE TABLE IF NOT EXISTS consent.obligation_clock (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  clock_id text NOT NULL CHECK (clock_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  obligation_type text NOT NULL CHECK (
    obligation_type IN ('breach-notification', 'mhra-renewal',
                        'records-request-closure', 'rule-pack-review')
  ),
  subject_ref text NOT NULL CHECK (subject_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  trigger_ref text NOT NULL CHECK (trigger_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  triggered_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  escalate_at timestamptz NOT NULL,
  status text NOT NULL CHECK (
    status IN ('pending', 'escalated', 'overdue', 'satisfied', 'cancelled')
  ),
  owner_role text NOT NULL CHECK (owner_role <> ''),
  closure_evidence_ref text CHECK (
    closure_evidence_ref IS NULL OR closure_evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'
  ),
  last_event_id text NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, clock_id),
  CONSTRAINT clock_satisfied_needs_evidence CHECK (
    status <> 'satisfied' OR closure_evidence_ref IS NOT NULL
  ),
  CONSTRAINT clock_escalate_not_after_due CHECK (escalate_at <= due_at),
  CONSTRAINT clock_last_event_same_tenant
    FOREIGN KEY (tenant_id, last_event_id)
    REFERENCES consent.obligation_clock_event (tenant_id, clock_event_id)
);

-- Deterministic grants for this migration's tables.
GRANT SELECT, INSERT ON consent.obligation_clock_policy TO module_consent;
GRANT SELECT, INSERT ON consent.policy_document TO module_consent;
GRANT SELECT, INSERT ON consent.obligation_clock_event TO module_consent;
GRANT SELECT, INSERT, UPDATE ON consent.obligation_clock TO module_consent;

-- Append-only posture (mirrors consent_event): the counsel-owned reference
-- registries and the clock event log are corrected by new versions/events, never
-- rewritten; the projection folds forward (UPDATE its status) but never deletes.
-- Re-asserted on every pass.
REVOKE UPDATE, DELETE ON consent.obligation_clock_policy FROM module_consent;
REVOKE UPDATE, DELETE ON consent.policy_document FROM module_consent;
REVOKE UPDATE, DELETE ON consent.obligation_clock_event FROM module_consent;
REVOKE DELETE ON consent.obligation_clock FROM module_consent;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE consent.obligation_clock ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent.obligation_clock FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON consent.obligation_clock;
CREATE POLICY tenant_isolation ON consent.obligation_clock
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE consent.obligation_clock_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent.obligation_clock_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON consent.obligation_clock_event;
CREATE POLICY tenant_isolation ON consent.obligation_clock_event
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE consent.obligation_clock_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent.obligation_clock_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON consent.obligation_clock_policy;
-- platform-global: Counsel-owned statutory clock-duration reference (breach/access/renewal/statute-tracker); law is tenant-independent, like the jurisdiction rule packs (ADR-007 D4, C-05)
CREATE POLICY tenant_isolation ON consent.obligation_clock_policy
  USING (true)
  WITH CHECK (true);

ALTER TABLE consent.policy_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent.policy_document FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON consent.policy_document;
CREATE POLICY tenant_isolation ON consent.policy_document
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

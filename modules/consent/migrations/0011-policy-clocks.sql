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

-- Deterministic grants for this migration's tables. The counsel-owned reference
-- registries are RUNTIME READ-ONLY (SELECT only) for the module role — see the
-- REVOKE block below (review-016 F1). The append-only clock event log and its
-- projection stay INSERT-able (protective clocks trigger/escalate at runtime).
GRANT SELECT ON consent.obligation_clock_policy TO module_consent;
GRANT SELECT ON consent.policy_document TO module_consent;
GRANT SELECT, INSERT ON consent.obligation_clock_event TO module_consent;
GRANT SELECT, INSERT, UPDATE ON consent.obligation_clock TO module_consent;

-- Append-only posture (mirrors consent_event): the counsel-owned reference
-- registries and the clock event log are corrected by new versions/events, never
-- rewritten; the projection folds forward (UPDATE its status) but never deletes.
-- Re-asserted on every pass.
--
-- review-016 F1: the counsel-owned policy_document + obligation_clock_policy
-- registries also REVOKE INSERT — they are runtime read-only for the normal app
-- role, exactly like platform_core.jurisdiction_rule_pack (the FROZEN contract's
-- model for these tables). Versions arrive as change-controlled seed data (the
-- owner connection); the gated publish commands (consent.policy-clocks, floored
-- simulated) produce the AuthorityDecision + config-change audit. practicehub_app
-- inherits module_consent, so a normal app principal can no longer forge a
-- highest-version platform-global clock policy that would govern every tenant.
REVOKE INSERT, UPDATE, DELETE ON consent.obligation_clock_policy FROM module_consent;
REVOKE INSERT, UPDATE, DELETE ON consent.policy_document FROM module_consent;
REVOKE UPDATE, DELETE ON consent.obligation_clock_event FROM module_consent;
REVOKE DELETE ON consent.obligation_clock FROM module_consent;

-- review-016 remediation (WP-019 reopen), idempotent — safe on fresh and on
-- already-provisioned databases (ADD COLUMN IF NOT EXISTS + DO-guarded named
-- constraints), applied on every migrate pass:
--   * F3 replayable projection: the trigger event carries the rebuild metadata
--     (trigger_ref, escalate_at, owner_role, governing_policy_ref) so foldClocks
--     rebuilds every projection field from the event log alone;
--   * F5 structured rule-pack-review closure: change_control_ref +
--     truth_table_receipt_ref on a rule-pack-review satisfy (R6-SR-102);
--   * F2 exactly-once expiry: the obligation_clock.expire_fired terminal marker;
--   * F5 renewal lineage: consent_event.supersedes_consent_event_id (REQ-ADM-031
--     AC-3 — a disclosure renew is versioned WITH lineage to the old consent).
ALTER TABLE consent.obligation_clock_event ADD COLUMN IF NOT EXISTS trigger_ref text;
ALTER TABLE consent.obligation_clock_event ADD COLUMN IF NOT EXISTS escalate_at timestamptz;
ALTER TABLE consent.obligation_clock_event ADD COLUMN IF NOT EXISTS owner_role text;
ALTER TABLE consent.obligation_clock_event ADD COLUMN IF NOT EXISTS governing_policy_ref text;
ALTER TABLE consent.obligation_clock_event ADD COLUMN IF NOT EXISTS change_control_ref text;
ALTER TABLE consent.obligation_clock_event ADD COLUMN IF NOT EXISTS truth_table_receipt_ref text;
ALTER TABLE consent.obligation_clock
  ADD COLUMN IF NOT EXISTS expire_fired boolean NOT NULL DEFAULT false;
ALTER TABLE consent.consent_event ADD COLUMN IF NOT EXISTS supersedes_consent_event_id text;

DO $wp019_remediation$
BEGIN
  -- F3: a trigger event carries the full rebuild metadata (the projection is
  -- reconstructable from the log alone) + grammar on the new refs.
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'clock_event_trigger_rebuildable') THEN
    ALTER TABLE consent.obligation_clock_event
      ADD CONSTRAINT clock_event_trigger_rebuildable CHECK (
        kind <> 'trigger'
        OR (trigger_ref IS NOT NULL AND escalate_at IS NOT NULL
            AND owner_role IS NOT NULL AND governing_policy_ref IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'clock_event_trigger_ref_grammar') THEN
    ALTER TABLE consent.obligation_clock_event
      ADD CONSTRAINT clock_event_trigger_ref_grammar CHECK (
        trigger_ref IS NULL OR trigger_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'
      );
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'clock_event_owner_role_present') THEN
    ALTER TABLE consent.obligation_clock_event
      ADD CONSTRAINT clock_event_owner_role_present CHECK (owner_role IS NULL OR owner_role <> '');
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'clock_event_governing_policy_grammar') THEN
    ALTER TABLE consent.obligation_clock_event
      ADD CONSTRAINT clock_event_governing_policy_grammar CHECK (
        governing_policy_ref IS NULL OR governing_policy_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'
      );
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'clock_event_change_control_grammar') THEN
    ALTER TABLE consent.obligation_clock_event
      ADD CONSTRAINT clock_event_change_control_grammar CHECK (
        change_control_ref IS NULL OR change_control_ref ~ '^[a-z0-9][a-z0-9-]{0,127}$'
      );
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'clock_event_truth_table_grammar') THEN
    ALTER TABLE consent.obligation_clock_event
      ADD CONSTRAINT clock_event_truth_table_grammar CHECK (
        truth_table_receipt_ref IS NULL OR truth_table_receipt_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'
      );
  END IF;
  -- F5 / R6-SR-102: a rule-pack-review satisfy carries STRUCTURED evidence — a
  -- change-control ref AND the truth-table regeneration receipt.
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'clock_event_rule_pack_structured') THEN
    ALTER TABLE consent.obligation_clock_event
      ADD CONSTRAINT clock_event_rule_pack_structured CHECK (
        NOT (kind = 'satisfy' AND obligation_type = 'rule-pack-review')
        OR (change_control_ref IS NOT NULL AND truth_table_receipt_ref IS NOT NULL)
      );
  END IF;
  -- F5 / REQ-ADM-031 AC-3 renewal lineage on the consent ledger: only a renew
  -- may supersede; a disclosure renew MUST carry lineage; the pointer references
  -- a real prior event in the same tenant.
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'consent_event_supersedes_grammar') THEN
    ALTER TABLE consent.consent_event
      ADD CONSTRAINT consent_event_supersedes_grammar CHECK (
        supersedes_consent_event_id IS NULL
        OR supersedes_consent_event_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'
      );
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'consent_event_supersedes_renew_only') THEN
    ALTER TABLE consent.consent_event
      ADD CONSTRAINT consent_event_supersedes_renew_only CHECK (
        supersedes_consent_event_id IS NULL OR action = 'renew'
      );
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'consent_event_disclosure_renew_lineage') THEN
    ALTER TABLE consent.consent_event
      ADD CONSTRAINT consent_event_disclosure_renew_lineage CHECK (
        NOT (scope_type = 'disclosure' AND action = 'renew')
        OR supersedes_consent_event_id IS NOT NULL
      );
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'consent_event_supersedes_same_tenant') THEN
    ALTER TABLE consent.consent_event
      ADD CONSTRAINT consent_event_supersedes_same_tenant
        FOREIGN KEY (tenant_id, supersedes_consent_event_id)
        REFERENCES consent.consent_event (tenant_id, consent_event_id);
  END IF;
END
$wp019_remediation$;

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

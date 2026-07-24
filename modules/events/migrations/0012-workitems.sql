-- WP-022 workitems migration (M05: the WorkItem + SLA-timer + escalation engine
-- the events-work module owns alongside the event spine — ADR-013 "worklists
-- (WorkItem — events-work module)"). Contract: docs/contracts/workitem-sla-api.md
-- (FROZEN); behavioral seed docs/contracts/sla-engine-spec.md §5. Compliance:
-- REQ-TASK-002 (one accountable owner + queue), REQ-TASK-019 (worklist by SLA
-- state), REQ-TASK-029 (holding-reply pauses timer + reassignment with context).
-- NFR-7 observability + RSK-02 (SLA timers keep running — honest breach).
-- Idempotent: safe to re-apply; the DB suite re-applies it as its idempotency
-- proof. Rollback: modules/events/migrations/0012-workitems.rollback.sql.
-- Depends on 0001-tenancy.sql (tenant table + practicehub_app) and 0010-events.sql
-- (schema events + module_events role); the runner orders migrations by file
-- number across modules.
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('events', workItemsRlsSpecs, eventsSchemaRlsSpecs); a
-- drift test compares this file against a fresh emission. 0010's guard section is
-- regenerated in the same act to the full schema-wide table list (its DDL is
-- unchanged).

CREATE SCHEMA IF NOT EXISTS events;

-- Per-tier SLA policy registry (R8 §5.3). Effective-dated, versioned config data
-- of record — RUNTIME READ-ONLY for the module role (GRANT SELECT only + the
-- REVOKE below), exactly like consent.obligation_clock_policy and
-- platform_core.jurisdiction_rule_pack. Versions arrive as change-controlled
-- seed data (the owner connection); the gated publishSlaPolicy command
-- (platform.tasking-engine, floored simulated) produces the AuthorityDecision +
-- config-change audit. The engine enforces whatever the effective version sets;
-- version selection reuses the platform-core effective-dating primitive.
CREATE TABLE IF NOT EXISTS events.sla_policy (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  policy_id text NOT NULL CHECK (policy_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  version integer NOT NULL CHECK (version >= 1),
  effective_on date NOT NULL,
  member_tier text NOT NULL CHECK (member_tier ~ '^[a-z0-9][a-z0-9:._-]{0,63}$'),
  hours_mode text NOT NULL CHECK (hours_mode IN ('business', 'after_hours')),
  first_response_target_minutes integer NOT NULL CHECK (first_response_target_minutes > 0),
  next_response_target_minutes integer NOT NULL CHECK (next_response_target_minutes > 0),
  resolution_target_minutes integer CHECK (
    resolution_target_minutes IS NULL OR resolution_target_minutes > 0
  ),
  escalation_chain jsonb NOT NULL,
  quiet_hours_exempt boolean NOT NULL,
  change_control_ref text NOT NULL CHECK (change_control_ref ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, policy_id, version)
);

-- WorkItem: the universal worklist entry (canonical data model). The projection
-- folded from the append-only work_item_event log — one accountable owner at a
-- time (owner_ref), a coverage pool for the unclaimed holding (pool_id), watchers
-- (jsonb set) who retain visibility but not accountability. Immutable open facts
-- (origin/subject/purpose/risk/tier/policy) plus the folded lifecycle. Structural
-- rules by CHECK, not review memory:
--   * has_sla is exactly whether an SLA policy is attached (a no-SLA item sorts
--     below all SLA items — REQ-TASK-019 E1);
--   * an owned item is never also pooled (single accountable owner);
--   * an item that has ever been owned carries first_owned_at.
CREATE TABLE IF NOT EXISTS events.work_item (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  work_item_id text NOT NULL CHECK (work_item_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  origin text NOT NULL CHECK (
    origin IN ('thread', 'merge-review', 'authority-review', 'obligation-clock',
               'identity-recon', 'fulfillment', 'complaint', 'admin')
  ),
  subject_ref text CHECK (subject_ref IS NULL OR subject_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  purpose text NOT NULL CHECK (purpose ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  risk text NOT NULL CHECK (risk IN ('routine', 'elevated', 'urgent', 'critical')),
  service_tier text NOT NULL CHECK (service_tier ~ '^[a-z0-9][a-z0-9:._-]{0,63}$'),
  sla_policy_id text CHECK (sla_policy_id IS NULL OR sla_policy_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  policy_version integer CHECK (policy_version IS NULL OR policy_version >= 1),
  has_sla boolean NOT NULL,
  status text NOT NULL CHECK (
    status IN ('unmatched', 'open', 'pending', 'snoozed', 'resolved', 'reopened')
  ),
  priority text NOT NULL CHECK (priority IN ('normal', 'high', 'urgent')),
  owner_ref text CHECK (owner_ref IS NULL OR owner_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  pool_id text CHECK (pool_id IS NULL OR pool_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  watchers jsonb NOT NULL DEFAULT '[]'::jsonb,
  escalated boolean NOT NULL DEFAULT false,
  opened_at timestamptz NOT NULL,
  response_due_at timestamptz,
  first_owned_at timestamptz,
  last_event_seq integer NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, work_item_id),
  CONSTRAINT work_item_has_sla_iff_policy CHECK (
    has_sla = (sla_policy_id IS NOT NULL AND policy_version IS NOT NULL)
  ),
  CONSTRAINT work_item_owner_xor_pool CHECK (owner_ref IS NULL OR pool_id IS NULL),
  CONSTRAINT work_item_owned_has_first_owned CHECK (owner_ref IS NULL OR first_owned_at IS NOT NULL)
);

-- The append-only work-item event log (R8 §5.7: one of the module's two
-- immutable spines — every SLA breach and ownership change is reconstructable).
-- Ownership acceptance is structural: only assigned/claimed/reassigned name a
-- new owner, so opening/queuing/tagging/an inbound/a holding reply/an auto-ack
-- can never become ownership by accident (REQ-TASK-002 E1 / REQ-TASK-029 E2).
CREATE TABLE IF NOT EXISTS events.work_item_event (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  work_item_id text NOT NULL CHECK (work_item_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  event_seq integer NOT NULL CHECK (event_seq >= 1),
  event_type text NOT NULL CHECK (
    event_type IN ('opened', 'queued', 'assigned', 'claimed', 'reassigned',
                   'inbound_received', 'holding_reply', 'reply_sent',
                   'timer_started', 'timer_paused', 'timer_resumed', 'timer_breached',
                   'timer_met', 'escalated', 'watcher_added', 'watcher_removed',
                   'resolved', 'reopened')
  ),
  occurred_at timestamptz NOT NULL,
  actor_ref text CHECK (actor_ref IS NULL OR actor_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  from_owner_ref text CHECK (from_owner_ref IS NULL OR from_owner_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  to_owner_ref text CHECK (to_owner_ref IS NULL OR to_owner_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  reason text CHECK (
    reason IS NULL OR reason IN ('claim', 'assignment', 'escalation', 'pto', 'coverage', 'manual')
  ),
  timer_type text CHECK (
    timer_type IS NULL OR timer_type IN ('first_response', 'next_response', 'resolution')
  ),
  due_at timestamptz,
  escalation_step integer CHECK (escalation_step IS NULL OR escalation_step >= 0),
  escalation_action text CHECK (
    escalation_action IS NULL OR escalation_action IN
      ('notify_owner', 'notify_supervisor', 'page_oncall', 'reassign_pool', 'mark_priority_high')
  ),
  escalation_target text CHECK (escalation_target IS NULL OR escalation_target ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  context_package jsonb,
  watcher_ref text CHECK (watcher_ref IS NULL OR watcher_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, work_item_id, event_seq),
  CONSTRAINT wie_item_same_tenant
    FOREIGN KEY (tenant_id, work_item_id)
    REFERENCES events.work_item (tenant_id, work_item_id),
  -- Acceptance events name the new owner (REQ-TASK-002 E1 structural half).
  CONSTRAINT wie_acceptance_names_owner CHECK (
    event_type NOT IN ('assigned', 'claimed', 'reassigned') OR to_owner_ref IS NOT NULL
  ),
  -- A claim / reassignment hands off a context package (REQ-TASK-029 A3).
  CONSTRAINT wie_reassign_carries_context CHECK (
    event_type NOT IN ('claimed', 'reassigned') OR context_package IS NOT NULL
  ),
  -- Timer events name a timer type; a start carries a due instant.
  CONSTRAINT wie_timer_events_name_type CHECK (
    event_type NOT IN ('timer_started', 'timer_paused', 'timer_resumed', 'timer_breached', 'timer_met')
    OR timer_type IS NOT NULL
  ),
  CONSTRAINT wie_timer_started_has_due CHECK (event_type <> 'timer_started' OR due_at IS NOT NULL),
  -- An escalation names its step, action, and target.
  CONSTRAINT wie_escalated_named CHECK (
    event_type <> 'escalated'
    OR (escalation_step IS NOT NULL AND escalation_action IS NOT NULL AND escalation_target IS NOT NULL)
  )
);

-- SLA timer projection (one row per work item × timer type): the drainer of the
-- worklist reads state/due from here. Folds forward — started/paused/resumed/
-- breached/met advance it in place; it never deletes. A pause accrues into
-- paused_total_seconds so breach math stays auditable (R8 §5.2).
CREATE TABLE IF NOT EXISTS events.sla_timer (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  work_item_id text NOT NULL CHECK (work_item_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  timer_type text NOT NULL CHECK (timer_type IN ('first_response', 'next_response', 'resolution')),
  started_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  paused_total_seconds integer NOT NULL DEFAULT 0 CHECK (paused_total_seconds >= 0),
  state text NOT NULL CHECK (state IN ('running', 'paused', 'breached', 'met')),
  last_event_seq integer NOT NULL CHECK (last_event_seq >= 1),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, work_item_id, timer_type),
  CONSTRAINT sla_timer_item_same_tenant
    FOREIGN KEY (tenant_id, work_item_id)
    REFERENCES events.work_item (tenant_id, work_item_id)
);

-- Deterministic grants for this migration's tables. The SLA policy registry is
-- RUNTIME READ-ONLY (SELECT only). The work-item event log is append-only
-- (INSERT only). The projections fold forward (INSERT + UPDATE, never DELETE).
GRANT SELECT ON events.sla_policy TO module_events;
GRANT SELECT, INSERT, UPDATE ON events.work_item TO module_events;
GRANT SELECT, INSERT ON events.work_item_event TO module_events;
GRANT SELECT, INSERT, UPDATE ON events.sla_timer TO module_events;

-- Runtime read-only for the policy registry: versions arrive as change-controlled
-- seed data (the owner), never forged by an app principal (the publishSlaPolicy
-- command gates WHO may publish; this is the DB floor). Append-only for the event
-- log; fold-forward for the projections. Re-asserted on every pass.
REVOKE INSERT, UPDATE, DELETE ON events.sla_policy FROM module_events;
REVOKE UPDATE, DELETE ON events.work_item_event FROM module_events;
REVOKE DELETE ON events.work_item FROM module_events;
REVOKE DELETE ON events.sla_timer FROM module_events;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE events.sla_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.sla_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON events.sla_policy;
CREATE POLICY tenant_isolation ON events.sla_policy
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE events.sla_timer ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.sla_timer FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON events.sla_timer;
CREATE POLICY tenant_isolation ON events.sla_timer
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE events.work_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.work_item FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON events.work_item;
CREATE POLICY tenant_isolation ON events.work_item
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE events.work_item_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.work_item_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON events.work_item_event;
CREATE POLICY tenant_isolation ON events.work_item_event
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
   WHERE n.nspname = 'events'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('coverage_gap_alert', 'coverage_handoff', 'coverage_window', 'inbox', 'on_call_rotation', 'on_call_slot', 'outbox', 'outbox_delivery', 'sla_policy', 'sla_timer', 'work_item', 'work_item_event'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema events: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end

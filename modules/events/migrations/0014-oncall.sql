-- WP-023 on-call + coverage migration (M05: the events-work module — on-call
-- schedule, coverage/PTO, and the morning-handoff artifact built on the WP-022
-- reassignment-with-context mechanism). Contract: docs/contracts/oncall-coverage-api.md
-- (FROZEN); behavioral seed docs/contracts/sla-engine-spec.md §5.4/§5.6.
-- Requirements: REQ-ADM-016 (provisioned 24/7 on-call escalation chain),
-- REQ-ADM-041 (rotations/overrides/gap alerting), REQ-ADM-015 (skip on-call
-- provider outside service scope), REQ-TASK-003/020 (reassign before absence +
-- coverage/PTO bulk reassign with context), REQ-TASK-034 (morning handoff),
-- REQ-TASK-033 (abrupt-departure vacate + bulk reassign — M05/M02 slice).
-- Idempotent: safe to re-apply; the DB suite re-applies it as its idempotency
-- proof. Rollback: modules/events/migrations/0014-oncall.rollback.sql.
-- Depends on 0001-tenancy.sql (tenant table + practicehub_app) and 0010-events.sql
-- (schema events + module_events role); the runner orders migrations by file
-- number across modules. 0012-workitems.sql stays intact — coverage moves drive
-- events.work_item through the WP-022 store, they do not alter its tables.
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('events', onCallRlsSpecs, eventsSchemaRlsSpecs); a
-- drift test compares this file against a fresh emission. 0010's and 0012's guard
-- sections are regenerated in the same act to the full schema-wide table list
-- (their DDL is unchanged).

CREATE SCHEMA IF NOT EXISTS events;

-- Provisioned on-call rotation registry (R8 §5.4). Effective-dated, versioned
-- config data of record — RUNTIME READ-ONLY for the module role (GRANT SELECT
-- only + the REVOKE below), exactly like events.sla_policy. Versions arrive as
-- change-controlled seed data (the owner connection); the gated
-- publishOnCallRotation command (platform.tasking-engine, floored simulated)
-- produces the AuthorityDecision + config-change audit. Version selection reuses
-- the platform-core effective-dating primitive.
CREATE TABLE IF NOT EXISTS events.on_call_rotation (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  rotation_id text NOT NULL CHECK (rotation_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  version integer NOT NULL CHECK (version >= 1),
  effective_on date NOT NULL,
  location_id text NOT NULL CHECK (location_id ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  coverage_mode text NOT NULL CHECK (coverage_mode IN ('24x7', 'business')),
  service_scopes jsonb NOT NULL,
  member_order jsonb NOT NULL,
  change_control_ref text NOT NULL CHECK (change_control_ref ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, rotation_id, version),
  CONSTRAINT on_call_rotation_scopes_array CHECK (jsonb_typeof(service_scopes) = 'array'),
  CONSTRAINT on_call_rotation_members_array CHECK (jsonb_typeof(member_order) = 'array')
);

-- The concrete on-call schedule: a member on call for [window_start, window_end).
-- kind = rotation | override (an override wins over a rotation slot on the same
-- window, REQ-ADM-041); status = scheduled | overridden | vacated (a vacated slot
-- covers nobody, REQ-TASK-033). Fold-forward (INSERT + UPDATE, never DELETE) so a
-- schedule history is auditable.
CREATE TABLE IF NOT EXISTS events.on_call_slot (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  slot_id text NOT NULL CHECK (slot_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  rotation_id text NOT NULL CHECK (rotation_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  kind text NOT NULL CHECK (kind IN ('rotation', 'override')),
  member_ref text NOT NULL CHECK (member_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  service_scopes jsonb NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled', 'overridden', 'vacated')),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, slot_id),
  CONSTRAINT on_call_slot_scopes_array CHECK (jsonb_typeof(service_scopes) = 'array'),
  CONSTRAINT on_call_slot_window_order CHECK (window_end > window_start)
);

-- An owner's OOO/PTO window with its coverage target (R8 §5.6). Operational,
-- app-writable, fold-forward (INSERT + UPDATE, never DELETE).
CREATE TABLE IF NOT EXISTS events.coverage_window (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  coverage_id text NOT NULL CHECK (coverage_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  owner_ref text NOT NULL CHECK (owner_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  from_at timestamptz NOT NULL,
  to_at timestamptz NOT NULL,
  coverage_target_ref text NOT NULL CHECK (coverage_target_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  target_kind text NOT NULL CHECK (target_kind IN ('owner', 'pool')),
  reason text NOT NULL CHECK (reason IN ('pto', 'coverage')),
  status text NOT NULL CHECK (status IN ('planned', 'active', 'closed')),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, coverage_id),
  CONSTRAINT coverage_window_order CHECK (to_at > from_at)
);

-- A detected coverage gap (REQ-ADM-041 gap alerting; a 24/7 rotation gap is a
-- provisioning defect, REQ-ADM-016). Fold-forward: an alert is raised (INSERT) and
-- resolved (status UPDATE), never deleted.
CREATE TABLE IF NOT EXISTS events.coverage_gap_alert (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  alert_id text NOT NULL CHECK (alert_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  rotation_id text NOT NULL CHECK (rotation_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  location_id text NOT NULL CHECK (location_id ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  service_scope text NOT NULL CHECK (service_scope ~ '^[a-z0-9][a-z0-9:._-]{0,63}$'),
  gap_start timestamptz NOT NULL,
  gap_end timestamptz NOT NULL,
  detected_reason text NOT NULL CHECK (
    detected_reason IN ('no-qualified-oncall', 'vacated-slot', 'unfilled-window')
  ),
  status text NOT NULL CHECK (status IN ('open', 'resolved')),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, alert_id),
  CONSTRAINT coverage_gap_alert_order CHECK (gap_end > gap_start)
);

-- The bulk-move / handoff audit artifact (contract §2). An APPEND-ONLY immutable
-- record (INSERT only) — a coverage/PTO/departure/morning handoff, with the
-- per-item context-package references in context_manifest (references, never
-- inline PHI). item_count matches the manifest length.
CREATE TABLE IF NOT EXISTS events.coverage_handoff (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  handoff_id text NOT NULL CHECK (handoff_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  kind text NOT NULL CHECK (kind IN ('morning-handoff', 'pto-coverage', 'departure')),
  from_owner_ref text CHECK (from_owner_ref IS NULL OR from_owner_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  to_owner_ref text NOT NULL CHECK (to_owner_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  generated_at timestamptz NOT NULL,
  item_count integer NOT NULL CHECK (item_count >= 0),
  context_manifest jsonb NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, handoff_id),
  CONSTRAINT coverage_handoff_manifest_array CHECK (jsonb_typeof(context_manifest) = 'array'),
  CONSTRAINT coverage_handoff_count_matches CHECK (item_count = jsonb_array_length(context_manifest))
);

-- Deterministic grants. The rotation registry is RUNTIME READ-ONLY (SELECT only).
-- Slots/windows/gap-alerts fold forward (INSERT + UPDATE, never DELETE). The
-- handoff record is append-only (INSERT only — an immutable audit artifact).
GRANT SELECT ON events.on_call_rotation TO module_events;
GRANT SELECT, INSERT, UPDATE ON events.on_call_slot TO module_events;
GRANT SELECT, INSERT, UPDATE ON events.coverage_window TO module_events;
GRANT SELECT, INSERT, UPDATE ON events.coverage_gap_alert TO module_events;
GRANT SELECT, INSERT ON events.coverage_handoff TO module_events;

-- Runtime read-only for the rotation registry: versions arrive as change-controlled
-- seed data (the owner), never forged by an app principal (publishOnCallRotation
-- gates WHO may publish; this is the DB floor). Fold-forward for the operational
-- tables; append-only for the handoff artifact. Re-asserted on every pass.
REVOKE INSERT, UPDATE, DELETE ON events.on_call_rotation FROM module_events;
REVOKE DELETE ON events.on_call_slot FROM module_events;
REVOKE DELETE ON events.coverage_window FROM module_events;
REVOKE DELETE ON events.coverage_gap_alert FROM module_events;
REVOKE UPDATE, DELETE ON events.coverage_handoff FROM module_events;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE events.coverage_gap_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.coverage_gap_alert FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON events.coverage_gap_alert;
CREATE POLICY tenant_isolation ON events.coverage_gap_alert
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE events.coverage_handoff ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.coverage_handoff FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON events.coverage_handoff;
CREATE POLICY tenant_isolation ON events.coverage_handoff
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE events.coverage_window ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.coverage_window FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON events.coverage_window;
CREATE POLICY tenant_isolation ON events.coverage_window
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE events.on_call_rotation ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.on_call_rotation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON events.on_call_rotation;
CREATE POLICY tenant_isolation ON events.on_call_rotation
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE events.on_call_slot ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.on_call_slot FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON events.on_call_slot;
CREATE POLICY tenant_isolation ON events.on_call_slot
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

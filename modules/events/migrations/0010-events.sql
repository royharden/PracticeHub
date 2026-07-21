-- WP-021 events migration (M05: the platform event spine — transactional
-- outbox, per-consumer inbox dedup, and the delivery projection the drainer
-- advances). Contract: docs/contracts/event-spine.md (FROZEN). Architecture:
-- ADR-009 (commands, events, idempotency, outbox/inbox, replay). Compliance:
-- REQ-PLAT-018 (integration idempotency and replay receipt); R6-REQ-001 wiring
-- (same-commit over the outbox, FWD-AUD-021-OUTBOX). Idempotent: safe to
-- re-apply; the DB suite re-applies it as its idempotency proof. Rollback:
-- modules/events/migrations/0010-events.rollback.sql.
-- Depends on modules/platform-core/migrations/0001-tenancy.sql (tenant table +
-- practicehub_app role); the migration runner orders module migrations by file
-- number across modules.
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('events', eventsRlsSpecs, eventsSchemaRlsSpecs); a
-- drift test compares this file against a fresh emission.

CREATE SCHEMA IF NOT EXISTS events;

-- Module role pattern (ARCHITECTURE: no cross-module table writes, DB-role
-- enforced). The event spine is the ONE sanctioned integration channel: modules
-- integrate by publishing to the outbox and consuming via the inbox, never by
-- touching each other's domain tables (ADR-001/ADR-009). module_events grants
-- that channel; practicehub_app (created by 0001-tenancy.sql) receives the role
-- and owns nothing.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_events') THEN
    CREATE ROLE module_events NOLOGIN;
  END IF;
END
$roles$;

GRANT module_events TO practicehub_app;
GRANT USAGE ON SCHEMA events TO module_events;

-- The transactional outbox (ADR-009 Decision 1/3): one immutable envelope row
-- per event. Enqueued in the SAME transaction as the producing command's domain
-- mutation (and its audit emit) — an event without its command, or a command
-- without its event, is unrepresentable on commit. The envelope is append-only
-- evidence: DELIVERY state lives in a separate table so the log is never
-- rewritten. Structural rules enforced by CHECK rather than review memory:
--   * event_id / causation / supersession / reversal pointers are ULIDs;
--   * refs are grammar-checked (lower-case), so prose (and raw PHI) has no
--     field to land in outside the classified jsonb payload;
--   * idempotency_key is UNIQUE per tenant — a replayed producer intent
--     collapses to one outbox row (producer-side idempotency).
CREATE TABLE IF NOT EXISTS events.outbox (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  event_id text NOT NULL CHECK (event_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  legal_entity_id text CHECK (legal_entity_id IS NULL OR legal_entity_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  type text NOT NULL CHECK (type ~ '^[a-z0-9][a-z0-9.-]{0,127}$'),
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  aggregate_id text NOT NULL CHECK (aggregate_id ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  aggregate_version integer NOT NULL CHECK (aggregate_version >= 0),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  effective_at timestamptz,
  source_module text NOT NULL CHECK (source_module ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  source_actor_ref text CHECK (source_actor_ref IS NULL OR source_actor_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  correlation_id text CHECK (correlation_id IS NULL OR correlation_id ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  causation_id text CHECK (causation_id IS NULL OR causation_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  data_classification text NOT NULL CHECK (
    data_classification IN ('none', 'demographic', 'PHI', 'PHI-restricted', 'secret')
  ),
  retention_class text CHECK (retention_class IS NULL OR retention_class ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  supersedes_event_id text CHECK (supersedes_event_id IS NULL OR supersedes_event_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  reversal_of_event_id text CHECK (reversal_of_event_id IS NULL OR reversal_of_event_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  external_receipt_ref text CHECK (external_receipt_ref IS NULL OR external_receipt_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  payload jsonb NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT outbox_idempotency_key_unique UNIQUE (tenant_id, idempotency_key)
);

-- The delivery projection (ADR-009 Decision 3): one row per outbox event, the
-- drainer's mutable at-least-once delivery state. `published_at` is set iff the
-- effect landed (the recovery-epoch fence: a published row is never re-sent on
-- replay). `unknown` is the explicit outcome-uncertain state; `dead` is
-- terminal (a dead-lettered delivery opens a WorkItem downstream, never a silent
-- drop). The projection folds forward — it never deletes.
CREATE TABLE IF NOT EXISTS events.outbox_delivery (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  event_id text NOT NULL CHECK (event_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  status text NOT NULL CHECK (
    status IN ('pending', 'publishing', 'published', 'failed', 'unknown', 'dead')
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  last_error text CHECK (last_error IS NULL OR last_error ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT outbox_delivery_event_same_tenant
    FOREIGN KEY (tenant_id, event_id)
    REFERENCES events.outbox (tenant_id, event_id),
  -- published_at is present exactly when the delivery is published.
  CONSTRAINT outbox_delivery_published_at_iff_published
    CHECK ((published_at IS NOT NULL) = (status = 'published'))
);

-- Consumer-side inbox (ADR-009 Decision 3): the dedup key is (consumer,
-- event_id). A consumer INSERTs its row the FIRST time it processes an event;
-- every redelivery conflicts on the primary key and is skipped — exactly-once
-- effect under at-least-once delivery. Append-only: a processed marker is never
-- edited or removed.
CREATE TABLE IF NOT EXISTS events.inbox (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  consumer text NOT NULL CHECK (consumer ~ '^[a-z0-9][a-z0-9.:-]{0,127}$'),
  event_id text NOT NULL CHECK (event_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  processed_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL DEFAULT 'processed' CHECK (outcome IN ('processed', 'skipped')),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, consumer, event_id),
  CONSTRAINT inbox_event_same_tenant
    FOREIGN KEY (tenant_id, event_id)
    REFERENCES events.outbox (tenant_id, event_id)
);

-- Deterministic grants for this migration's tables.
GRANT SELECT, INSERT ON events.outbox TO module_events;
GRANT SELECT, INSERT, UPDATE ON events.outbox_delivery TO module_events;
GRANT SELECT, INSERT ON events.inbox TO module_events;

-- Append-only posture: the outbox envelope and the inbox markers are never
-- edited or deleted by any app role (corrections are new events); the delivery
-- projection folds forward — it never deletes. Re-asserted on every pass.
REVOKE UPDATE, DELETE ON events.outbox FROM module_events;
REVOKE DELETE ON events.outbox_delivery FROM module_events;
REVOKE UPDATE, DELETE ON events.inbox FROM module_events;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE events.inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.inbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON events.inbox;
CREATE POLICY tenant_isolation ON events.inbox
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE events.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON events.outbox;
CREATE POLICY tenant_isolation ON events.outbox
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE events.outbox_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.outbox_delivery FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON events.outbox_delivery;
CREATE POLICY tenant_isolation ON events.outbox_delivery
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
          OR c.relname NOT IN ('inbox', 'outbox', 'outbox_delivery'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema events: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end

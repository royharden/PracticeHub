-- WP-030 M11 Thread aggregate. The comms schema owns message metadata and
-- content references only; content values remain behind the communications port.
CREATE SCHEMA IF NOT EXISTS comms;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_comms') THEN
    CREATE ROLE module_comms NOLOGIN;
  END IF;
END
$roles$;

GRANT module_comms TO practicehub_app;
GRANT USAGE ON SCHEMA comms TO module_comms;

CREATE TABLE IF NOT EXISTS comms.thread (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  thread_id text NOT NULL CHECK (thread_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  person_ref text CHECK (person_ref IS NULL OR person_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  work_item_ref text NOT NULL CHECK (work_item_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  channel text NOT NULL CHECK (channel = 'sms'),
  purpose text NOT NULL CHECK (purpose IN ('treatment', 'payment', 'operations', 'marketing')),
  owner_ref text CHECK (owner_ref IS NULL OR owner_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  escalated boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('open', 'resolved')),
  resolution_disposition text,
  resolution_evidence_ref text CHECK (
    resolution_evidence_ref IS NULL OR resolution_evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'
  ),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, thread_id),
  CONSTRAINT thread_resolution_complete CHECK (
    (status = 'open' AND resolution_disposition IS NULL AND resolution_evidence_ref IS NULL)
    OR (status = 'resolved' AND resolution_disposition <> '' AND resolution_evidence_ref IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS comms.thread_message (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  message_id text NOT NULL CHECK (message_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  content_ref text NOT NULL CHECK (content_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  vendor_event_key text NOT NULL CHECK (vendor_event_key <> ''),
  effect_key text CHECK (effect_key IS NULL OR effect_key ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  delivery_state text NOT NULL CHECK (delivery_state IN ('unknown', 'accepted', 'delivered', 'failed')),
  holding boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, message_id),
  UNIQUE (tenant_id, vendor_event_key),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES comms.thread (tenant_id, thread_id)
);

CREATE TABLE IF NOT EXISTS comms.delivery_receipt (
  tenant_id text NOT NULL,
  receipt_id text NOT NULL CHECK (receipt_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  message_id text NOT NULL,
  message_vendor_event_key text NOT NULL CHECK (message_vendor_event_key <> ''),
  receipt_event_key text NOT NULL CHECK (receipt_event_key <> ''),
  effect_key text NOT NULL CHECK (effect_key ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'delivered', 'failed', 'unknown')),
  observed_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, receipt_id),
  UNIQUE (tenant_id, receipt_event_key),
  FOREIGN KEY (tenant_id, message_id) REFERENCES comms.thread_message (tenant_id, message_id)
);

CREATE TABLE IF NOT EXISTS comms.holding_task_effect (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  idempotency_key text NOT NULL,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  work_item_ref text NOT NULL CHECK (work_item_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  created_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);

GRANT SELECT, INSERT, UPDATE ON comms.thread TO module_comms;
GRANT SELECT, INSERT ON comms.thread_message, comms.delivery_receipt, comms.holding_task_effect TO module_comms;
REVOKE DELETE ON comms.thread FROM module_comms;
REVOKE UPDATE, DELETE ON comms.thread_message, comms.delivery_receipt FROM module_comms;
REVOKE UPDATE, DELETE ON comms.holding_task_effect FROM module_comms;
GRANT UPDATE (delivery_state) ON comms.thread_message TO module_comms;

ALTER TABLE comms.thread ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.thread FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON comms.thread;
CREATE POLICY tenant_isolation ON comms.thread
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE comms.thread_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.thread_message FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON comms.thread_message;
CREATE POLICY tenant_isolation ON comms.thread_message
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE comms.delivery_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.delivery_receipt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON comms.delivery_receipt;
CREATE POLICY tenant_isolation ON comms.delivery_receipt
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE comms.holding_task_effect ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.holding_task_effect FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON comms.holding_task_effect;
CREATE POLICY tenant_isolation ON comms.holding_task_effect
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

DO $coverage$
DECLARE offender text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO offender
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'comms' AND c.relkind = 'r'
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('delivery_receipt', 'holding_task_effect', 'thread', 'thread_message'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema comms: %', offender;
  END IF;
END
$coverage$;

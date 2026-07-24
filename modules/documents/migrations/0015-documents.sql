-- WP-024 documents migration (M06: content-addressed blob intake + document
-- metadata + wrong-patient quarantine + unmatched-patient queue with a
-- hold-period timer). Contract: docs/contracts/blob-api.md (FROZEN).
-- Requirements: REQ-DOC-006 (quarantine), REQ-DOC-010 (unmatched queue),
-- REQ-DOC-011 (hold-period timer -> destruction/return). Idempotent: safe to
-- re-apply; the DB suite re-applies it as its idempotency proof. Rollback:
-- modules/documents/migrations/0015-documents.rollback.sql.
-- Depends on modules/platform-core/migrations/0001-tenancy.sql (tenant table +
-- practicehub_app role); the migration runner orders module migrations by file
-- number across modules.
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('documents', documentsRlsSpecs, documentsSchemaRlsSpecs);
-- a drift test compares this file against a fresh emission.

CREATE SCHEMA IF NOT EXISTS documents;

-- Module role pattern (ARCHITECTURE: no cross-module table writes, DB-role
-- enforced): documents-schema access grants only through module_documents;
-- practicehub_app (created by 0001-tenancy.sql) receives the module role and
-- owns nothing.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_documents') THEN
    CREATE ROLE module_documents NOLOGIN;
  END IF;
END
$roles$;

GRANT module_documents TO practicehub_app;
GRANT USAGE ON SCHEMA documents TO module_documents;

-- The document lifecycle log (append-only): one row per lifecycle event.
-- Filing a document to a chart attaches PHI to a person, so the spine is
-- event-sourced like every authority/consent/audit surface. Structural rules
-- enforced by CHECK rather than review memory:
--   * a `received` event carries the full intake integrity anchor (source,
--     blob ref, sha-256 content hash, byte count, media type, page count);
--     no other event type carries those columns;
--   * a `quarantined` event carries a reason and the NAMES of observed
--     attributes (never their values — the queue holds no PHI, REQ-DOC-006);
--   * a `filed` event names the matched person and its evidence (authority);
--   * an `auto_match_failed` event carries a hold-until deadline (REQ-DOC-011);
--   * a `disposition_decided` event names its outcome + destruction/return
--     evidence; a `redirected` event names its target;
--   * refs are grammar-checked; free text (and with it raw PHI) has no column.
-- person/document refs are SOFT references (no cross-module FK): documents can
-- concern unmatched or unknown patients, exactly like the audit and consent
-- stores.
CREATE TABLE IF NOT EXISTS documents.document_event (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  document_event_id text NOT NULL CHECK (document_event_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  document_id text NOT NULL CHECK (document_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  event_type text NOT NULL CHECK (
    event_type IN ('received', 'auto_match_failed', 'quarantined', 'filed',
                   'disposition_decided', 'redirected')
  ),
  actor_ref text NOT NULL CHECK (actor_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  source text CHECK (
    source IN ('inbound_fax', 'portal_upload', 'partner_exchange', 'staff_scan', 'api_import')
  ),
  blob_ref text CHECK (blob_ref ~ '^blob://[a-z0-9][a-z0-9-]{0,62}/[0-9a-f]{64}$'),
  content_hash text CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  content_bytes integer CHECK (content_bytes IS NULL OR content_bytes > 0),
  media_type text CHECK (media_type IS NULL OR media_type ~ '^[a-z0-9][a-z0-9.+/-]{0,127}$'),
  page_count integer CHECK (page_count IS NULL OR page_count > 0),
  partition_tags text[] NOT NULL DEFAULT '{}' CHECK (
    partition_tags <@ ARRAY['gipa-genetic', 'chd', 'biometric', 'part2']::text[]
  ),
  hold_until timestamptz,
  matched_person_ref text CHECK (
    matched_person_ref IS NULL OR matched_person_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'
  ),
  quarantine_reason text CHECK (
    quarantine_reason IN ('wrong-patient', 'unknown-patient', 'unsolicited',
                          'no-matching-record', 'suspected-misdirection')
  ),
  observed_attribute_names text[] CHECK (
    observed_attribute_names IS NULL
    OR observed_attribute_names <@ ARRAY['patient-name', 'date-of-birth', 'address',
      'phone', 'mrn', 'ssn-last4', 'member-id', 'sender-fax', 'account-number']::text[]
  ),
  disposition text CHECK (disposition IN ('destroyed', 'returned')),
  redirect_target text CHECK (
    redirect_target IS NULL OR redirect_target ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'
  ),
  evidence_ref text CHECK (evidence_ref IS NULL OR evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  occurred_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, document_event_id),
  CONSTRAINT de_received_carries_intake CHECK (
    (event_type = 'received'
      AND source IS NOT NULL AND blob_ref IS NOT NULL AND content_hash IS NOT NULL
      AND content_bytes IS NOT NULL AND media_type IS NOT NULL AND page_count IS NOT NULL)
    OR
    (event_type <> 'received'
      AND source IS NULL AND blob_ref IS NULL AND content_hash IS NULL
      AND content_bytes IS NULL AND media_type IS NULL AND page_count IS NULL)
  ),
  CONSTRAINT de_quarantine_shape CHECK (
    (event_type = 'quarantined'
      AND quarantine_reason IS NOT NULL
      AND observed_attribute_names IS NOT NULL
      AND array_length(observed_attribute_names, 1) >= 1)
    OR
    (event_type <> 'quarantined'
      AND quarantine_reason IS NULL AND observed_attribute_names IS NULL)
  ),
  CONSTRAINT de_filed_carries_match CHECK (
    (event_type = 'filed' AND matched_person_ref IS NOT NULL AND evidence_ref IS NOT NULL)
    OR (event_type <> 'filed' AND matched_person_ref IS NULL)
  ),
  CONSTRAINT de_unmatched_carries_hold CHECK (
    (event_type = 'auto_match_failed' AND hold_until IS NOT NULL)
    OR (event_type <> 'auto_match_failed' AND hold_until IS NULL)
  ),
  CONSTRAINT de_disposition_shape CHECK (
    (event_type = 'disposition_decided' AND disposition IS NOT NULL AND evidence_ref IS NOT NULL)
    OR (event_type <> 'disposition_decided' AND disposition IS NULL)
  ),
  CONSTRAINT de_redirect_carries_target CHECK (
    (event_type = 'redirected' AND redirect_target IS NOT NULL)
    OR (event_type <> 'redirected' AND redirect_target IS NULL)
  )
);

-- The folded projection: one row per (tenant, document) carrying the resolved
-- status and the intake integrity anchor. Rebuildable at any time by
-- foldDocumentState — a materialized read model, never a second source of
-- truth. last_event_id points at its governing event in the same tenant.
CREATE TABLE IF NOT EXISTS documents.document_state (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  document_id text NOT NULL CHECK (document_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  status text NOT NULL CHECK (
    status IN ('received', 'unmatched', 'quarantined', 'filed', 'disposed', 'redirected')
  ),
  source text NOT NULL CHECK (
    source IN ('inbound_fax', 'portal_upload', 'partner_exchange', 'staff_scan', 'api_import')
  ),
  blob_ref text NOT NULL CHECK (blob_ref ~ '^blob://[a-z0-9][a-z0-9-]{0,62}/[0-9a-f]{64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  content_bytes integer NOT NULL CHECK (content_bytes > 0),
  media_type text NOT NULL CHECK (media_type ~ '^[a-z0-9][a-z0-9.+/-]{0,127}$'),
  page_count integer NOT NULL CHECK (page_count > 0),
  partition_tags text[] NOT NULL DEFAULT '{}' CHECK (
    partition_tags <@ ARRAY['gipa-genetic', 'chd', 'biometric', 'part2']::text[]
  ),
  received_at timestamptz NOT NULL,
  hold_until timestamptz,
  matched_person_ref text CHECK (
    matched_person_ref IS NULL OR matched_person_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'
  ),
  quarantine_reason text CHECK (
    quarantine_reason IN ('wrong-patient', 'unknown-patient', 'unsolicited',
                          'no-matching-record', 'suspected-misdirection')
  ),
  -- The quarantine queue row surfaces the observed attribute NAMES (never their
  -- values) alongside the reason so a reviewer can triage/redirect straight from
  -- the read model without re-reading the event log (contract blob-api.md §3).
  -- Same array-subset CHECK as the event column — a raw value is unrepresentable.
  observed_attribute_names text[] CHECK (
    observed_attribute_names IS NULL
    OR observed_attribute_names <@ ARRAY['patient-name', 'date-of-birth', 'address',
      'phone', 'mrn', 'ssn-last4', 'member-id', 'sender-fax', 'account-number']::text[]
  ),
  disposition text CHECK (disposition IN ('destroyed', 'returned')),
  redirect_target text CHECK (
    redirect_target IS NULL OR redirect_target ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'
  ),
  last_event_id text NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, document_id),
  CONSTRAINT ds_status_shape CHECK (
    (status <> 'unmatched' OR hold_until IS NOT NULL)
    AND (status <> 'quarantined' OR (quarantine_reason IS NOT NULL
         AND observed_attribute_names IS NOT NULL
         AND array_length(observed_attribute_names, 1) >= 1))
    AND (status <> 'filed' OR matched_person_ref IS NOT NULL)
    AND (status <> 'disposed' OR disposition IS NOT NULL)
    AND (status <> 'redirected' OR redirect_target IS NOT NULL)
  ),
  CONSTRAINT ds_last_event_same_tenant
    FOREIGN KEY (tenant_id, last_event_id)
    REFERENCES documents.document_event (tenant_id, document_event_id)
);

-- Deterministic grants for this migration's tables.
GRANT SELECT, INSERT ON documents.document_event TO module_documents;
GRANT SELECT, INSERT, UPDATE ON documents.document_state TO module_documents;

-- Append-only posture: the lifecycle log cannot be edited or deleted by any app
-- role (corrections are new events). The projection folds forward — it never
-- deletes. Re-asserted on every pass.
REVOKE UPDATE, DELETE ON documents.document_event FROM module_documents;
REVOKE DELETE ON documents.document_state FROM module_documents;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE documents.document_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents.document_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON documents.document_event;
CREATE POLICY tenant_isolation ON documents.document_event
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE documents.document_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents.document_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON documents.document_state;
CREATE POLICY tenant_isolation ON documents.document_state
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
   WHERE n.nspname = 'documents'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('document_event', 'document_state'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema documents: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end

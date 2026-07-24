-- WP-025 documents-records migration (M06: document versioning + supersession,
-- e-sign artifacts, partition/PDP-scoped full-text search, and records-request
-- disclosure accounting with the closure invariant). Contract:
-- docs/contracts/records-search-api.md (FROZEN). Requirements: REQ-DOC-002
-- (lawful records request with disclosure proof), REQ-DOC-003 (patient
-- correction without erasing the source), REQ-DOC-013 (scope selection +
-- disclosure accounting), REQ-DOC-016 (subpoena/audit export with scope limits).
-- Idempotent: safe to re-apply; the DB suite re-applies it as its idempotency
-- proof. Rollback: modules/documents/migrations/0016-documents-records.rollback.sql.
-- Depends on 0015-documents.sql (schema documents + module_documents role) and
-- 0001-tenancy.sql (tenant table + practicehub_app). The migration runner orders
-- module migrations by file number across modules.
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('documents', documentsRecordsRlsSpecs,
-- documentsSchemaRlsSpecs); a drift test compares this file against a fresh
-- emission, and 0015's coverage guard lists the full schema table set too.

CREATE SCHEMA IF NOT EXISTS documents;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_documents') THEN
    CREATE ROLE module_documents NOLOGIN;
  END IF;
END
$roles$;

GRANT module_documents TO practicehub_app;
GRANT USAGE ON SCHEMA documents TO module_documents;

-- The document VERSION log (append-only): one row per version of a document.
-- Versioning supersedes, never overwrites (ADR-010 Decision 3, HIPAA §164.526):
-- a correction/amendment is a NEW row that marks the prior head superseded; the
-- source version's row is preserved and never edited. A denied correction lands
-- a statement-of-disagreement that supersedes NOTHING (the source stands).
-- document_id is a SOFT reference (a records artifact may be born as a version);
-- integrity is content-addressed (blob_ref embeds the sha-256 content_hash).
-- Structural rules enforced by CHECK, not review memory:
--   * original is version 1 and supersedes nothing;
--   * amendment/correction/esign-execution supersede the current head;
--   * a correction carries its reason; a statement-of-disagreement names the
--     version it concerns and supersedes nothing;
--   * an esign-execution carries a complete signature evidence chain (signers,
--     method, certificate hash, signed instant) and no other kind carries any
--     esign column (transmission is not closure — only a signed outcome lands).
CREATE TABLE IF NOT EXISTS documents.document_version (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  version_event_id text NOT NULL CHECK (version_event_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  document_id text NOT NULL CHECK (document_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  version_no integer NOT NULL CHECK (version_no >= 1),
  kind text NOT NULL CHECK (
    kind IN ('original', 'amendment', 'correction', 'statement-of-disagreement', 'esign-execution')
  ),
  blob_ref text NOT NULL CHECK (blob_ref ~ '^blob://[a-z0-9][a-z0-9-]{0,62}/[0-9a-f]{64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  content_bytes integer NOT NULL CHECK (content_bytes > 0),
  media_type text NOT NULL CHECK (media_type ~ '^[a-z0-9][a-z0-9.+/-]{0,127}$'),
  supersedes_version_no integer CHECK (supersedes_version_no IS NULL OR supersedes_version_no >= 1),
  concerns_version_no integer CHECK (concerns_version_no IS NULL OR concerns_version_no >= 1),
  reason_ref text CHECK (reason_ref IS NULL OR reason_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  esign_signer_refs text[],
  esign_method text CHECK (
    esign_method IN ('click-to-sign', 'drawn-signature', 'typed-signature', 'knowledge-based')
  ),
  esign_certificate_hash text CHECK (esign_certificate_hash IS NULL OR esign_certificate_hash ~ '^[0-9a-f]{64}$'),
  esign_signed_at timestamptz,
  esign_evidence_ref text CHECK (esign_evidence_ref IS NULL OR esign_evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  actor_ref text NOT NULL CHECK (actor_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  occurred_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, version_event_id),
  UNIQUE (tenant_id, document_id, version_no),
  CONSTRAINT dv_content_addressed CHECK (blob_ref = 'blob://documents/' || content_hash),
  CONSTRAINT dv_original_shape CHECK (
    kind <> 'original'
    OR (version_no = 1 AND supersedes_version_no IS NULL)
  ),
  CONSTRAINT dv_superseding_shape CHECK (
    kind NOT IN ('amendment', 'correction', 'esign-execution')
    OR (supersedes_version_no IS NOT NULL AND version_no > supersedes_version_no)
  ),
  CONSTRAINT dv_correction_reason CHECK (kind <> 'correction' OR reason_ref IS NOT NULL),
  CONSTRAINT dv_disagreement_shape CHECK (
    kind <> 'statement-of-disagreement'
    OR (supersedes_version_no IS NULL AND concerns_version_no IS NOT NULL)
  ),
  CONSTRAINT dv_esign_shape CHECK (
    (kind = 'esign-execution'
      AND esign_signer_refs IS NOT NULL AND array_length(esign_signer_refs, 1) >= 1
      AND esign_method IS NOT NULL AND esign_certificate_hash IS NOT NULL
      AND esign_signed_at IS NOT NULL)
    OR
    (kind <> 'esign-execution'
      AND esign_signer_refs IS NULL AND esign_method IS NULL
      AND esign_certificate_hash IS NULL AND esign_signed_at IS NULL
      AND esign_evidence_ref IS NULL)
  )
);

-- The full-text SEARCH index (ADR-010 Decision 4: Postgres FTS, no Elastic).
-- The tsvector is built from NON-PHI descriptor tokens only — a document type
-- label and curated provenance terms; raw PHI never enters the index by
-- construction (the term columns are grammar-checked to lower-case labels).
-- Search is scoped by tenant (RLS), by partition-tag clearance (a caller must
-- hold EVERY partition tag a row carries — a genetic row is invisible without
-- genetic clearance), and by PDP data segment (minimum-necessary).
CREATE TABLE IF NOT EXISTS documents.document_search_index (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  document_id text NOT NULL CHECK (document_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  version_no integer NOT NULL CHECK (version_no >= 1),
  doc_type text NOT NULL CHECK (doc_type ~ '^[a-z0-9][a-z0-9 .:_-]{0,255}$'),
  search_terms text NOT NULL CHECK (search_terms ~ '^[a-z0-9][a-z0-9 .:_-]{0,255}$'),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english', doc_type || ' ' || search_terms)
  ) STORED,
  partition_tags text[] NOT NULL DEFAULT '{}' CHECK (
    partition_tags <@ ARRAY['gipa-genetic', 'chd', 'biometric', 'part2']::text[]
  ),
  segments text[] NOT NULL CHECK (
    array_length(segments, 1) >= 1
    AND segments <@ ARRAY['clinical', 'billing', 'administrative', 'correspondence', 'consent']::text[]
  ),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, document_id, version_no)
);

CREATE INDEX IF NOT EXISTS document_search_index_vector
  ON documents.document_search_index USING gin (search_vector);

-- The records-DISCLOSURE accounting log (R6 disclosure-accounting class): one
-- row per lawful records disclosure. The accounting is the disclosure proof
-- (REQ-DOC-002): what was released, what was excluded by scope limits
-- (REQ-DOC-016) and by the send-time genetic re-check, to whom, for what
-- purpose. Transmission is NOT closure — a disclosure lands `transmitted` and
-- reaches `closed-with-evidence` only when delivery/outcome evidence arrives
-- (CDX closure invariant). Append-oriented: the row is inserted once and only
-- its closure columns update; DELETE is revoked.
CREATE TABLE IF NOT EXISTS documents.records_disclosure (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  disclosure_id text NOT NULL CHECK (disclosure_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  subject_person_ref text NOT NULL CHECK (subject_person_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  recipient_ref text NOT NULL CHECK (recipient_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  purpose text NOT NULL CHECK (
    purpose IN ('patient-request', 'treatment', 'payment', 'operations', 'legal-obligation', 'subpoena-audit')
  ),
  requested_by text NOT NULL CHECK (requested_by ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  included_artifact_refs text[] NOT NULL,
  excluded_out_of_scope_refs text[] NOT NULL DEFAULT '{}',
  excluded_genetic_refs text[] NOT NULL DEFAULT '{}',
  genetic_authorization_ref text CHECK (
    genetic_authorization_ref IS NULL OR genetic_authorization_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'
  ),
  genetic_written_evidence_ref text CHECK (
    genetic_written_evidence_ref IS NULL OR genetic_written_evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'
  ),
  disclosed_at timestamptz NOT NULL,
  closure_status text NOT NULL CHECK (closure_status IN ('transmitted', 'closed-with-evidence')),
  closure_evidence_ref text CHECK (
    closure_evidence_ref IS NULL OR closure_evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'
  ),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, disclosure_id),
  CONSTRAINT rd_closure_shape CHECK (
    (closure_status = 'closed-with-evidence' AND closure_evidence_ref IS NOT NULL)
    OR (closure_status = 'transmitted' AND closure_evidence_ref IS NULL)
  ),
  CONSTRAINT rd_genetic_pair CHECK (
    (genetic_authorization_ref IS NULL) = (genetic_written_evidence_ref IS NULL)
  )
);

-- Deterministic grants for this migration's tables.
GRANT SELECT, INSERT ON documents.document_version TO module_documents;
GRANT SELECT, INSERT, UPDATE ON documents.document_search_index TO module_documents;
GRANT SELECT, INSERT, UPDATE ON documents.records_disclosure TO module_documents;

-- Append-only posture: the version log is never edited or deleted. Supersession
-- is a NEW row (its supersedes_version_no names the prior head); whether a
-- version is superseded or current is COMPUTED from the log, never stored, so
-- there is no flag to mutate. The search index folds forward; the disclosure
-- row is inserted once and only its closure columns update. DELETE never.
REVOKE UPDATE, DELETE ON documents.document_version FROM module_documents;
REVOKE DELETE ON documents.document_search_index FROM module_documents;
REVOKE DELETE ON documents.records_disclosure FROM module_documents;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE documents.document_search_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents.document_search_index FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON documents.document_search_index;
CREATE POLICY tenant_isolation ON documents.document_search_index
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE documents.document_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents.document_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON documents.document_version;
CREATE POLICY tenant_isolation ON documents.document_version
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE documents.records_disclosure ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents.records_disclosure FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON documents.records_disclosure;
CREATE POLICY tenant_isolation ON documents.records_disclosure
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
          OR c.relname NOT IN ('document_event', 'document_search_index', 'document_state', 'document_version', 'records_disclosure'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema documents: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end

-- Rollback for 0015-documents.sql (WP-024). The document lifecycle log is
-- append-only evidence: rolling the MODULE back drops the scaffolding in
-- dependency order (the projection references the event log). The package
-- rollback expectation is bucket-lifecycle — the object-store blobs a live
-- module wrote are exported/expired under the retention policy before any drop
-- in a real rollback; synthetic-only data here (the in-memory blob store is
-- process-scoped, so nothing persists past teardown).
DROP TABLE IF EXISTS documents.document_state;
DROP TABLE IF EXISTS documents.document_event;
DROP SCHEMA IF EXISTS documents;
-- The module role stays (other databases may share it); revoke its grant.
REVOKE module_documents FROM practicehub_app;

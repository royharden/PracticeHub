-- Rollback for 0016-documents-records.sql (WP-025). Version-safe: dropping the
-- records feature removes ONLY the three tables this migration created and
-- leaves the WP-024 intake spine (document_event/document_state) and the
-- schema in place. Document versions are preserved records — a real rollback
-- exports/expires their blobs under the retention policy before any drop; the
-- synthetic in-memory blob store here is process-scoped, so nothing persists
-- past teardown. Order: the disclosure/search/version tables have no FK to one
-- another, so any order is safe; dropped alphabetically for determinism.
DROP TABLE IF EXISTS documents.document_search_index;
DROP TABLE IF EXISTS documents.document_version;
DROP TABLE IF EXISTS documents.records_disclosure;
-- 0015's coverage guard now lists the full five-table set; after this rollback
-- re-apply 0015 (which recreates its two tables and re-asserts the guard over
-- whatever remains) or roll 0015 back too. The schema and module role stay.

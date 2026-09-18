-- Unapplied companion for 0047-vintage-import.sql. Not executed in this increment.
DROP TABLE IF EXISTS vintage_import.rehearsal_batch;
DROP TABLE IF EXISTS vintage_import.finding;
DROP TABLE IF EXISTS vintage_import.source_snapshot;
DROP SCHEMA IF EXISTS vintage_import;
REVOKE module_vintage_import FROM practicehub_app;
DROP ROLE IF EXISTS module_vintage_import;

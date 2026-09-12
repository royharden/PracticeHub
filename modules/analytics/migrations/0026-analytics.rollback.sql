-- Rollback for 0026-analytics.sql. Synthetic projection data is disposable;
-- production retention/export policy must run before applying this rollback.
DROP TABLE IF EXISTS analytics.projection_export_receipt;
DROP TABLE IF EXISTS analytics.projection_disclosure;
DROP TABLE IF EXISTS analytics.projection_event;
DROP TABLE IF EXISTS analytics.projection_source_offset;
DROP TABLE IF EXISTS analytics.projection_cell;
DROP TABLE IF EXISTS analytics.projection_version;
DROP TABLE IF EXISTS analytics.metric_definition;
DROP SCHEMA IF EXISTS analytics;
DROP ROLE IF EXISTS module_analytics;

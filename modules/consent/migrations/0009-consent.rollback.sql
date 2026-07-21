-- Rollback for 0009-consent.sql (WP-018). The consent ledger is append-only
-- evidence: rolling the MODULE back drops the scaffolding in dependency order
-- (the projection references the event log). The package rollback expectation
-- is event-sourced (append-only); consent captured while the module was live
-- is exported before any drop in a real rollback — synthetic-only data here.
DROP TABLE IF EXISTS consent.consent_state;
DROP TABLE IF EXISTS consent.consent_event;
DROP SCHEMA IF EXISTS consent;
-- The module role stays (other databases may share it); revoke its grant.
REVOKE module_consent FROM practicehub_app;

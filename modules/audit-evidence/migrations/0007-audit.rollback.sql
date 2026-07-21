-- Rollback for 0007-audit.sql (WP-020). The audit store is append-only
-- evidence: rolling the MODULE back drops the scaffolding in dependency
-- order; the package rollback expectation is append-only (evidence produced
-- while the module was live is exported before any drop in a real rollback —
-- synthetic-only data here).
DROP TABLE IF EXISTS audit_evidence.destruction_evidence;
DROP TABLE IF EXISTS audit_evidence.legal_hold;
DROP TABLE IF EXISTS audit_evidence.retention_schedule;
DROP TABLE IF EXISTS audit_evidence.audit_event;
DROP SCHEMA IF EXISTS audit_evidence;
-- The module role stays (other databases may share it); revoke its grant.
REVOKE module_audit_evidence FROM practicehub_app;

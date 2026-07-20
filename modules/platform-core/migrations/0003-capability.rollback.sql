-- WP-012 rollback: remove the capability-registry tables. The event log is the
-- registry's own reversibility mechanism (replay); dropping the tables is the
-- schema-level rollback for the package itself.
DROP TABLE IF EXISTS platform_core.capability_grant;
DROP TABLE IF EXISTS platform_core.capability_event;

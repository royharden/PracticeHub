-- Rollback for 0010-events.sql (WP-021). The outbox is append-only integration
-- evidence; the package rollback expectation is drain+rebuild (drain the queue,
-- then rebuild the projection from the event log). Rolling the MODULE back drops
-- the scaffolding in dependency order (inbox and the delivery projection
-- reference the outbox). Undrained events are exported before any drop in a real
-- rollback — synthetic-only data here.
DROP TABLE IF EXISTS events.inbox;
DROP TABLE IF EXISTS events.outbox_delivery;
DROP TABLE IF EXISTS events.outbox;
DROP SCHEMA IF EXISTS events;
-- The module role stays (other databases may share it); revoke its grant.
REVOKE module_events FROM practicehub_app;

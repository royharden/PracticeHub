-- Rollback for 0012-workitems.sql (WP-022). The work-item event log is
-- append-only accountability evidence; the package rollback expectation is queue
-- drain (drain the worklist / reassign owned work, then rebuild the projections
-- from the event log). Rolling the tasking tables back drops them in dependency
-- order (the projections and the event log reference work_item). Undrained work
-- items are exported before any drop in a real rollback — synthetic-only here.
-- The event spine tables (0010) and the events schema/role are left intact.
DROP TABLE IF EXISTS events.sla_timer;
DROP TABLE IF EXISTS events.work_item_event;
DROP TABLE IF EXISTS events.work_item;
DROP TABLE IF EXISTS events.sla_policy;

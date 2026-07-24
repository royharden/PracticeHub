-- Rollback for 0014-oncall.sql (WP-023). The package rollback expectation is
-- "schedule data": the on-call rotation registry is versioned config and the
-- coverage handoff is append-only accountability evidence. Rolling back drops the
-- on-call/coverage tables (no cross-dependencies among them). The tasking tables
-- (0012), the event spine (0010), and the events schema/role are left intact —
-- coverage moves drove events.work_item through the WP-022 store, they added no
-- column to it. Undrained coverage plans and open gap alerts are exported before
-- any drop in a real rollback — synthetic-only here.
DROP TABLE IF EXISTS events.coverage_handoff;
DROP TABLE IF EXISTS events.coverage_gap_alert;
DROP TABLE IF EXISTS events.coverage_window;
DROP TABLE IF EXISTS events.on_call_slot;
DROP TABLE IF EXISTS events.on_call_rotation;

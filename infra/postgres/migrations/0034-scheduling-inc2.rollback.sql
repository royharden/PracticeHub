REVOKE UPDATE ON TABLE sched.resource_reservation FROM module_scheduling;
REVOKE SELECT ON TABLE sched.inc2_resource_catalog FROM module_scheduling;
REVOKE SELECT ON TABLE sched.inc2_waitlist_pause FROM module_scheduling;
REVOKE SELECT ON TABLE sched.inc2_manager_exception FROM module_scheduling;
DROP TABLE IF EXISTS sched.inc2_manager_exception;
DROP TABLE IF EXISTS sched.inc2_waitlist_pause;
DROP TABLE IF EXISTS sched.inc2_resource_catalog;

REVOKE EXECUTE ON FUNCTION sched.lock_reservation_subjects(text,jsonb) FROM module_scheduling;
REVOKE EXECUTE ON FUNCTION sched.assert_reservation_completeness(text,text,text)
  FROM module_scheduling;
REVOKE EXECUTE ON FUNCTION sched.expire_hold(text,text,timestamptz) FROM module_scheduling;
REVOKE EXECUTE ON FUNCTION sched.reconcile_effect(text,text,jsonb) FROM module_scheduling;
REVOKE EXECUTE ON FUNCTION sched.complete_effect(text,text,text,jsonb) FROM module_scheduling;
REVOKE EXECUTE ON FUNCTION sched.mark_effect_indeterminate(text,text) FROM module_scheduling;
REVOKE EXECUTE ON FUNCTION sched.begin_effect(text,text,text,text,text,bigint,bigint,boolean,text,text,text[],tstzrange)
  FROM module_scheduling;
DROP FUNCTION IF EXISTS sched.check_reservation_completeness() CASCADE;
DROP FUNCTION IF EXISTS sched.assert_reservation_completeness(text,text,text);
DROP FUNCTION IF EXISTS sched.validate_reservation_binding() CASCADE;
DROP FUNCTION IF EXISTS sched.lock_reservation_subjects(text,jsonb);
DROP FUNCTION IF EXISTS sched.expire_hold(text,text,timestamptz);
DROP FUNCTION IF EXISTS sched.reconcile_effect(text,text,jsonb);
DROP FUNCTION IF EXISTS sched.complete_effect(text,text,text,jsonb);
DROP FUNCTION IF EXISTS sched.mark_effect_indeterminate(text,text);
DROP FUNCTION IF EXISTS sched.begin_effect(text,text,text,text,text,bigint,bigint,boolean,text,text,text[],tstzrange);
DROP TABLE IF EXISTS sched.outbox;
DROP TABLE IF EXISTS sched.reconciliation_case;
DROP TABLE IF EXISTS sched.waitlist_offer;
DROP TABLE IF EXISTS sched.waitlist_entry;
DROP TABLE IF EXISTS sched.booking_receipt;
DROP TABLE IF EXISTS sched.resource_reservation;
DROP TABLE IF EXISTS sched.appointment;
DROP TABLE IF EXISTS sched.slot_hold;
DROP TABLE IF EXISTS sched.slot_offer;
DROP TABLE IF EXISTS sched.command_effect_scope;
DROP TABLE IF EXISTS sched.command_effect;
DROP TABLE IF EXISTS sched.policy_snapshot;
DROP TABLE IF EXISTS sched.resource;
DROP TABLE IF EXISTS sched.constraint_bundle;
DROP SCHEMA IF EXISTS sched;
REVOKE module_scheduling FROM practicehub_app;
DROP ROLE IF EXISTS module_scheduling;

-- btree_gist is shared infrastructure and is intentionally not dropped.

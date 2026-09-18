export const APP_ROLE_WRITE_PATH = {
  role: 'module_scheduling',
  lockFunction: 'sched.lock_reservation_subjects',
  table: 'sched.resource_reservation',
  grant: 'UPDATE',
  migration: 'infra/postgres/migrations/0034-scheduling-inc2.sql',
  nr: 'NR-074',
  fwd: 'FWD-SCH-040-APP-ROLE-WRITE-PATH',
} as const;

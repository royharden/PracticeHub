import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../../infra/postgres/migrations/0032-scheduling.sql', import.meta.url),
  'utf8',
);
const rollback = readFileSync(
  new URL('../../../infra/postgres/migrations/0032-scheduling.rollback.sql', import.meta.url),
  'utf8',
);

describe('0032 scheduling migration contract', () => {
  it('uses structural finite half-open exclusions without location partitioning', () => {
    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS btree_gist');
    expect(migration).toContain('EXCLUDE USING gist');
    expect(migration).toContain('subject_kind WITH =');
    expect(migration).toContain('subject_id WITH =');
    expect(migration).toContain('reservation_range WITH &&');
    expect(migration).toContain("WHERE (state IN ('held','booked'))");
    expect(migration).not.toMatch(/location_id WITH =/);
    expect(migration).toContain('NOT lower_inf(reservation_range)');
    expect(migration).toContain('NOT upper_inf(reservation_range)');
    expect(migration).toContain('lower_inc(reservation_range)');
    expect(migration).toContain('NOT upper_inc(reservation_range)');
    expect(migration).toContain('isfinite(lower(reservation_range))');
    expect(migration).toContain('isfinite(upper(reservation_range))');
  });

  it('changes hold and reservation expiry in one function and forces RLS', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION sched.expire_hold');
    expect(migration).toContain("SET state = 'expired'");
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("current_setting(''practicehub.tenant_id'', true)");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION sched.lock_reservation_subjects');
    expect(migration).toContain("ORDER BY value->>'kind', value->>'id'");
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('ORDER BY reservation_id FOR UPDATE');
    expect(migration).toContain('reservation_set_incomplete');
    expect(migration).toContain('reservation_parent_binding_mismatch');
    expect(migration).toContain('CREATE TABLE sched.command_effect');
    expect(migration).toContain('CREATE TABLE sched.command_effect_scope');
    expect(migration).toContain("state IN ('pending','complete','indeterminate','reconciled')");
    expect(migration).toContain("state IN ('pending','indeterminate','closed')");
    expect(migration).toContain("RAISE EXCEPTION 'hold_tenant_scope_mismatch'");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION sched.complete_effect');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION sched.reconcile_effect');
    expect(migration).toContain("parent_state = 'converted'");
  });

  it('provides rollback coverage for every scheduling table', () => {
    for (const table of [
      'outbox',
      'reconciliation_case',
      'waitlist_offer',
      'waitlist_entry',
      'booking_receipt',
      'resource_reservation',
      'appointment',
      'slot_hold',
      'slot_offer',
      'command_effect',
      'command_effect_scope',
      'policy_snapshot',
      'resource',
      'constraint_bundle',
    ]) {
      expect(rollback).toContain(`DROP TABLE IF EXISTS sched.${table}`);
    }
    expect(rollback).toContain('REVOKE module_scheduling FROM practicehub_app');
    expect(rollback).toContain('DROP ROLE IF EXISTS module_scheduling');
  });
});

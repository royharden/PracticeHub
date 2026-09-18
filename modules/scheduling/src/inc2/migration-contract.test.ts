import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../../../infra/postgres/migrations/0034-scheduling-inc2.sql', import.meta.url),
  'utf8',
);
const rollback = readFileSync(
  new URL(
    '../../../../infra/postgres/migrations/0034-scheduling-inc2.rollback.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('0034 scheduling increment-2 migration contract', () => {
  it('is re-runnable and grants the app-role UPDATE path without rewriting 0032', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS sched.inc2_resource_catalog');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS sched.inc2_waitlist_pause');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS sched.inc2_manager_exception');
    expect(migration).toContain(
      'GRANT UPDATE ON TABLE sched.resource_reservation TO module_scheduling',
    );
    expect(migration).not.toContain('CREATE TABLE sched.');
    expect(migration).not.toContain('tools/local-tools');
    expect(migration).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
  });

  it('rolls back only increment-2 objects and the UPDATE grant', () => {
    expect(rollback).toContain('DROP TABLE IF EXISTS sched.inc2_manager_exception');
    expect(rollback).toContain('DROP TABLE IF EXISTS sched.inc2_waitlist_pause');
    expect(rollback).toContain('DROP TABLE IF EXISTS sched.inc2_resource_catalog');
    expect(rollback).toContain(
      'REVOKE UPDATE ON TABLE sched.resource_reservation FROM module_scheduling',
    );
    expect(rollback).not.toContain('DROP SCHEMA');
    expect(rollback).not.toContain('DROP ROLE');
  });
});

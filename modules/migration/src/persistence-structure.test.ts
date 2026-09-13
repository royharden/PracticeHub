import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  fileURLToPath(new URL('../migrations/0027-migration.sql', import.meta.url)),
  'utf8',
);
const seedSql = readFileSync(
  fileURLToPath(new URL('../../../infra/postgres/seed/028-migration-seed.sql', import.meta.url)),
  'utf8',
);

const stageTables = [
  'mapping_version',
  'source_manifest',
  'batch_event',
  'batch_state',
  'validation_run',
  'validation_finding',
  'control_total',
];

describe('effect-free persistence boundary', () => {
  it('creates and writes only migration staging tables', () => {
    const created = [
      ...migrationSql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+\.[a-z_]+)/g),
    ].map((match) => match[1]);
    expect(created.sort()).toEqual(stageTables.map((table) => `migration.${table}`).sort());
    const seeded = [...seedSql.matchAll(/INSERT INTO\s+([a-z_]+\.[a-z_]+)/g)].map(
      (match) => match[1],
    );
    expect(new Set(seeded)).toEqual(
      new Set([
        'migration.mapping_version',
        'migration.source_manifest',
        'migration.batch_event',
        'migration.validation_run',
        'migration.control_total',
        'migration.batch_state',
      ]),
    );
  });

  it('forces RLS on every stage table and structurally fixes target writes at zero', () => {
    for (const table of stageTables) {
      expect(migrationSql).toContain(`ALTER TABLE migration.${table} FORCE ROW LEVEL SECURITY;`);
    }
    expect(migrationSql).toContain('CHECK (target_data_writes = 0)');
  });

  it('grants no wave-import capability', () => {
    expect(seedSql).not.toMatch(/capability_(event|grant)/);
    expect(seedSql).not.toContain('migration.wave-import');
  });
});

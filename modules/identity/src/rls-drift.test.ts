/**
 * Drift gates for the identity migration (WP-013): the committed generated
 * RLS section must byte-match a fresh emission from the WP-010 generator,
 * every identity table must be declared, and the append-only REVOKE on the
 * timeline must stay present in the migration text (probed by the DB suite
 * live).
 */
import { readFileSync } from 'node:fs';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { identityRlsSpecs } from './rls-specs.js';

const migrationSql = readFileSync(
  new URL('../migrations/0004-identity.sql', import.meta.url),
  'utf8',
);

describe('identity RLS drift gate', () => {
  it('0004-identity.sql embeds exactly the generated section', () => {
    const embedded = extractRlsMigrationSection(migrationSql);
    expect(embedded).toBe(renderRlsMigrationSection('identity', identityRlsSpecs));
  });

  it('every CREATE TABLE in the migration is declared in the spec registry', () => {
    const created = [...migrationSql.matchAll(/CREATE TABLE IF NOT EXISTS identity\.(\w+)/g)]
      .map((match) => match[1])
      .sort();
    const declared = identityRlsSpecs.map((spec) => spec.table).sort();
    expect(created).toEqual(declared);
  });

  it('all identity tables are tenant-scoped — no platform-global exemptions in this schema', () => {
    expect(identityRlsSpecs.every((spec) => spec.kind === 'tenant-scoped')).toBe(true);
  });

  it('the timeline append-only REVOKE is present', () => {
    expect(migrationSql).toContain(
      'REVOKE UPDATE, DELETE ON identity.identity_timeline FROM module_identity;',
    );
  });
});

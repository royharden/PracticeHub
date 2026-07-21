/**
 * Drift gates for the identity migrations (WP-013 + WP-014): each committed
 * generated RLS section must byte-match a fresh emission from the WP-010
 * generator — 0004 emits DDL for its own tables with the SCHEMA-WIDE coverage
 * guard, 0005 likewise (the WP-011 guard-vs-DDL split, so re-applying an
 * early migration after a later one stays clean while an undeclared table
 * still raises). Every table must be declared, and the append-only REVOKE on
 * the timeline must stay present in BOTH migrations (0005 re-runs the
 * schema-wide GRANT, so it re-asserts the posture; probed live by the DB
 * suite).
 */
import { readFileSync } from 'node:fs';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { authnRlsSpecs, identityRlsSpecs, identitySchemaRlsSpecs } from './rls-specs.js';

const identityMigrationSql = readFileSync(
  new URL('../migrations/0004-identity.sql', import.meta.url),
  'utf8',
);
const authnMigrationSql = readFileSync(
  new URL('../migrations/0005-authn.sql', import.meta.url),
  'utf8',
);

describe('identity RLS drift gate', () => {
  it('0004-identity.sql embeds exactly the generated section (schema-wide guard)', () => {
    const embedded = extractRlsMigrationSection(identityMigrationSql);
    expect(embedded).toBe(
      renderRlsMigrationSection('identity', identityRlsSpecs, identitySchemaRlsSpecs),
    );
  });

  it('0005-authn.sql embeds exactly the generated section (schema-wide guard)', () => {
    const embedded = extractRlsMigrationSection(authnMigrationSql);
    expect(embedded).toBe(
      renderRlsMigrationSection('identity', authnRlsSpecs, identitySchemaRlsSpecs),
    );
  });

  it('every CREATE TABLE in 0004 is declared in its DDL-scope registry', () => {
    const created = [
      ...identityMigrationSql.matchAll(/CREATE TABLE IF NOT EXISTS identity\.(\w+)/g),
    ]
      .map((match) => match[1])
      .sort();
    const declared = identityRlsSpecs.map((spec) => spec.table).sort();
    expect(created).toEqual(declared);
  });

  it('every CREATE TABLE in 0005 is declared in its DDL-scope registry', () => {
    const created = [...authnMigrationSql.matchAll(/CREATE TABLE IF NOT EXISTS identity\.(\w+)/g)]
      .map((match) => match[1])
      .sort();
    const declared = authnRlsSpecs.map((spec) => spec.table).sort();
    expect(created).toEqual(declared);
  });

  it('the schema-wide registry is exactly the union of both DDL scopes', () => {
    expect(identitySchemaRlsSpecs.map((spec) => spec.table).sort()).toEqual(
      [...identityRlsSpecs, ...authnRlsSpecs].map((spec) => spec.table).sort(),
    );
  });

  it('all identity tables are tenant-scoped — no platform-global exemptions in this schema', () => {
    expect(identitySchemaRlsSpecs.every((spec) => spec.kind === 'tenant-scoped')).toBe(true);
  });

  it('the timeline append-only REVOKE is present in both migrations', () => {
    for (const sql of [identityMigrationSql, authnMigrationSql]) {
      expect(sql).toContain(
        'REVOKE UPDATE, DELETE ON identity.identity_timeline FROM module_identity;',
      );
    }
  });
});

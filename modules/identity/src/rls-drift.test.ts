/**
 * Drift gates for the identity migrations (WP-013 + WP-014 + WP-016): each
 * committed generated RLS section must byte-match a fresh emission from the
 * WP-010 generator — every migration emits DDL for its own tables with the
 * SCHEMA-WIDE coverage guard (the WP-011 guard-vs-DDL split, so re-applying
 * an early migration after a later one stays clean while an undeclared table
 * still raises). Every table must be declared, and the append-only postures
 * must survive every migration's GRANT pass: the timeline REVOKE stays in
 * 0004/0005, the merge-table REVOKEs stay in 0006 AND (conditionally) in
 * 0004/0005 whose schema-wide GRANT would otherwise re-open them on re-apply
 * (probed live by the DB suite).
 */
import { readFileSync } from 'node:fs';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import {
  authnRlsSpecs,
  identityRlsSpecs,
  identitySchemaRlsSpecs,
  mergeRlsSpecs,
} from './rls-specs.js';

const identityMigrationSql = readFileSync(
  new URL('../migrations/0004-identity.sql', import.meta.url),
  'utf8',
);
const authnMigrationSql = readFileSync(
  new URL('../migrations/0005-authn.sql', import.meta.url),
  'utf8',
);
const mergeMigrationSql = readFileSync(
  new URL('../migrations/0006-merge.sql', import.meta.url),
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

  it('0006-merge.sql embeds exactly the generated section (schema-wide guard)', () => {
    const embedded = extractRlsMigrationSection(mergeMigrationSql);
    expect(embedded).toBe(
      renderRlsMigrationSection('identity', mergeRlsSpecs, identitySchemaRlsSpecs),
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

  it('every CREATE TABLE in 0006 is declared in its DDL-scope registry', () => {
    const created = [...mergeMigrationSql.matchAll(/CREATE TABLE IF NOT EXISTS identity\.(\w+)/g)]
      .map((match) => match[1])
      .sort();
    const declared = mergeRlsSpecs.map((spec) => spec.table).sort();
    expect(created).toEqual(declared);
  });

  it('the schema-wide registry is exactly the union of all three DDL scopes', () => {
    expect(identitySchemaRlsSpecs.map((spec) => spec.table).sort()).toEqual(
      [...identityRlsSpecs, ...authnRlsSpecs, ...mergeRlsSpecs].map((spec) => spec.table).sort(),
    );
  });

  it('all identity tables are tenant-scoped — no platform-global exemptions in this schema', () => {
    expect(identitySchemaRlsSpecs.every((spec) => spec.kind === 'tenant-scoped')).toBe(true);
  });

  it('the timeline append-only REVOKE is present in both schema-wide-GRANT migrations', () => {
    for (const sql of [identityMigrationSql, authnMigrationSql]) {
      expect(sql).toContain(
        'REVOKE UPDATE, DELETE ON identity.identity_timeline FROM module_identity;',
      );
    }
  });

  it('0006 asserts the merge append-only postures directly', () => {
    expect(mergeMigrationSql).toContain(
      'REVOKE UPDATE, DELETE ON identity.merge_event FROM module_identity;',
    );
    expect(mergeMigrationSql).toContain(
      'REVOKE UPDATE, DELETE ON identity.merge_lineage FROM module_identity;',
    );
    expect(mergeMigrationSql).toContain(
      'REVOKE DELETE ON identity.merge_case FROM module_identity;',
    );
    expect(mergeMigrationSql).toContain(
      'REVOKE DELETE ON identity.merge_case_person FROM module_identity;',
    );
  });

  it('0004 and 0005 conditionally re-assert the merge postures their GRANT would re-open', () => {
    for (const sql of [identityMigrationSql, authnMigrationSql]) {
      for (const table of ['merge_event', 'merge_lineage', 'merge_case', 'merge_case_person']) {
        expect(sql, `conditional re-REVOKE for identity.${table}`).toContain(
          `IF to_regclass('identity.${table}') IS NOT NULL THEN`,
        );
      }
      expect(sql).toContain('REVOKE UPDATE, DELETE ON identity.merge_event FROM module_identity;');
      expect(sql).toContain(
        'REVOKE UPDATE, DELETE ON identity.merge_lineage FROM module_identity;',
      );
      expect(sql).toContain('REVOKE DELETE ON identity.merge_case FROM module_identity;');
      expect(sql).toContain('REVOKE DELETE ON identity.merge_case_person FROM module_identity;');
    }
  });
});

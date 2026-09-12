import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { breachCaseRlsSpecs, breachCaseSchemaRlsSpecs } from './rls-specs.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('0030-breach-case.sql RLS drift gate', () => {
  it('embeds the exact generated RLS and coverage-guard section', () => {
    const migration = readFileSync(
      `${repoRoot}modules/breach-case/migrations/0030-breach-case.sql`,
      'utf8',
    );
    expect(extractRlsMigrationSection(migration)).toBe(
      renderRlsMigrationSection('breach_case', breachCaseRlsSpecs, breachCaseSchemaRlsSpecs),
    );
  });

  it('declares every breach-case table in the schema-wide guard', () => {
    expect(new Set(breachCaseSchemaRlsSpecs.map((spec) => spec.table))).toEqual(
      new Set(breachCaseRlsSpecs.map((spec) => spec.table)),
    );
  });
});

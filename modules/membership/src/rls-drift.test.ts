import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { membershipRlsSpecs } from './rls-specs.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
describe('0038 membership RLS drift', () => {
  it('embeds the exact generated tenant-RLS section and coverage guard', () => {
    const migration = readFileSync(
      `${root}modules/membership/migrations/0038-membership.sql`,
      'utf8',
    );
    expect(extractRlsMigrationSection(migration)).toBe(
      renderRlsMigrationSection('membership', membershipRlsSpecs, membershipRlsSpecs),
    );
  });
});

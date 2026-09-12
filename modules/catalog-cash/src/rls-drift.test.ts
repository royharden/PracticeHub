import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { catalogCashRlsSpecs } from './rls-specs.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
describe('0021 catalog-cash RLS drift', () => {
  it('embeds the exact generated tenant-RLS section and coverage guard', () => {
    const migration = readFileSync(
      `${root}modules/catalog-cash/migrations/0021-paid-service.sql`,
      'utf8',
    );
    expect(extractRlsMigrationSection(migration)).toBe(
      renderRlsMigrationSection('catalog_cash', catalogCashRlsSpecs, catalogCashRlsSpecs),
    );
  });
});

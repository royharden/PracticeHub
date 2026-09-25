import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { catalogCoreRlsSpecs, catalogGfeRlsSpecs, catalogRlsSpecs } from './rls-specs.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
describe('0037 catalog RLS drift', () => {
  it('embeds the exact generated tenant-RLS section and coverage guard', () => {
    const migration = readFileSync(`${root}modules/catalog/migrations/0037-catalog.sql`, 'utf8');
    expect(extractRlsMigrationSection(migration)).toBe(
      renderRlsMigrationSection('catalog', catalogCoreRlsSpecs, catalogRlsSpecs),
    );
  });
});

describe('0061 catalog GFE RLS drift', () => {
  it('embeds the exact generated tenant-RLS section and coverage guard', () => {
    const migration = readFileSync(
      `${root}modules/catalog/migrations/0061-wp051-catalog-gfe.sql`,
      'utf8',
    );
    expect(extractRlsMigrationSection(migration)).toBe(
      renderRlsMigrationSection('catalog', catalogGfeRlsSpecs, catalogRlsSpecs),
    );
  });
});

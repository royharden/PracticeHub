import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { vintageImportRlsSpecs } from './rls-specs.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
describe('0047 vintage-import RLS drift', () => {
  it('embeds the exact generated tenant-RLS section and coverage guard', () => {
    const migration = readFileSync(
      `${root}modules/vintage-import/migrations/0047-vintage-import.sql`,
      'utf8',
    );
    expect(extractRlsMigrationSection(migration)).toBe(
      renderRlsMigrationSection('vintage_import', vintageImportRlsSpecs, vintageImportRlsSpecs),
    );
  });
});

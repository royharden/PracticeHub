import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { labs0064RlsSpecs, labs0065RlsSpecs, labsSchemaRlsSpecs } from './rls-specs.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));

describe('labs RLS drift', () => {
  it('embeds the generated tenant-RLS section for 0064 and 0065', () => {
    const migration64 = readFileSync(`${root}modules/labs/migrations/0064-labs.sql`, 'utf8');
    const migration65 = readFileSync(`${root}modules/labs/migrations/0065-labs-device.sql`, 'utf8');
    expect(extractRlsMigrationSection(migration64)).toBe(
      renderRlsMigrationSection('labs', labs0064RlsSpecs, labsSchemaRlsSpecs),
    );
    expect(extractRlsMigrationSection(migration65)).toBe(
      renderRlsMigrationSection('labs', labs0065RlsSpecs, labsSchemaRlsSpecs),
    );
  });
});

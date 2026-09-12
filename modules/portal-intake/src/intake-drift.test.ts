import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { portalIntakeRlsSpecs } from './rls-specs.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('0024 portal-intake migration drift', () => {
  it('embeds the exact generated forced-RLS section for every table', () => {
    const migration = readFileSync(
      `${repoRoot}modules/portal-intake/migrations/0024-portal-intake.sql`,
      'utf8',
    );
    expect(extractRlsMigrationSection(migration)).toBe(
      renderRlsMigrationSection('portal_intake', portalIntakeRlsSpecs),
    );
  });

  it('contains no storage column for upload bytes or observed attribute values', () => {
    const migration = readFileSync(
      `${repoRoot}modules/portal-intake/migrations/0024-portal-intake.sql`,
      'utf8',
    );
    expect(migration).not.toMatch(/\b(bytea|raw_value|observed_value|upload_bytes)\b/i);
    expect(migration).toMatch(/collection_consent_precedes_health/);
  });
});

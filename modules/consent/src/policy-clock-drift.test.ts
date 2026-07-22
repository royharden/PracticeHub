/**
 * Drift gates (WP-019): the 0011 migration embeds EXACTLY the generated RLS
 * section; the 0009 migration's schema-wide coverage guard now spans all six
 * consent tables (regenerated via its sanctioned mechanism — the DDL is
 * untouched); the guard registry declares every DDL-scope table; and the
 * committed seed embeds EXACTLY the generated policy/clock seed section.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { consentRlsSpecs, consentSchemaRlsSpecs, policyClockRlsSpecs } from './rls-specs.js';
import {
  extractPolicyClockSeedSection,
  renderPolicyClockSeedSection,
  syntheticPolicyClockSeedV1,
} from './policy-clock-seed.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('0011-policy-clocks.sql RLS drift gate', () => {
  it('embeds exactly the generated section', () => {
    const migration = readFileSync(
      `${repoRoot}modules/consent/migrations/0011-policy-clocks.sql`,
      'utf8',
    );
    const embedded = extractRlsMigrationSection(migration);
    expect(embedded).toBe(
      renderRlsMigrationSection('consent', policyClockRlsSpecs, consentSchemaRlsSpecs),
    );
  });

  it('the schema-wide guard registry declares every DDL-scope table', () => {
    const guardTables = new Set(
      consentSchemaRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`),
    );
    for (const spec of policyClockRlsSpecs) {
      expect(guardTables.has(`${spec.schema}.${spec.table}`)).toBe(true);
    }
  });
});

describe('0009-consent.sql RLS drift gate (schema-wide guard regenerated)', () => {
  it('embeds exactly the generated section spanning the full consent schema', () => {
    const migration = readFileSync(
      `${repoRoot}modules/consent/migrations/0009-consent.sql`,
      'utf8',
    );
    const embedded = extractRlsMigrationSection(migration);
    expect(embedded).toBe(
      renderRlsMigrationSection('consent', consentRlsSpecs, consentSchemaRlsSpecs),
    );
  });

  it('the guard now spans all six consent tables', () => {
    expect(consentSchemaRlsSpecs).toHaveLength(6);
  });
});

describe('013-policy-clocks-seed.sql drift gate', () => {
  it('embeds exactly the generated section', () => {
    const seed = readFileSync(`${repoRoot}infra/postgres/seed/013-policy-clocks-seed.sql`, 'utf8');
    const embedded = extractPolicyClockSeedSection(seed);
    expect(embedded).toBe(renderPolicyClockSeedSection(syntheticPolicyClockSeedV1));
  });

  it('the seeded clock projection carries a governing event that exists in the log', () => {
    const eventIds = new Set(
      syntheticPolicyClockSeedV1.events.map((event) => `${event.tenantId}|${event.clockEventId}`),
    );
    for (const instance of syntheticPolicyClockSeedV1.instances) {
      expect(eventIds.has(`${instance.tenantId}|${instance.lastEventId}`)).toBe(true);
    }
  });
});

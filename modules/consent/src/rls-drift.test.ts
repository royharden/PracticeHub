/**
 * Drift gates (WP-018): the committed migration embeds EXACTLY the generated
 * RLS section; the guard registry declares every DDL-scope table; the committed
 * seed file embeds EXACTLY the generated consent seed section; and the seeded
 * projection equals the fold of the seeded event log before it ever reaches a
 * database.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { foldConsentState } from './consent.js';
import { consentRlsSpecs, consentSchemaRlsSpecs } from './rls-specs.js';
import {
  extractConsentSeedSection,
  renderConsentSeedSection,
  syntheticConsentSeedV1,
} from './seed-data.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('0009-consent.sql RLS drift gate', () => {
  it('embeds exactly the generated section', () => {
    const migration = readFileSync(
      `${repoRoot}modules/consent/migrations/0009-consent.sql`,
      'utf8',
    );
    const embedded = extractRlsMigrationSection(migration);
    expect(embedded).toBe(
      renderRlsMigrationSection('consent', consentRlsSpecs, consentSchemaRlsSpecs),
    );
  });

  it('the schema-wide guard registry declares every DDL-scope table', () => {
    const guardTables = new Set(
      consentSchemaRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`),
    );
    for (const spec of consentRlsSpecs) {
      expect(guardTables.has(`${spec.schema}.${spec.table}`)).toBe(true);
    }
  });
});

describe('011-consent-seed.sql drift gate', () => {
  it('embeds exactly the generated section', () => {
    const seed = readFileSync(`${repoRoot}infra/postgres/seed/011-consent-seed.sql`, 'utf8');
    const embedded = extractConsentSeedSection(seed);
    expect(embedded).toBe(renderConsentSeedSection(syntheticConsentSeedV1));
  });

  it('the seeded projection is exactly the fold of the seeded event log (per tenant)', () => {
    const byTenant = new Map<string, (typeof syntheticConsentSeedV1.records)[number][]>();
    for (const record of syntheticConsentSeedV1.records) {
      const bucket = byTenant.get(record.tenantId) ?? [];
      bucket.push(record);
      byTenant.set(record.tenantId, bucket);
    }
    const folded = new Map<string, string>();
    for (const bucket of byTenant.values()) {
      for (const row of foldConsentState(bucket).values()) {
        folded.set(`${row.tenantId}|${row.personRef}|${row.scopeKey}`, row.currentState);
      }
    }
    expect(syntheticConsentSeedV1.projection.length).toBe(folded.size);
    for (const row of syntheticConsentSeedV1.projection) {
      expect(folded.get(`${row.tenantId}|${row.personRef}|${row.scopeKey}`)).toBe(row.currentState);
    }
  });
});

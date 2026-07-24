/**
 * Drift gates (WP-026): the committed 0017 migration embeds EXACTLY the
 * generated RLS section; the guard registry declares every DDL-scope table; and
 * the committed 019 seed embeds EXACTLY the generated vendor-registry section
 * (the lifecycle log, the folded projection, the licenses, and the egress feed).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { platformIntegrationSchemaRlsSpecs, vendorRegistryRlsSpecs } from './rls-specs.js';
import {
  extractVendorRegistrySeedSection,
  renderVendorRegistrySeedSection,
  syntheticVendorRegistrySeedV1,
} from './seed-data.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('0017-vendor-registry.sql RLS drift gate', () => {
  it('embeds exactly the generated section', () => {
    const migration = readFileSync(
      `${repoRoot}modules/platform-integration/migrations/0017-vendor-registry.sql`,
      'utf8',
    );
    const embedded = extractRlsMigrationSection(migration);
    expect(embedded).toBe(
      renderRlsMigrationSection(
        'platform_integration',
        vendorRegistryRlsSpecs,
        platformIntegrationSchemaRlsSpecs,
      ),
    );
  });

  it('the schema-wide guard registry declares every DDL-scope table', () => {
    const guardTables = new Set(
      platformIntegrationSchemaRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`),
    );
    for (const spec of vendorRegistryRlsSpecs) {
      expect(guardTables.has(`${spec.schema}.${spec.table}`)).toBe(true);
    }
  });
});

describe('019-vendor-registry-seed.sql drift gate', () => {
  it('embeds exactly the generated section', () => {
    const seed = readFileSync(
      `${repoRoot}infra/postgres/seed/019-vendor-registry-seed.sql`,
      'utf8',
    );
    const embedded = extractVendorRegistrySeedSection(seed);
    expect(embedded).toBe(renderVendorRegistrySeedSection(syntheticVendorRegistrySeedV1));
  });

  it('the lapsed vendor folds to suspended and the AI-uncovered vendor lacks its no-training clause', () => {
    const lapsed = syntheticVendorRegistrySeedV1.events.filter(
      (event) => event.vendorId === 'synthetic-lapsed-vendor',
    );
    expect(lapsed.at(-1)?.kind).toBe('baa-lapsed');
    const uncovered = syntheticVendorRegistrySeedV1.events.find(
      (event) => event.vendorId === 'synthetic-ai-uncovered' && event.kind === 'baa-executed',
    );
    expect(uncovered?.noTrainingOnPhi).toBe(false);
  });
});

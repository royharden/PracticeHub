/**
 * Drift gates (WP-021): the committed migration embeds EXACTLY the generated
 * RLS section; the guard registry declares every DDL-scope table; and the
 * committed seed file embeds EXACTLY the generated events seed section (the
 * outbox envelopes, the delivery projection, and the inbox dedup rows).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { eventsRlsSpecs, eventsSchemaRlsSpecs } from './rls-specs.js';
import {
  extractEventsSeedSection,
  renderEventsSeedSection,
  syntheticEventsSeedV1,
} from './seed-data.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('0010-events.sql RLS drift gate', () => {
  it('embeds exactly the generated section', () => {
    const migration = readFileSync(`${repoRoot}modules/events/migrations/0010-events.sql`, 'utf8');
    const embedded = extractRlsMigrationSection(migration);
    expect(embedded).toBe(
      renderRlsMigrationSection('events', eventsRlsSpecs, eventsSchemaRlsSpecs),
    );
  });

  it('the schema-wide guard registry declares every DDL-scope table', () => {
    const guardTables = new Set(eventsSchemaRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`));
    for (const spec of eventsRlsSpecs) {
      expect(guardTables.has(`${spec.schema}.${spec.table}`)).toBe(true);
    }
  });
});

describe('012-events-seed.sql drift gate', () => {
  it('embeds exactly the generated section', () => {
    const seed = readFileSync(`${repoRoot}infra/postgres/seed/012-events-seed.sql`, 'utf8');
    const embedded = extractEventsSeedSection(seed);
    expect(embedded).toBe(renderEventsSeedSection(syntheticEventsSeedV1));
  });

  it('every published seed delivery carries a published_at and a pending one does not', () => {
    for (const record of syntheticEventsSeedV1.records) {
      if (record.deliveryStatus === 'published') {
        expect(record.publishedAt).not.toBeNull();
      } else {
        expect(record.publishedAt).toBeNull();
      }
    }
  });
});

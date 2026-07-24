/**
 * Drift gates (WP-024): the committed migration embeds EXACTLY the generated
 * RLS section; the guard registry declares every DDL-scope table; the committed
 * seed file embeds EXACTLY the generated documents seed section; and the seeded
 * projection equals the fold of the seeded event log before it ever reaches a
 * database.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { foldDocumentState } from './document.js';
import { documentsRlsSpecs, documentsSchemaRlsSpecs } from './rls-specs.js';
import {
  extractDocumentsSeedSection,
  renderDocumentsSeedSection,
  syntheticDocumentsSeedV1,
} from './seed-data.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('0015-documents.sql RLS drift gate', () => {
  it('embeds exactly the generated section', () => {
    const migration = readFileSync(
      `${repoRoot}modules/documents/migrations/0015-documents.sql`,
      'utf8',
    );
    const embedded = extractRlsMigrationSection(migration);
    expect(embedded).toBe(
      renderRlsMigrationSection('documents', documentsRlsSpecs, documentsSchemaRlsSpecs),
    );
  });

  it('the schema-wide guard registry declares every DDL-scope table', () => {
    const guardTables = new Set(
      documentsSchemaRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`),
    );
    for (const spec of documentsRlsSpecs) {
      expect(guardTables.has(`${spec.schema}.${spec.table}`)).toBe(true);
    }
  });
});

describe('017-documents-seed.sql drift gate', () => {
  it('embeds exactly the generated section', () => {
    const seed = readFileSync(`${repoRoot}infra/postgres/seed/017-documents-seed.sql`, 'utf8');
    const embedded = extractDocumentsSeedSection(seed);
    expect(embedded).toBe(renderDocumentsSeedSection(syntheticDocumentsSeedV1));
  });

  it('the seeded projection is exactly the fold of the seeded event log', () => {
    const folded = foldDocumentState(syntheticDocumentsSeedV1.records);
    expect(syntheticDocumentsSeedV1.projection.length).toBe(folded.size);
    for (const row of syntheticDocumentsSeedV1.projection) {
      const foldedRow = folded.get(`${row.tenantId}|${row.documentId}`);
      expect(foldedRow?.status).toBe(row.status);
      expect(foldedRow?.lastEventId).toBe(row.lastEventId);
      expect(foldedRow?.contentHash).toBe(row.contentHash);
    }
  });
});

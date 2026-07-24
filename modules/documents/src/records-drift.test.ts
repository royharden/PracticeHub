/**
 * Drift gates (WP-025): the 0016 migration embeds EXACTLY the generated RLS
 * section (DDL for its three tables + a coverage guard over the FULL five-table
 * schema set); the schema-wide guard registry declares every DDL-scope table of
 * both migrations; the committed 018 seed file embeds EXACTLY the generated
 * records seed section; and the seeded version fold preserves every source
 * version (the correction lineage before it ever reaches a database).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { currentVersion, versionLineage } from './records.js';
import {
  documentsRecordsRlsSpecs,
  documentsRlsSpecs,
  documentsSchemaRlsSpecs,
} from './rls-specs.js';
import {
  extractDocumentsRecordsSeedSection,
  renderDocumentsRecordsSeedSection,
  syntheticDocumentsRecordsSeedV1,
} from './records-seed.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('0016-documents-records.sql RLS drift gate', () => {
  it('embeds exactly the generated section (DDL for its tables + full-schema guard)', () => {
    const migration = readFileSync(
      `${repoRoot}modules/documents/migrations/0016-documents-records.sql`,
      'utf8',
    );
    const embedded = extractRlsMigrationSection(migration);
    expect(embedded).toBe(
      renderRlsMigrationSection('documents', documentsRecordsRlsSpecs, documentsSchemaRlsSpecs),
    );
  });

  it('0015 embeds the full-schema coverage guard too (re-applying it after 0016 stays clean)', () => {
    const migration = readFileSync(
      `${repoRoot}modules/documents/migrations/0015-documents.sql`,
      'utf8',
    );
    const embedded = extractRlsMigrationSection(migration);
    expect(embedded).toBe(
      renderRlsMigrationSection('documents', documentsRlsSpecs, documentsSchemaRlsSpecs),
    );
  });

  it('the schema-wide guard registry declares every DDL-scope table of both migrations', () => {
    const guardTables = new Set(
      documentsSchemaRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`),
    );
    for (const spec of [...documentsRlsSpecs, ...documentsRecordsRlsSpecs]) {
      expect(guardTables.has(`${spec.schema}.${spec.table}`)).toBe(true);
    }
  });
});

describe('018-documents-records-seed.sql drift gate', () => {
  it('embeds exactly the generated section', () => {
    const seed = readFileSync(
      `${repoRoot}infra/postgres/seed/018-documents-records-seed.sql`,
      'utf8',
    );
    const embedded = extractDocumentsRecordsSeedSection(seed);
    expect(embedded).toBe(renderDocumentsRecordsSeedSection(syntheticDocumentsRecordsSeedV1));
  });

  it('the seeded correction lineage preserves the source and makes the correction current', () => {
    const { versions } = syntheticDocumentsRecordsSeedV1;
    const lineage = versionLineage(versions, 'northwind-synthetic', 'nd-0001');
    expect(lineage.map((v) => v.versionNo)).toEqual([1, 2]);
    expect(currentVersion(lineage)?.kind).toBe('correction');
    // the denied-correction document keeps its source current (disagreement stands beside)
    expect(
      currentVersion(versionLineage(versions, 'northwind-synthetic', 'nd-0005'))?.versionNo,
    ).toBe(1);
  });
});

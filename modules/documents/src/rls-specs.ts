/**
 * RLS table registry for the `documents` schema (WP-024), consumed by the
 * WP-010 generator. Both tables are tenant-scoped: a document belongs to one
 * tenant, and an unbound session must read zero rows (fail-closed). The
 * generated section embedded in migrations/0015-documents.sql is drift-tested
 * against a fresh emission. This schema has one migration, so its DDL scope and
 * its schema-wide guard list are identical.
 */

import type { RlsTableSpec } from '@practicehub/platform-core';

/** Tables created by 0015-documents.sql — that migration's DDL scope. */
export const documentsRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'documents', table: 'document_event', kind: 'tenant-scoped' },
  { schema: 'documents', table: 'document_state', kind: 'tenant-scoped' },
];

/** The full documents-schema registry — every migration's guard declares it. */
export const documentsSchemaRlsSpecs: readonly RlsTableSpec[] = [...documentsRlsSpecs];

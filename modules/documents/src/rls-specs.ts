/**
 * RLS table registry for the `documents` schema, consumed by the WP-010
 * generator. Every table is tenant-scoped: a document belongs to one tenant,
 * and an unbound session must read zero rows (fail-closed). Each migration
 * embeds a generated RLS section that a drift test compares against a fresh
 * emission for that migration's DDL scope; the schema-wide guard list is the
 * union of every migration's tables (the coverage guard in the LAST migration
 * declares the full set).
 *
 * - WP-024 (0015): document_event, document_state (intake spine).
 * - WP-025 (0016): document_version (versioning/e-sign), document_search_index
 *   (scoped FTS), records_disclosure (records request + disclosure accounting).
 */

import type { RlsTableSpec } from '@practicehub/platform-core';

/** Tables created by 0015-documents.sql — that migration's DDL scope. */
export const documentsRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'documents', table: 'document_event', kind: 'tenant-scoped' },
  { schema: 'documents', table: 'document_state', kind: 'tenant-scoped' },
];

/** Tables created by 0016-documents-records.sql (WP-025) — that migration's DDL scope. */
export const documentsRecordsRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'documents', table: 'document_version', kind: 'tenant-scoped' },
  { schema: 'documents', table: 'document_search_index', kind: 'tenant-scoped' },
  { schema: 'documents', table: 'records_disclosure', kind: 'tenant-scoped' },
];

/** The full documents-schema registry — the last migration's guard declares it. */
export const documentsSchemaRlsSpecs: readonly RlsTableSpec[] = [
  ...documentsRlsSpecs,
  ...documentsRecordsRlsSpecs,
];

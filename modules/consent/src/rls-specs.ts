/**
 * RLS table registry for the `consent` schema (WP-018), consumed by the WP-010
 * generator. Both tables are tenant-scoped: consent is always per-tenant, and
 * an unbound session must read zero rows (fail-closed). The generated section
 * embedded in migrations/0009-consent.sql is drift-tested against a fresh
 * emission.
 */

import type { RlsTableSpec } from '@practicehub/platform-core';

/** Tables created by 0009-consent.sql — that migration's DDL scope. */
export const consentRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'consent', table: 'consent_event', kind: 'tenant-scoped' },
  { schema: 'consent', table: 'consent_state', kind: 'tenant-scoped' },
];

/** The full consent-schema registry — every migration's guard declares it. */
export const consentSchemaRlsSpecs: readonly RlsTableSpec[] = [...consentRlsSpecs];

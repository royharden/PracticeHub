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

/** Tables created by 0011-policy-clocks.sql (WP-019) — that migration's DDL scope. */
export const policyClockRlsSpecs: readonly RlsTableSpec[] = [
  {
    schema: 'consent',
    table: 'obligation_clock_policy',
    kind: 'platform-global',
    justification:
      'Counsel-owned statutory clock-duration reference (breach/access/renewal/statute-tracker); ' +
      'law is tenant-independent, like the jurisdiction rule packs (ADR-007 D4, C-05)',
  },
  { schema: 'consent', table: 'policy_document', kind: 'tenant-scoped' },
  { schema: 'consent', table: 'obligation_clock', kind: 'tenant-scoped' },
  { schema: 'consent', table: 'obligation_clock_event', kind: 'tenant-scoped' },
];

/** The full consent-schema registry — every migration's guard declares it. */
export const consentSchemaRlsSpecs: readonly RlsTableSpec[] = [
  ...consentRlsSpecs,
  ...policyClockRlsSpecs,
];

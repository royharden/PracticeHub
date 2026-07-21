/**
 * RLS table registry for the `audit_evidence` schema (WP-020), consumed by
 * the WP-010 generator. Audit rows are tenant-scoped; the retention schedule
 * is counsel-owned reference data (platform-global with justification, like
 * the jurisdiction registry). The generated section embedded in
 * migrations/0007-audit.sql is drift-tested against a fresh emission.
 */

import type { RlsTableSpec } from '@practicehub/platform-core';

/** Tables created by 0007-audit.sql — that migration's DDL scope. */
export const auditEvidenceRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'audit_evidence', table: 'audit_event', kind: 'tenant-scoped' },
  {
    schema: 'audit_evidence',
    table: 'retention_schedule',
    kind: 'platform-global',
    justification:
      'Counsel-owned retention reference data; clocks are tenant-independent statutory content ' +
      '(ADR-008 Decision 4, R6-SR-080)',
  },
  { schema: 'audit_evidence', table: 'legal_hold', kind: 'tenant-scoped' },
  { schema: 'audit_evidence', table: 'destruction_evidence', kind: 'tenant-scoped' },
];

/** The full audit_evidence-schema registry — every migration's guard declares it. */
export const auditEvidenceSchemaRlsSpecs: readonly RlsTableSpec[] = [...auditEvidenceRlsSpecs];

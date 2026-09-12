import type { RlsTableSpec } from '@practicehub/platform-core';

export const breachCaseRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'breach_case', table: 'affected_scope_version', kind: 'tenant-scoped' },
  { schema: 'breach_case', table: 'affected_subject', kind: 'tenant-scoped' },
  { schema: 'breach_case', table: 'breach_case', kind: 'tenant-scoped' },
  { schema: 'breach_case', table: 'breach_case_event', kind: 'tenant-scoped' },
  { schema: 'breach_case', table: 'effect_fence', kind: 'tenant-scoped' },
  { schema: 'breach_case', table: 'factor_assessment', kind: 'tenant-scoped' },
  { schema: 'breach_case', table: 'genetic_targeted_review', kind: 'tenant-scoped' },
  { schema: 'breach_case', table: 'jurisdiction_duty', kind: 'tenant-scoped' },
  { schema: 'breach_case', table: 'notification_evidence', kind: 'tenant-scoped' },
];

export const breachCaseSchemaRlsSpecs: readonly RlsTableSpec[] = [...breachCaseRlsSpecs];

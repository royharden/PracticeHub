import type { RlsTableSpec } from '@practicehub/platform-core';

export const portalIntakeRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'portal_intake', table: 'intake_definition', kind: 'tenant-scoped' },
  { schema: 'portal_intake', table: 'intake_event', kind: 'tenant-scoped' },
  { schema: 'portal_intake', table: 'intake_submission', kind: 'tenant-scoped' },
  { schema: 'portal_intake', table: 'intake_answer', kind: 'tenant-scoped' },
  { schema: 'portal_intake', table: 'intake_attachment', kind: 'tenant-scoped' },
  { schema: 'portal_intake', table: 'intake_attempt', kind: 'tenant-scoped' },
];

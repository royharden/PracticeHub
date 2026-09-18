import type { RlsTableSpec } from '@practicehub/platform-core';

export const membershipRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'membership', table: 'account', kind: 'tenant-scoped' },
  { schema: 'membership', table: 'vintage', kind: 'tenant-scoped' },
  { schema: 'membership', table: 'lifecycle_event', kind: 'tenant-scoped' },
];

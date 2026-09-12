import type { RlsTableSpec } from '@practicehub/platform-core';

export const entitlementRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'membership_entitlements', table: 'entitlement_event', kind: 'tenant-scoped' },
];

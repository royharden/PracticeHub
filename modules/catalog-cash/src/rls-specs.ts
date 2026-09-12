import type { RlsTableSpec } from '@practicehub/platform-core';

export const catalogCashRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'catalog_cash', table: 'catalog_offer', kind: 'tenant-scoped' },
  { schema: 'catalog_cash', table: 'paid_service_attempt', kind: 'tenant-scoped' },
  { schema: 'catalog_cash', table: 'paid_service_order', kind: 'tenant-scoped' },
  { schema: 'catalog_cash', table: 'fulfillment_event', kind: 'tenant-scoped' },
];

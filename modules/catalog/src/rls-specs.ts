import type { RlsTableSpec } from '@practicehub/platform-core';

export const catalogCoreRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'catalog', table: 'coverage_flag', kind: 'tenant-scoped' },
  { schema: 'catalog', table: 'signed_coverage_table', kind: 'tenant-scoped' },
  { schema: 'catalog', table: 'component_map', kind: 'tenant-scoped' },
  { schema: 'catalog', table: 'catalog_offer', kind: 'tenant-scoped' },
];

export const catalogGfeRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'catalog', table: 'fee_schedule_rate', kind: 'tenant-scoped' },
  { schema: 'catalog', table: 'gfe_line', kind: 'tenant-scoped' },
  { schema: 'catalog', table: 'good_faith_estimate', kind: 'tenant-scoped' },
];

export const catalogRlsSpecs: readonly RlsTableSpec[] = [
  ...catalogCoreRlsSpecs,
  ...catalogGfeRlsSpecs,
];

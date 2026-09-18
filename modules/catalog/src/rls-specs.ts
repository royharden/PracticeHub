import type { RlsTableSpec } from '@practicehub/platform-core';

export const catalogRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'catalog', table: 'coverage_flag', kind: 'tenant-scoped' },
  { schema: 'catalog', table: 'signed_coverage_table', kind: 'tenant-scoped' },
  { schema: 'catalog', table: 'component_map', kind: 'tenant-scoped' },
  { schema: 'catalog', table: 'catalog_offer', kind: 'tenant-scoped' },
];

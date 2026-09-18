import type { RlsTableSpec } from '@practicehub/platform-core';

export const vintageImportRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'vintage_import', table: 'source_snapshot', kind: 'tenant-scoped' },
  { schema: 'vintage_import', table: 'finding', kind: 'tenant-scoped' },
  { schema: 'vintage_import', table: 'rehearsal_batch', kind: 'tenant-scoped' },
];

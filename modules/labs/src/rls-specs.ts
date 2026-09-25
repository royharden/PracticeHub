import type { RlsTableSpec } from '@practicehub/platform-core';

export const labsSchemaRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'labs', table: 'critical_closure', kind: 'tenant-scoped' },
  { schema: 'labs', table: 'device_calibration', kind: 'tenant-scoped' },
  { schema: 'labs', table: 'device_recall', kind: 'tenant-scoped' },
  { schema: 'labs', table: 'expected_result_age', kind: 'tenant-scoped' },
  { schema: 'labs', table: 'lab_order', kind: 'tenant-scoped' },
  { schema: 'labs', table: 'lab_result', kind: 'tenant-scoped' },
];

export const labs0064RlsSpecs: readonly RlsTableSpec[] = labsSchemaRlsSpecs.filter(
  (spec) => spec.table !== 'device_calibration' && spec.table !== 'device_recall',
);

export const labs0065RlsSpecs: readonly RlsTableSpec[] = labsSchemaRlsSpecs.filter(
  (spec) => spec.table === 'device_calibration' || spec.table === 'device_recall',
);

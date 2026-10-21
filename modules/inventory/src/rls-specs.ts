import type { RlsTableSpec } from '@practicehub/platform-core';

/** Immutable 0066 epoch: never extend this list with forward tables. */
export const inventoryHistoricalRlsSpecs: readonly RlsTableSpec[] = [
  'dispense',
  'dispense_unit',
  'lot',
  'product',
  'recall_unit',
  'unit',
].map((table) => ({ schema: 'inventory', table, kind: 'tenant-scoped' }));
export const inventoryRecallRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'inventory', table: 'lot_recall_event', kind: 'tenant-scoped' },
];
export const inventoryRlsSpecs: readonly RlsTableSpec[] = [
  ...inventoryHistoricalRlsSpecs,
  ...inventoryRecallRlsSpecs,
];

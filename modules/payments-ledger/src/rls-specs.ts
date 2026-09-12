import type { RlsTableSpec } from '@practicehub/platform-core';

export const paymentsLedgerRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'payments_ledger', table: 'payment_intent', kind: 'tenant-scoped' },
  { schema: 'payments_ledger', table: 'journal', kind: 'tenant-scoped' },
  { schema: 'payments_ledger', table: 'journal_line', kind: 'tenant-scoped' },
];

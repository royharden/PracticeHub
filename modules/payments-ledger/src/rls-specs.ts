import type { RlsTableSpec } from '@practicehub/platform-core';

export const paymentsLedgerRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'payments_ledger', table: 'payment_intent', kind: 'tenant-scoped' },
  { schema: 'payments_ledger', table: 'journal', kind: 'tenant-scoped' },
  { schema: 'payments_ledger', table: 'journal_line', kind: 'tenant-scoped' },
];

/** Tables created by 0021-ledger-v2.sql (WP-056). */
export const paymentsLedgerV2RlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'payments_ledger', table: 'write_off', kind: 'tenant-scoped' },
  { schema: 'payments_ledger', table: 'payout_drift_work_item', kind: 'tenant-scoped' },
];

/** Tables created by 0022-statements.sql (WP-057). */
export const paymentsLedgerStatementRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'payments_ledger', table: 'statement', kind: 'tenant-scoped' },
  { schema: 'payments_ledger', table: 'dunning_account', kind: 'tenant-scoped' },
  { schema: 'payments_ledger', table: 'credit_balance_clock', kind: 'tenant-scoped' },
];

/** Full schema registry. Every payments_ledger migration's coverage guard names these tables. */
export const paymentsLedgerSchemaRlsSpecs: readonly RlsTableSpec[] = [
  ...paymentsLedgerRlsSpecs,
  ...paymentsLedgerV2RlsSpecs,
  ...paymentsLedgerStatementRlsSpecs,
];

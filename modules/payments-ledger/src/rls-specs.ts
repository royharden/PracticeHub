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

/** Tables created by 0070-oig-exception-report.sql (WP-095 rework 1). */
export const paymentsLedgerOigRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'payments_ledger', table: 'oig_exception_report', kind: 'tenant-scoped' },
];

/** Immutable pre-0070 epoch: the original 0019/0021/0022 coverage contract. */
export const paymentsLedgerHistoricalRlsSpecs: readonly RlsTableSpec[] = [
  ...paymentsLedgerRlsSpecs,
  ...paymentsLedgerV2RlsSpecs,
  ...paymentsLedgerStatementRlsSpecs,
];

/** Current schema from 0070 onward; shares the historical table definitions. */
export const paymentsLedgerSchemaRlsSpecs: readonly RlsTableSpec[] = [
  ...paymentsLedgerHistoricalRlsSpecs,
  ...paymentsLedgerOigRlsSpecs,
];

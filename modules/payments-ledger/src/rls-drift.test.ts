import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import {
  paymentsLedgerRlsSpecs,
  paymentsLedgerSchemaRlsSpecs,
  paymentsLedgerStatementRlsSpecs,
  paymentsLedgerV2RlsSpecs,
} from './rls-specs.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
describe('0019 payments-ledger RLS drift', () => {
  it('embeds the exact generated tenant-RLS section and coverage guard', () => {
    const migration = readFileSync(
      `${root}modules/payments-ledger/migrations/0019-cash-ledger.sql`,
      'utf8',
    );
    expect(extractRlsMigrationSection(migration)).toBe(
      renderRlsMigrationSection(
        'payments_ledger',
        paymentsLedgerRlsSpecs,
        paymentsLedgerSchemaRlsSpecs,
      ),
    );
  });
});

describe('0021 payments-ledger RLS drift', () => {
  it('embeds the exact generated tenant-RLS section and coverage guard', () => {
    const migration = readFileSync(
      `${root}modules/payments-ledger/migrations/0021-ledger-v2.sql`,
      'utf8',
    );
    expect(extractRlsMigrationSection(migration)).toBe(
      renderRlsMigrationSection(
        'payments_ledger',
        paymentsLedgerV2RlsSpecs,
        paymentsLedgerSchemaRlsSpecs,
      ),
    );
  });
});

describe('0022 payments-ledger RLS drift', () => {
  it('embeds the exact generated tenant-RLS section and coverage guard', () => {
    const migration = readFileSync(
      `${root}modules/payments-ledger/migrations/0022-statements.sql`,
      'utf8',
    );
    expect(extractRlsMigrationSection(migration)).toBe(
      renderRlsMigrationSection(
        'payments_ledger',
        paymentsLedgerStatementRlsSpecs,
        paymentsLedgerSchemaRlsSpecs,
      ),
    );
  });
});

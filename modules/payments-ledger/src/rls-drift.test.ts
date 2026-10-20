import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import {
  paymentsLedgerHistoricalRlsSpecs,
  paymentsLedgerOigRlsSpecs,
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
        paymentsLedgerHistoricalRlsSpecs,
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
        paymentsLedgerHistoricalRlsSpecs,
      ),
    );
  });
});

describe('0070 payments-ledger RLS drift', () => {
  it('embeds the exact generated tenant-RLS section and coverage guard', () => {
    const migration = readFileSync(
      `${root}modules/payments-ledger/migrations/0070-oig-exception-report.sql`,
      'utf8',
    );
    expect(extractRlsMigrationSection(migration)).toBe(
      renderRlsMigrationSection(
        'payments_ledger',
        paymentsLedgerOigRlsSpecs,
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
        paymentsLedgerHistoricalRlsSpecs,
      ),
    );
  });
});

// Raw historical byte pins: even a generated final-epoch guard is wrong in these files.
it.each([
  ['0019-cash-ledger.sql', '87035a5d9b27fdc545f6b0e1052ff48ea20da34576346bb909634da13587a49a'],
  ['0021-ledger-v2.sql', 'dacade4469c78d5dfd5a0fa08c23a430ada4be349e1f90b56f5ed22fdbdf5f49'],
  ['0022-statements.sql', 'd6f807710e73b55633292a9710f96b8d1701bfaf68ba8a4273d300c63e92af8c'],
])('preserves pinned original bytes for %s', (name, hash) => {
  expect(
    createHash('sha256')
      .update(readFileSync(`${root}modules/payments-ledger/migrations/${name}`))
      .digest('hex'),
  ).toBe(hash);
});

it.each(['sql', 'rollback.sql'])(
  '0072 %s validates the complete final epoch without repairing it',
  (suffix) => {
    const sql = readFileSync(
      `${root}modules/payments-ledger/migrations/0072-ledger-rls-coverage.${suffix}`,
      'utf8',
    );
    expect(extractRlsMigrationSection(sql)).toBe(
      renderRlsMigrationSection('payments_ledger', [], paymentsLedgerSchemaRlsSpecs),
    );
    const required = paymentsLedgerSchemaRlsSpecs
      .map((spec) => `'${spec.table}'`)
      .sort()
      .join(', ');
    expect(sql).toContain(`unnest(ARRAY[${required}]::text[])`);
    expect(sql).toContain("n.nspname = 'payments_ledger' AND c.relkind = 'r'");
    expect(sql).toContain('ledger-0072 prerequisite missing ordinary tables: %');
    expect(sql).not.toMatch(/^(?:ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE) /m);
  },
);

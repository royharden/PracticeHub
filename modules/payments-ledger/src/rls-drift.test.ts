import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { paymentsLedgerRlsSpecs } from './rls-specs.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
describe('0019 payments-ledger RLS drift', () => {
  it('embeds the exact generated tenant-RLS section and coverage guard', () => {
    const migration = readFileSync(
      `${root}modules/payments-ledger/migrations/0019-cash-ledger.sql`,
      'utf8',
    );
    expect(extractRlsMigrationSection(migration)).toBe(
      renderRlsMigrationSection('payments_ledger', paymentsLedgerRlsSpecs, paymentsLedgerRlsSpecs),
    );
  });
});

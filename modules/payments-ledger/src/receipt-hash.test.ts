/**
 * WP-056 targeted fix (review D46-WP-056-a2-review-2): the receipt's
 * canonicalPayloadHash keeps its landed meaning, sha256 of the stored journal,
 * because importers (catalog-cash) recompute it from `journal()`. Retries stay
 * independent of key order through the separate canonicalTupleHash.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { BalancedLedger, LedgerError, type LedgerLine } from './ledger.js';

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const lines: readonly LedgerLine[] = [
  { accountRef: 'cash', side: 'debit', amountMinor: 2500, currency: 'USD', sourceRef: 'pay-1' },
  {
    accountRef: 'service-liability',
    side: 'credit',
    amountMinor: 2500,
    currency: 'USD',
    sourceRef: 'pay-1',
  },
];

describe('receipt hash is the stored-journal hash importers recompute', () => {
  it('equals sha256(JSON.stringify(journal())) without and with an explicit rail', () => {
    const ledger = new BalancedLedger();
    const implicit = ledger.postBalancedSet({
      tenantId: 't',
      journalId: 'j1',
      correlationId: 'c1',
      idempotencyKey: 'k1',
      lines,
    });
    const explicit = ledger.postBalancedSet({
      tenantId: 't',
      journalId: 'j2',
      correlationId: 'c2',
      idempotencyKey: 'k2',
      rail: 'cash',
      payoutRef: 'po-1',
      lines,
    });
    expect(implicit.canonicalPayloadHash).toBe(digest(ledger.journal('t', 'j1')));
    expect(explicit.canonicalPayloadHash).toBe(digest(ledger.journal('t', 'j2')));
  });

  it('still treats a reordered retry with an explicit default as the same post', () => {
    const ledger = new BalancedLedger();
    const first = ledger.postBalancedSet({
      tenantId: 't',
      journalId: 'j1',
      correlationId: 'c1',
      idempotencyKey: 'k1',
      lines,
    });
    const retry = ledger.postBalancedSet({
      lines,
      rail: 'cash',
      idempotencyKey: 'k1',
      correlationId: 'c1',
      journalId: 'j1',
      tenantId: 't',
    });
    expect(retry).toEqual(first);
    expect(first.canonicalTupleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      ledger.postBalancedSet({
        tenantId: 't',
        journalId: 'j1',
        correlationId: 'c1',
        idempotencyKey: 'k1',
        rail: 'membership',
        lines,
      }),
    ).toThrowError(new LedgerError('IDEMPOTENCY_CONFLICT'));
  });
});

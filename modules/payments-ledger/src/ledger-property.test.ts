/**
 * Balance property test (review low finding on ledger.test.ts:131): generated
 * postings, rejected unbalanced sets and reversals across all three rails,
 * with per-tenant, per-currency debit/credit equality checked after every
 * step. A seeded generator keeps every run reproducible.
 */
import { describe, expect, it } from 'vitest';

import {
  BalancedLedger,
  LedgerError,
  ledgerRails,
  type LedgerLine,
  type LedgerPostInput,
} from './ledger.js';

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const tenants = ['northwind-synthetic', 'riverbend-synthetic', 'lakeshore-synthetic'] as const;
const currencies = ['USD', 'EUR'] as const;
const accounts = ['cash', 'service-liability', 'accounts-receivable', 'revenue'] as const;

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('empty choice');
  return item;
}

function balancedLines(random: () => number, step: number): LedgerLine[] {
  const lines: LedgerLine[] = [];
  const currencyCount = 1 + Math.floor(random() * 2);
  for (const currency of currencies.slice(0, currencyCount)) {
    const legs = 1 + Math.floor(random() * 3);
    for (let leg = 0; leg < legs; leg += 1) {
      const amountMinor = 1 + Math.floor(random() * 50_000);
      const [debitAccount, creditAccount] = [pick(random, accounts), pick(random, accounts)];
      const sourceRef = `src-${String(step)}-${currency}-${String(leg)}`;
      lines.push({ accountRef: debitAccount, side: 'debit', amountMinor, currency, sourceRef });
      lines.push({ accountRef: creditAccount, side: 'credit', amountMinor, currency, sourceRef });
    }
  }
  return lines;
}

function assertBalanced(ledger: BalancedLedger): void {
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const row of ledger.accountBalances()) {
    const key = JSON.stringify([row.tenantId, row.currency]);
    const total = totals.get(key) ?? { debit: 0, credit: 0 };
    total.debit += row.debitMinor;
    total.credit += row.creditMinor;
    totals.set(key, total);
  }
  for (const [key, total] of totals) {
    expect(total.debit, key).toBe(total.credit);
  }
}

describe('BalancedLedger balance properties', () => {
  for (const seed of [1, 7, 42, 2026]) {
    it(`keeps every tenant and currency balanced over 300 generated steps (seed ${String(seed)})`, () => {
      const random = generator(seed);
      const ledger = new BalancedLedger();
      const reversible: LedgerPostInput[] = [];
      let posted = 0;
      let rejected = 0;
      let reversed = 0;
      for (let step = 0; step < 300; step += 1) {
        const roll = random();
        if (roll < 0.55 || reversible.length === 0) {
          const rail = pick(random, ledgerRails);
          const input: LedgerPostInput = {
            tenantId: pick(random, tenants),
            journalId: `j-${String(step)}`,
            correlationId: `c-${String(step)}`,
            idempotencyKey: `k-${String(step)}`,
            rail,
            ...(rail === 'cash' && random() < 0.5 ? { payoutRef: `po-${String(step % 5)}` } : {}),
            lines: balancedLines(random, step),
          };
          ledger.postBalancedSet(input);
          reversible.push(ledger.journal(input.tenantId, input.journalId) ?? input);
          posted += 1;
        } else if (roll < 0.8) {
          const lines = balancedLines(random, step);
          const [first, ...rest] = lines;
          if (first === undefined) throw new Error('no lines');
          const skewed = [{ ...first, amountMinor: first.amountMinor + 1 }, ...rest];
          const before = ledger.journals().length;
          expect(() =>
            ledger.postBalancedSet({
              tenantId: pick(random, tenants),
              journalId: `bad-${String(step)}`,
              correlationId: `c-bad-${String(step)}`,
              idempotencyKey: `k-bad-${String(step)}`,
              rail: pick(random, ledgerRails),
              lines: skewed,
            }),
          ).toThrowError(new LedgerError('UNBALANCED'));
          expect(ledger.journals()).toHaveLength(before);
          rejected += 1;
        } else {
          const index = Math.floor(random() * reversible.length);
          const original = reversible.splice(index, 1)[0];
          if (original === undefined) throw new Error('no original');
          ledger.postBalancedSet({
            tenantId: original.tenantId,
            journalId: `r-${String(step)}`,
            correlationId: `c-r-${String(step)}`,
            idempotencyKey: `k-r-${String(step)}`,
            ...(original.rail === undefined ? {} : { rail: original.rail }),
            ...(original.payoutRef === undefined ? {} : { payoutRef: original.payoutRef }),
            reversalOfJournalId: original.journalId,
            lines: original.lines.map((line) => ({
              ...line,
              side: line.side === 'debit' ? ('credit' as const) : ('debit' as const),
            })),
          });
          expect(() =>
            ledger.postBalancedSet({
              tenantId: original.tenantId,
              journalId: `r2-${String(step)}`,
              correlationId: `c-r2-${String(step)}`,
              idempotencyKey: `k-r2-${String(step)}`,
              ...(original.rail === undefined ? {} : { rail: original.rail }),
              ...(original.payoutRef === undefined ? {} : { payoutRef: original.payoutRef }),
              reversalOfJournalId: original.journalId,
              lines: original.lines.map((line) => ({
                ...line,
                side: line.side === 'debit' ? ('credit' as const) : ('debit' as const),
              })),
            }),
          ).toThrowError(new LedgerError('ALREADY_REVERSED'));
          reversed += 1;
        }
        assertBalanced(ledger);
      }
      expect(ledger.journals()).toHaveLength(posted + reversed);
      expect(posted).toBeGreaterThan(0);
      expect(rejected).toBeGreaterThan(0);
      expect(reversed).toBeGreaterThan(0);
    });
  }

  it('rejects a reversal that changes rail or payout', () => {
    const ledger = new BalancedLedger();
    const lines: LedgerLine[] = [
      { accountRef: 'cash', side: 'debit', amountMinor: 10, currency: 'USD', sourceRef: 's' },
      { accountRef: 'revenue', side: 'credit', amountMinor: 10, currency: 'USD', sourceRef: 's' },
    ];
    ledger.postBalancedSet({
      tenantId: 'northwind-synthetic',
      journalId: 'orig',
      correlationId: 'c',
      idempotencyKey: 'k',
      rail: 'cash',
      payoutRef: 'po-1',
      lines,
    });
    const swapped = lines.map((line) => ({
      ...line,
      side: line.side === 'debit' ? ('credit' as const) : ('debit' as const),
    }));
    for (const change of [
      { rail: 'membership' as const },
      { rail: 'cash' as const, payoutRef: 'po-2' },
    ]) {
      expect(() =>
        ledger.postBalancedSet({
          tenantId: 'northwind-synthetic',
          journalId: `rev-${change.rail}`,
          correlationId: 'c-rev',
          idempotencyKey: `k-rev-${change.rail}`,
          reversalOfJournalId: 'orig',
          lines: swapped,
          ...change,
        }),
      ).toThrowError(new LedgerError('MIXED_REVERSAL'));
    }
  });
});

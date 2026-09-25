import { createHash } from 'node:crypto';

import { assertSafeInteger, safeAdd } from './money.js';

export const ledgerRails = ['insurance', 'membership', 'cash'] as const;
export type LedgerRail = (typeof ledgerRails)[number];
export type LedgerSide = 'debit' | 'credit';

export interface LedgerLine {
  readonly accountRef: string;
  readonly side: LedgerSide;
  readonly amountMinor: number;
  readonly currency: string;
  readonly sourceRef: string;
}

export interface LedgerPostInput {
  readonly tenantId: string;
  readonly journalId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly lines: readonly LedgerLine[];
  readonly rail?: LedgerRail;
  readonly payoutRef?: string;
  readonly processorEffectRef?: string;
  readonly externalReceiptRef?: string;
  readonly reversalOfJournalId?: string;
}

export interface AccountBalance {
  readonly accountRef: string;
  readonly currency: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
}

export interface LedgerReceipt {
  readonly tenantId: string;
  readonly journalId: string;
  readonly canonicalPayloadHash: string;
  readonly reversalOfJournalId?: string;
}

export class LedgerError extends Error {
  public constructor(
    public readonly code:
      | 'UNBALANCED'
      | 'MIXED_REVERSAL'
      | 'ORIGINAL_NOT_FOUND'
      | 'ALREADY_REVERSED'
      | 'IDEMPOTENCY_CONFLICT'
      | 'INVALID_LINE',
  ) {
    super(code);
    this.name = 'LedgerError';
  }
}

const hashInput = (input: LedgerPostInput): string =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');

const tupleKey = (...parts: readonly string[]): string => JSON.stringify(parts);

function assertLines(lines: readonly LedgerLine[]): void {
  if (lines.length < 2) throw new LedgerError('UNBALANCED');
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const line of lines) {
    try {
      assertSafeInteger(line.amountMinor, 'ledger line amount');
    } catch {
      throw new LedgerError('INVALID_LINE');
    }
    if (!/^[A-Z]{3}$/.test(line.currency) || line.accountRef === '' || line.sourceRef === '') {
      throw new LedgerError('INVALID_LINE');
    }
    const total = totals.get(line.currency) ?? { debit: 0, credit: 0 };
    try {
      total[line.side] = safeAdd(
        total[line.side],
        line.amountMinor,
        `${line.currency} ledger total`,
      );
    } catch {
      throw new LedgerError('INVALID_LINE');
    }
    totals.set(line.currency, total);
  }
  if ([...totals.values()].some((total) => total.debit !== total.credit)) {
    throw new LedgerError('UNBALANCED');
  }
}

export class BalancedLedger {
  readonly #byIdempotency = new Map<string, { hash: string; receipt: LedgerReceipt }>();
  readonly #journals = new Map<string, LedgerPostInput>();
  readonly #reversed = new Set<string>();

  public postBalancedSet(input: LedgerPostInput): LedgerReceipt {
    assertLines(input.lines);
    const posted = normalizePost(input);
    const hash = hashInput(posted);
    const prior = this.#byIdempotency.get(tupleKey(posted.tenantId, posted.idempotencyKey));
    if (prior !== undefined) {
      if (prior.hash !== hash) throw new LedgerError('IDEMPOTENCY_CONFLICT');
      return prior.receipt;
    }
    if (this.#journals.has(tupleKey(posted.tenantId, posted.journalId))) {
      throw new LedgerError('IDEMPOTENCY_CONFLICT');
    }
    if (posted.reversalOfJournalId !== undefined) this.#assertReversal(posted);
    const receipt: LedgerReceipt = {
      tenantId: posted.tenantId,
      journalId: posted.journalId,
      canonicalPayloadHash: hash,
      ...(posted.reversalOfJournalId === undefined
        ? {}
        : { reversalOfJournalId: posted.reversalOfJournalId }),
    };
    this.#journals.set(tupleKey(posted.tenantId, posted.journalId), posted);
    this.#byIdempotency.set(tupleKey(posted.tenantId, posted.idempotencyKey), { hash, receipt });
    if (posted.reversalOfJournalId !== undefined) {
      this.#reversed.add(tupleKey(posted.tenantId, posted.reversalOfJournalId));
    }
    return receipt;
  }

  /** Debit and credit totals per account. A posted ledger balances when, for every currency, the sums match. */
  public accountBalances(tenantId?: string): readonly AccountBalance[] {
    const totals = new Map<string, AccountBalance>();
    for (const journal of this.#journals.values()) {
      if (tenantId !== undefined && journal.tenantId !== tenantId) continue;
      for (const line of journal.lines) {
        const key = JSON.stringify([journal.tenantId, line.accountRef, line.currency]);
        const current = totals.get(key) ?? {
          accountRef: line.accountRef,
          currency: line.currency,
          debitMinor: 0,
          creditMinor: 0,
        };
        const amount = line.amountMinor;
        const name = `${line.currency} ${line.accountRef}`;
        totals.set(key, {
          ...current,
          debitMinor:
            line.side === 'debit' ? safeAdd(current.debitMinor, amount, name) : current.debitMinor,
          creditMinor:
            line.side === 'credit'
              ? safeAdd(current.creditMinor, amount, name)
              : current.creditMinor,
        });
      }
    }
    return [...totals.values()].sort((left, right) =>
      `${left.currency}|${left.accountRef}`.localeCompare(`${right.currency}|${right.accountRef}`),
    );
  }

  /** Cash-rail bank side of one payout, in minor units. Debits add and credits subtract. */
  public cashPayoutMinor(tenantId: string, payoutRef: string, currency: string): number {
    let net = 0;
    for (const journal of this.#journals.values()) {
      if (
        journal.tenantId !== tenantId ||
        journal.rail !== 'cash' ||
        journal.payoutRef !== payoutRef
      ) {
        continue;
      }
      for (const line of journal.lines) {
        if (line.currency !== currency || line.accountRef !== 'cash') continue;
        const signed = line.side === 'debit' ? line.amountMinor : -line.amountMinor;
        const next = net + signed;
        if (!Number.isSafeInteger(next)) throw new LedgerError('INVALID_LINE');
        net = next;
      }
    }
    return net;
  }

  #assertReversal(input: LedgerPostInput): void {
    const originalKey = tupleKey(input.tenantId, String(input.reversalOfJournalId));
    const original = this.#journals.get(originalKey);
    if (original === undefined) throw new LedgerError('ORIGINAL_NOT_FOUND');
    if (original.reversalOfJournalId !== undefined) throw new LedgerError('MIXED_REVERSAL');
    if (this.#reversed.has(originalKey)) throw new LedgerError('ALREADY_REVERSED');
    if (input.rail !== original.rail || input.payoutRef !== original.payoutRef) {
      throw new LedgerError('MIXED_REVERSAL');
    }
    const expected = original.lines
      .map((line) => ({
        ...line,
        side: line.side === 'debit' ? ('credit' as const) : ('debit' as const),
      }))
      .sort(compareLine);
    const actual = [...input.lines].sort(compareLine);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new LedgerError('MIXED_REVERSAL');
  }

  public journals(): readonly LedgerPostInput[] {
    return [...this.#journals.values()];
  }

  public journal(tenantId: string, journalId: string): LedgerPostInput | undefined {
    return this.#journals.get(tupleKey(tenantId, journalId));
  }
}

function normalizePost(input: LedgerPostInput): LedgerPostInput {
  const rail = input.rail ?? 'cash';
  if (!ledgerRails.includes(rail)) throw new LedgerError('INVALID_LINE');
  if (input.payoutRef !== undefined && (input.payoutRef.trim() === '' || rail !== 'cash')) {
    throw new LedgerError('INVALID_LINE');
  }
  return {
    ...input,
    rail,
    ...(input.payoutRef === undefined ? {} : { payoutRef: input.payoutRef }),
  };
}

const compareLine = (left: LedgerLine, right: LedgerLine): number =>
  JSON.stringify([
    left.currency,
    left.accountRef,
    left.side,
    left.sourceRef,
    left.amountMinor,
  ]).localeCompare(
    JSON.stringify([
      right.currency,
      right.accountRef,
      right.side,
      right.sourceRef,
      right.amountMinor,
    ]),
  );

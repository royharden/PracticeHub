import { createHash } from 'node:crypto';

import { assertSafeInteger, safeAdd } from './money.js';

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
  readonly processorEffectRef?: string;
  readonly externalReceiptRef?: string;
  readonly reversalOfJournalId?: string;
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
    const hash = hashInput(input);
    const prior = this.#byIdempotency.get(tupleKey(input.tenantId, input.idempotencyKey));
    if (prior !== undefined) {
      if (prior.hash !== hash) throw new LedgerError('IDEMPOTENCY_CONFLICT');
      return prior.receipt;
    }
    if (this.#journals.has(tupleKey(input.tenantId, input.journalId))) {
      throw new LedgerError('IDEMPOTENCY_CONFLICT');
    }
    if (input.reversalOfJournalId !== undefined) this.#assertReversal(input);
    const receipt: LedgerReceipt = {
      tenantId: input.tenantId,
      journalId: input.journalId,
      canonicalPayloadHash: hash,
      ...(input.reversalOfJournalId === undefined
        ? {}
        : { reversalOfJournalId: input.reversalOfJournalId }),
    };
    this.#journals.set(tupleKey(input.tenantId, input.journalId), input);
    this.#byIdempotency.set(tupleKey(input.tenantId, input.idempotencyKey), { hash, receipt });
    if (input.reversalOfJournalId !== undefined) {
      this.#reversed.add(tupleKey(input.tenantId, input.reversalOfJournalId));
    }
    return receipt;
  }

  #assertReversal(input: LedgerPostInput): void {
    const originalKey = tupleKey(input.tenantId, String(input.reversalOfJournalId));
    const original = this.#journals.get(originalKey);
    if (original === undefined) throw new LedgerError('ORIGINAL_NOT_FOUND');
    if (original.reversalOfJournalId !== undefined) throw new LedgerError('MIXED_REVERSAL');
    if (this.#reversed.has(originalKey)) throw new LedgerError('ALREADY_REVERSED');
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

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
  /** Present only on a governed write-off journal (see write-off.ts). */
  readonly writeOff?: WriteOffMemo;
  /**
   * When the journal happened (ISO-8601 instant; the DB `journal.occurred_at`).
   * Accounting exports place a journal in a period by its UTC date.
   */
  readonly occurredAt?: string;
}

/** The approval a write-off journal was posted under, carried on the journal itself. */
export interface WriteOffMemo {
  readonly writeOffId: string;
  readonly reason: string;
  readonly approvalHash: string;
  readonly approverActorId: string;
}

export interface AccountBalance {
  /** The tenant these totals belong to; rows from different tenants never merge. */
  readonly tenantId: string;
  readonly accountRef: string;
  readonly currency: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
}

export interface LedgerReceipt {
  readonly tenantId: string;
  readonly journalId: string;
  /** sha256 of JSON.stringify(the stored journal), as landed; importers recompute it from `journal()`. */
  readonly canonicalPayloadHash: string;
  /**
   * sha256 of the order-independent canonical tuple (fixed key order, defaults
   * applied). Retries are compared on this, so key order or an explicit
   * default never makes an identical retry conflict.
   */
  readonly canonicalTupleHash?: string;
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

/**
 * Canonical form for the idempotency hash: a fixed key order with defaults
 * applied, so a retry that differs only in key order or in spelling out a
 * default (`rail: 'cash'`) hashes the same.
 */
const canonicalPost = (input: LedgerPostInput): readonly unknown[] => [
  input.tenantId,
  input.journalId,
  input.correlationId,
  input.idempotencyKey,
  input.rail ?? 'cash',
  input.payoutRef ?? null,
  input.processorEffectRef ?? null,
  input.externalReceiptRef ?? null,
  input.reversalOfJournalId ?? null,
  input.writeOff === undefined
    ? null
    : [
        input.writeOff.writeOffId,
        input.writeOff.reason,
        input.writeOff.approvalHash,
        input.writeOff.approverActorId,
      ],
  input.lines.map((line) => [
    line.accountRef,
    line.side,
    line.amountMinor,
    line.currency,
    line.sourceRef,
  ]),
  input.occurredAt ?? null,
];

const tupleHash = (input: LedgerPostInput): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalPost(input)))
    .digest('hex');

/** The landed receipt hash: the stored journal exactly as `journal()` returns it. */
const payloadHash = (stored: LedgerPostInput): string =>
  createHash('sha256').update(JSON.stringify(stored)).digest('hex');

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
    const hash = tupleHash(posted);
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
      canonicalPayloadHash: payloadHash(posted),
      canonicalTupleHash: hash,
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

  /**
   * Debit and credit totals per tenant, account and currency. A posted ledger
   * balances when, for every tenant and currency, the sums match. Without a
   * tenantId every tenant is returned, each row keyed by its own tenantId.
   */
  public accountBalances(tenantId?: string): readonly AccountBalance[] {
    const totals = new Map<string, AccountBalance>();
    for (const journal of this.#journals.values()) {
      if (tenantId !== undefined && journal.tenantId !== tenantId) continue;
      for (const line of journal.lines) {
        const key = JSON.stringify([journal.tenantId, line.accountRef, line.currency]);
        const current = totals.get(key) ?? {
          tenantId: journal.tenantId,
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
      JSON.stringify([left.tenantId, left.currency, left.accountRef]).localeCompare(
        JSON.stringify([right.tenantId, right.currency, right.accountRef]),
      ),
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
  if (
    input.occurredAt !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T/.test(input.occurredAt) || Number.isNaN(Date.parse(input.occurredAt)))
  ) {
    throw new LedgerError('INVALID_LINE');
  }
  if (
    input.writeOff !== undefined &&
    (input.writeOff.writeOffId.trim() === '' ||
      input.writeOff.reason.trim() === '' ||
      input.writeOff.approverActorId.trim() === '' ||
      !/^[0-9a-f]{64}$/.test(input.writeOff.approvalHash))
  ) {
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

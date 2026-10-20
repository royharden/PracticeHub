import { RcmShadowError } from '../contracts.js';

export type PostingSide = 'debit' | 'credit';

export interface PostingLine {
  readonly accountRef: string;
  readonly side: PostingSide;
  readonly amountMinor: number;
  readonly currency: string;
  readonly sourceRef: string;
}

/** The subset of the WP-056 `LedgerPostInput` that posting writes. */
export interface PostingJournal {
  readonly tenantId: string;
  readonly journalId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly lines: readonly PostingLine[];
  readonly rail?: 'insurance' | 'membership' | 'cash';
}

/**
 * The WP-056 ledger surface posting depends on. `BalancedLedger` from
 * `@practicehub/payments-ledger` satisfies it structurally; wiring it in
 * needs a package dependency that this package does not own.
 */
export interface PostingLedgerPort {
  postBalancedSet(input: PostingJournal): { readonly journalId: string };
  journals(): readonly PostingJournal[];
}

/**
 * Stands for WP-056 `BalancedLedger` until `@practicehub/rcm` depends on
 * `@practicehub/payments-ledger`. It follows the frozen ledger-api-v2 rules
 * posting relies on, with the real class's error codes: positive integer
 * lines and per-currency balance (`UNBALANCED`, `INVALID_LINE`); a replay of
 * the same (tenant, idempotencyKey) with identical bytes returns the earlier
 * receipt; a different payload under that key, or a reused journal id, is
 * `IDEMPOTENCY_CONFLICT`.
 */
export class Wp056BalancedLedgerDouble implements PostingLedgerPort {
  private readonly posted = new Map<string, PostingJournal>();
  private readonly byIdempotency = new Map<
    string,
    { readonly payload: string; readonly journalId: string }
  >();

  public postBalancedSet(input: PostingJournal): { readonly journalId: string } {
    if (input.lines.length < 2) {
      throw new RcmShadowError('UNBALANCED', 'a journal needs two lines');
    }
    const totals = new Map<string, number>();
    for (const line of input.lines) {
      if (!Number.isSafeInteger(line.amountMinor) || line.amountMinor <= 0) {
        throw new RcmShadowError('INVALID_LINE', 'line amounts are positive safe integers');
      }
      const signed = line.side === 'debit' ? line.amountMinor : -line.amountMinor;
      totals.set(line.currency, (totals.get(line.currency) ?? 0) + signed);
    }
    if ([...totals.values()].some((total) => total !== 0)) {
      throw new RcmShadowError('UNBALANCED', 'debits must equal credits per currency');
    }
    const payload = JSON.stringify(input);
    const replayKey = `${input.tenantId}\u001f${input.idempotencyKey}`;
    const prior = this.byIdempotency.get(replayKey);
    if (prior) {
      if (prior.payload !== payload) {
        throw new RcmShadowError(
          'IDEMPOTENCY_CONFLICT',
          'idempotency key reused with a different payload',
        );
      }
      return { journalId: prior.journalId };
    }
    const key = `${input.tenantId}\u001f${input.journalId}`;
    if (this.posted.has(key)) {
      throw new RcmShadowError('IDEMPOTENCY_CONFLICT', 'journal id already posted');
    }
    this.posted.set(key, structuredClone(input));
    this.byIdempotency.set(replayKey, { payload, journalId: input.journalId });
    return { journalId: input.journalId };
  }

  public journals(): readonly PostingJournal[] {
    return [...this.posted.values()].map((journal) => structuredClone(journal));
  }
}

/** Signed net (debits positive) of an account across journals, optionally by source. */
export function accountNet(
  journals: readonly PostingJournal[],
  tenantId: string,
  accountRef: string,
  sourceRef?: string,
): number {
  let net = 0;
  for (const journal of journals) {
    if (journal.tenantId !== tenantId) {
      continue;
    }
    for (const line of journal.lines) {
      if (
        line.accountRef !== accountRef ||
        (sourceRef !== undefined && line.sourceRef !== sourceRef)
      ) {
        continue;
      }
      net += line.side === 'debit' ? line.amountMinor : -line.amountMinor;
    }
  }
  return net;
}

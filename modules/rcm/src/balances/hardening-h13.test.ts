/**
 * WP-090 hardening H-13 (NR-140): one issuer failure never aborts the statement run, and a
 * statement the issuer definitely did not send is never stranded as held.
 * Each regression fails on candidates/D50-WP-090-a2, where the first failure aborts the run.
 */
import { describe, expect, it } from 'vitest';

import { PatientBalanceBook, type BalanceEvent } from './balance-book.js';
import { EraRegistry } from './era-registry.js';
import * as port from './statement-port.js';
import type { StatementIssuerPort, StatementReceipt, StatementRequest } from './statement-port.js';

const TENANT = 'tenant-synth';

function charge(eventId: string, episodeId: string, amountMinor: number): BalanceEvent {
  return {
    eventId,
    tenantId: TENANT,
    payerId: 'payer-1',
    serviceDate: '2026-08-01',
    arrivedVia: 'native',
    accountRef: 'acct-1',
    episodeId,
    kind: 'patient-responsibility',
    amountMinor,
  };
}

/** An issuer that fails for the named episodes and delivers the rest. */
class FlakyIssuer implements StatementIssuerPort {
  public readonly idempotent = false;
  public readonly sent: StatementRequest[] = [];
  public constructor(private readonly failures: Map<string, () => Error>) {}

  public issue(request: StatementRequest): StatementReceipt {
    const failure = this.failures.get(request.episodeId);
    if (failure) {
      this.failures.delete(request.episodeId);
      throw failure();
    }
    this.sent.push(request);
    return { statementId: request.statementId, replay: false };
  }
}

function setup(failures: Map<string, () => Error>) {
  const registry = new EraRegistry([
    { tenantId: TENANT, payerId: 'payer-1', cutoverOn: '2026-07-01', legacySystem: 'athena' },
  ]);
  const issuer = new FlakyIssuer(failures);
  const book = new PatientBalanceBook({ registry, issuer });
  book.apply(charge('ev-1', 'ep-1', 3_000));
  book.apply(charge('ev-2', 'ep-2', 5_000));
  return { issuer, book };
}

describe('NR-140: per-statement issuer failures are isolated', () => {
  it('a failure of unknown delivery holds that statement and the run continues for the others', () => {
    const { issuer, book } = setup(new Map([['ep-1', () => new Error('rail timeout after send')]]));
    const outcomes = book.runStatements(TENANT, '2026-09-01');
    expect(outcomes.map((item) => `${item.episodeId}:${item.status}`)).toEqual([
      'ep-1:unconfirmed',
      'ep-2:issued',
    ]);
    expect(issuer.sent.map((item) => item.episodeId)).toEqual(['ep-2']);
    expect(book.exceptions().map((item) => `${item.reason}:${item.episodeId}`)).toEqual([
      'statement-unconfirmed:ep-1',
    ]);
  });

  it('a definite non-delivery is not held: the run continues and the next run sends it', () => {
    const NotSent = (port as unknown as { StatementNotSentError: new (message: string) => Error })
      .StatementNotSentError;
    const { issuer, book } = setup(new Map([['ep-1', () => new NotSent('rail down before send')]]));
    const first = book.runStatements(TENANT, '2026-09-01');
    expect(first.map((item) => `${item.episodeId}:${item.status}`)).toEqual([
      'ep-1:not-sent',
      'ep-2:issued',
    ]);
    expect(book.exceptions()).toEqual([]);
    const second = book.runStatements(TENANT, '2026-09-02');
    expect(second.map((item) => `${item.episodeId}:${item.status}`)).toEqual([
      'ep-1:issued',
      'ep-2:already-stated',
    ]);
    expect(issuer.sent.map((item) => item.episodeId)).toEqual(['ep-2', 'ep-1']);
  });
});

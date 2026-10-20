import { RcmShadowError } from '../contracts.js';

export interface StatementRequest {
  readonly tenantId: string;
  readonly accountRef: string;
  readonly episodeId: string;
  readonly statementId: string;
  readonly issueOn: string;
  readonly amountMinor: number;
}

/**
 * Thrown by an issuer when it knows the statement was NOT delivered (for example the rail
 * refused it before sending). Any other thrown error means delivery is unknown.
 */
export class StatementNotSentError extends RcmShadowError {
  public constructor(message: string) {
    super('STATEMENT_NOT_SENT', message);
    this.name = 'StatementNotSentError';
  }
}

export interface StatementReceipt {
  readonly statementId: string;
  /** True when this id had already been issued; nothing new reached the patient. */
  readonly replay: boolean;
}

/**
 * The statement surface WP-090 issues through. WP-057 `issueStatement` in
 * `@practicehub/payments-ledger` is the real issuer; its adapter supplies
 * the capability grants and guarantor terms it needs.
 *
 * `idempotent` says whether the issuer dedupes by `statementId`. At base,
 * WP-057 `issueStatement` does not (it keeps no issued-id record and takes no
 * amount), so its adapter must report `false` until WP-057 adds an
 * idempotent issue keyed by statement id. With `false`, the balance book
 * never resends after an unconfirmed attempt.
 */
export interface StatementIssuerPort {
  readonly idempotent: boolean;
  issue(request: StatementRequest): StatementReceipt;
}

/**
 * Stands for the WP-057 statement issuer until `@practicehub/rcm` depends on
 * `@practicehub/payments-ledger`. It records every statement that reached a
 * patient. By default it is not idempotent, like WP-057 at base: every call
 * delivers. With `idempotent: true` it models the WP-057 change and treats a
 * repeated statement id as a replay.
 */
export class Wp057StatementIssuerDouble implements StatementIssuerPort {
  public readonly idempotent: boolean;
  private readonly sent: StatementRequest[] = [];
  private readonly ids = new Set<string>();

  public constructor(options: { readonly idempotent?: boolean } = {}) {
    this.idempotent = options.idempotent ?? false;
  }

  public issue(request: StatementRequest): StatementReceipt {
    if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) {
      throw new RcmShadowError('STATEMENT_AMOUNT', 'a statement states a positive balance');
    }
    const key = `${request.tenantId}\u001f${request.statementId}`;
    if (this.idempotent && this.ids.has(key)) {
      return { statementId: request.statementId, replay: true };
    }
    this.ids.add(key);
    this.sent.push(structuredClone(request));
    return { statementId: request.statementId, replay: false };
  }

  /** Every statement that reached a patient, including any duplicate a non-idempotent issuer sent. */
  public delivered(): readonly StatementRequest[] {
    return this.sent.map((request) => structuredClone(request));
  }
}

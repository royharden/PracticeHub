export const CASH_PPDR_THRESHOLD_MINOR = 40000;

export type CashCoverage = 'covered' | 'non-covered';
export type CashPartyKind = 'provider' | 'facility';
export type CashPartyRole = 'convening' | 'co-provider' | 'co-facility';

const purchasePattern = /^[a-z0-9][a-z0-9-]{7,63}$/;

export class CashGfeError extends Error {
  public constructor(
    public readonly code:
      | 'TOTAL_DRIFT'
      | 'CLAIM_ON_GFE'
      | 'ATTRIBUTION'
      | 'PURCHASE_CONFLICT'
      | 'NOT_FOUND'
      | 'GFE_INVALID',
  ) {
    super(code);
    this.name = 'CashGfeError';
  }
}

export interface CashEstimateLine {
  readonly lineRef: string;
  readonly expectedAmountMinor: number;
  readonly coverage: CashCoverage;
  readonly partyKind: CashPartyKind;
  readonly partyRef: string;
  readonly partyRole: CashPartyRole;
}

export interface CashGfeDocument {
  readonly tenantId: string;
  readonly gfeRef: string;
  readonly contentSha256: string;
  readonly gfeTotalMinor: number;
  readonly claimTotalMinor: number;
  readonly lines: readonly CashEstimateLine[];
}

export interface IssuedCashGfe {
  readonly tenantId: string;
  readonly purchaseKey: string;
  readonly document: CashGfeDocument;
}

export interface CashVariance {
  readonly purchaseKey: string;
  readonly gfeTotalMinor: number;
  readonly actualTotalMinor: number;
  readonly deltaMinor: number;
  readonly flagged: boolean;
}

const roleMatches = (kind: CashPartyKind, role: CashPartyRole): boolean => {
  if (role === 'convening') return true;
  if (role === 'co-provider') return kind === 'provider';
  return kind === 'facility';
};

const sum = (lines: readonly CashEstimateLine[], coverage: CashCoverage): number =>
  lines
    .filter((line) => line.coverage === coverage)
    .reduce((total, line) => total + line.expectedAmountMinor, 0);

export class CashGfeIssuer {
  readonly #issued = new Map<string, IssuedCashGfe>();

  public issue(input: {
    readonly tenantId: string;
    readonly purchaseKey: string;
    readonly document: CashGfeDocument;
  }): IssuedCashGfe {
    if (!purchasePattern.test(input.purchaseKey) || input.document.lines.length === 0) {
      throw new CashGfeError('GFE_INVALID');
    }
    for (const line of input.document.lines) {
      if (
        line.lineRef === '' ||
        line.partyRef === '' ||
        !Number.isSafeInteger(line.expectedAmountMinor) ||
        line.expectedAmountMinor < 0 ||
        !roleMatches(line.partyKind, line.partyRole)
      ) {
        throw new CashGfeError('ATTRIBUTION');
      }
    }
    const selfPay = sum(input.document.lines, 'non-covered');
    const claim = sum(input.document.lines, 'covered');
    if (input.document.gfeTotalMinor !== selfPay) {
      throw new CashGfeError(
        input.document.gfeTotalMinor > selfPay ? 'CLAIM_ON_GFE' : 'TOTAL_DRIFT',
      );
    }
    if (input.document.claimTotalMinor !== claim) throw new CashGfeError('TOTAL_DRIFT');
    const stored = Object.freeze({
      tenantId: input.tenantId,
      purchaseKey: input.purchaseKey,
      document: Object.freeze({
        ...input.document,
        lines: Object.freeze(input.document.lines.map((line) => Object.freeze({ ...line }))),
      }),
    });
    const key = JSON.stringify([input.tenantId, input.purchaseKey]);
    const prior = this.#issued.get(key);
    if (prior !== undefined && prior.document.contentSha256 !== stored.document.contentSha256) {
      throw new CashGfeError('PURCHASE_CONFLICT');
    }
    this.#issued.set(key, stored);
    return stored;
  }

  public variance(input: {
    readonly tenantId: string;
    readonly purchaseKey: string;
    readonly actualTotalMinor: number;
  }): CashVariance {
    const issued = this.#issued.get(JSON.stringify([input.tenantId, input.purchaseKey]));
    if (issued === undefined) throw new CashGfeError('NOT_FOUND');
    if (!Number.isSafeInteger(input.actualTotalMinor) || input.actualTotalMinor < 0) {
      throw new CashGfeError('GFE_INVALID');
    }
    const deltaMinor = input.actualTotalMinor - issued.document.gfeTotalMinor;
    return Object.freeze({
      purchaseKey: input.purchaseKey,
      gfeTotalMinor: issued.document.gfeTotalMinor,
      actualTotalMinor: input.actualTotalMinor,
      deltaMinor,
      flagged: deltaMinor >= CASH_PPDR_THRESHOLD_MINOR,
    });
  }
}

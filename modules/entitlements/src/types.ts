export type CoverageClass = 'covered' | 'non-covered' | 'unclassified';
export type PayerKind = 'member' | 'employer';
export type MembershipState = 'active' | 'paused' | 'cancelled';

export interface CatalogLine {
  componentRef: string;
  coverage: CoverageClass;
  amountCents: number;
}

export interface CatalogComposition {
  skuRef: string;
  billedComponentRefs: readonly string[];
  lines: readonly CatalogLine[];
}

export interface MembershipVintage {
  memberRef: string;
  vintageId: string;
  payer: PayerKind;
  state: MembershipState;
}

export interface ConsumeCommand {
  tenantId: string;
  idempotencyKey: string;
  memberRef: string;
  vintageId: string;
  skuRef: string;
  billedComponentRefs: readonly string[];
  discountCents: number;
}

export type ConsumeOutcome =
  | { ok: true; consumptionId: string; allowedDiscountCents: number }
  | { ok: false; code: ConsumeErrorCode };

export type ConsumeErrorCode =
  | 'VINTAGE_MISMATCH'
  | 'MEMBERSHIP_FROZEN'
  | 'UNCLASSIFIED_CANNOT_SELL'
  | 'COMPOSITION_INCOMPLETE'
  | 'DISCOUNT_ON_COVERED'
  | 'DOUBLE_CONSUMPTION'
  | 'IDEMPOTENT_REPLAY';

export class EntitlementsError extends Error {
  constructor(
    readonly code: ConsumeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EntitlementsError';
  }
}

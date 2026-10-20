import type { RailId } from '../router.js';

/** CAS group codes: contractual, patient responsibility, other, payer-initiated, correction. */
export type CasGroup = 'CO' | 'PR' | 'OA' | 'PI' | 'CR';

export interface CasAdjustment {
  readonly group: CasGroup;
  readonly carc: string;
  /** Signed minor units; a negative amount reverses an earlier adjustment. */
  readonly amountMinor: number;
}

export interface ServicePayment {
  readonly lineId: string;
  readonly code: string;
  readonly units: number;
  readonly serviceDate: string;
  readonly chargeMinor: number;
  /** Payer-allowed amount (paid plus patient responsibility). */
  readonly allowedMinor: number;
  readonly paidMinor: number;
}

/** One CLP loop. `paidMinor` is negative for a takeback (CLP02 22). */
export interface ClaimPayment {
  readonly controlNumber: string;
  readonly chargeMinor: number;
  readonly paidMinor: number;
  readonly adjustments: readonly CasAdjustment[];
  readonly lines: readonly ServicePayment[];
}

/** One PLB provider-level adjustment. A positive amount reduces the payment. */
export interface PlbAdjustment {
  readonly reasonCode: string;
  readonly reference: string;
  readonly amountMinor: number;
}

export interface Remit835 {
  readonly remitId: string;
  readonly tenantId: string;
  readonly payerId: string;
  readonly railId: RailId;
  /** BPR02 total actual provider payment. */
  readonly paymentMinor: number;
  /** TRN02 trace number shared with the EFT. */
  readonly traceNumber: string;
  readonly claims: readonly ClaimPayment[];
  readonly plb: readonly PlbAdjustment[];
}

/**
 * One bank deposit. Its identity is its content (payer, TRN reassociation
 * trace, amount, deposit date); `eftId` is the transport id of one delivery.
 */
export interface EftDeposit {
  readonly eftId: string;
  readonly tenantId: string;
  readonly payerId: string;
  readonly traceNumber: string;
  readonly amountMinor: number;
  /** YYYY-MM-DD. */
  readonly depositedOn: string;
}

export interface FeeSchedule {
  /** Contracted rates are per tenant; one tenant's schedule never prices another's remit. */
  readonly tenantId: string;
  readonly scheduleId: string;
  readonly payerId: string;
  readonly version: string;
  readonly effectiveOn: string;
  /** Allowed minor units per unit, by procedure code. */
  readonly rates: Readonly<Record<string, number>>;
}

export interface PatientRefund {
  readonly refundId: string;
  readonly tenantId: string;
  readonly claimId: string;
  readonly amountMinor: number;
}

export type PostingExceptionReason =
  | 'remit-unbalanced'
  | 'remit-conflict'
  | 'payer-unrouted'
  | 'payer-mismatch'
  | 'claim-unbalanced'
  | 'claim-unmatched'
  | 'double-recoupment'
  | 'plb-provider-level'
  | 'enrollment-constraint'
  | 'eft-unmatched'
  | 'eft-amount-mismatch'
  | 'remit-without-eft';

/** An open posting exception. Exceptions are never cleared by forcing a balance. */
export interface PostingException {
  readonly reason: PostingExceptionReason;
  readonly tenantId: string;
  readonly reference: string;
  readonly amountMinor: number;
  readonly owner: string;
}

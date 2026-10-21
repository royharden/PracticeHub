import { RcmShadowError } from '../contracts.js';

import type { RemitAdjustment } from './types.js';

/**
 * Placeholder for WP-054 (M17 employer groups + MSP screening). WP-054 stores the MSP questionnaire
 * and its determination; WP-093 only reads the determination. WP-054 replaces this type.
 */
export const WP054_PACKAGE_ID = 'WP-054' as const;

export type MspReason =
  | 'none'
  | 'working-aged'
  | 'disability'
  | 'esrd-coordination'
  | 'workers-comp'
  | 'no-fault'
  | 'liability';

export interface Wp054MspDetermination {
  readonly packageId: typeof WP054_PACKAGE_ID;
  readonly determinationId: string;
  readonly tenantId: string;
  readonly patientId: string;
  readonly reason: MspReason;
  /** Employer headcount behind the group health plan, when the reason depends on it. */
  readonly employerSize: number | null;
  readonly determinedOn: string;
  readonly validThrough: string;
}

/**
 * Placeholder for WP-089 (835/EFT/PLB posting). A remit reaches COB only after WP-089 posts it and
 * it balances to the penny. `forwardedToPayerId` is the 835 crossover indicator (CLP02 = 19 with
 * an NM1*TT crossover carrier). WP-089 replaces this type.
 */
export const WP089_PACKAGE_ID = 'WP-089' as const;

export interface Wp089PostedRemit {
  readonly packageId: typeof WP089_PACKAGE_ID;
  readonly remitId: string;
  readonly tenantId: string;
  readonly episodeId: string;
  readonly payerId: string;
  readonly controlNumber: string;
  readonly billedMinor: number;
  readonly paidMinor: number;
  readonly adjustments: readonly RemitAdjustment[];
  readonly forwardedToPayerId: string | null;
  readonly postedAt: string;
}

function minor(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RcmShadowError('COB_AMOUNT', `${field} must be a non-negative integer of cents`);
  }
}

/** Penny rule: billed = paid + every adjustment. A remit that does not balance is refused. */
export function assertRemitBalances(remit: Wp089PostedRemit): void {
  if (remit.packageId !== WP089_PACKAGE_ID) {
    throw new RcmShadowError('COB_REMIT', 'remit must come from WP-089 posting');
  }
  minor(remit.billedMinor, 'billedMinor');
  minor(remit.paidMinor, 'paidMinor');
  let total = remit.paidMinor;
  for (const adjustment of remit.adjustments) {
    minor(adjustment.amountMinor, 'adjustment amountMinor');
    if (!['CO', 'PR', 'OA', 'PI'].includes(adjustment.group) || adjustment.reason.length === 0) {
      throw new RcmShadowError('COB_REMIT', 'adjustment needs a CAS group and reason');
    }
    total += adjustment.amountMinor;
  }
  if (total !== remit.billedMinor) {
    throw new RcmShadowError(
      'COB_REMIT_UNBALANCED',
      `remit ${remit.remitId} does not balance: paid + adjustments = ${String(total)}, billed = ${String(remit.billedMinor)}`,
    );
  }
}

/** Patient responsibility left after a payer: the amount the next payer may consider. */
export function patientResponsibility(remit: Wp089PostedRemit): number {
  return remit.adjustments
    .filter((adjustment) => adjustment.group === 'PR')
    .reduce((sum, adjustment) => sum + adjustment.amountMinor, 0);
}

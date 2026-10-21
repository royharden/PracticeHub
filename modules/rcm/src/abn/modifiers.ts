/**
 * GA/GX/GY/GZ selection and patient-liability treatment (REQ-RCM-001 AC2/AC4/AC7).
 *
 * - GA: a required ABN is on file and valid; the patient chose option 1.
 * - GZ: an ABN was required but no valid one exists; liability stays with
 *   the practice and the patient bill line is blocked.
 * - GY: the item is statutorily excluded or not a Medicare benefit.
 * - GX: a voluntary ABN was issued for a statutorily excluded item (with GY).
 * Option 2 means the patient asked that Medicare not be billed: no claim line.
 */

import type { AbnOption, AbnValidity } from './abn.js';

export type MedicareCoverageBasis =
  /** Covered benefit that may be denied as not reasonable and necessary: ABN required. */
  | 'required-abn'
  /** Statutorily excluded / not a Medicare benefit: ABN voluntary. */
  | 'statutorily-excluded'
  /** Covered, no expected denial: no ABN. */
  | 'covered';

export type Modifier = 'GA' | 'GX' | 'GY' | 'GZ';

export interface LiabilityDecision {
  readonly claim: 'submit' | 'do-not-submit';
  readonly modifiers: readonly Modifier[];
  readonly patientBillLine: 'allowed' | 'blocked';
  readonly transferOfLiability: boolean;
  readonly escalate: boolean;
  readonly reason: string;
}

export function decideLiability(input: {
  readonly basis: MedicareCoverageBasis;
  readonly validity: AbnValidity;
  /**
   * Optional cross-check only. The option always comes from the signed ABN
   * (`validity.option`); a different caller-supplied option escalates.
   */
  readonly option?: AbnOption | null;
}): LiabilityDecision {
  const { basis, validity } = input;
  const option = validity.option;
  if (
    basis !== 'covered' &&
    validity.valid &&
    validity.evidence === 'signed' &&
    input.option !== undefined &&
    input.option !== option
  ) {
    return {
      claim: 'do-not-submit',
      modifiers: [],
      patientBillLine: 'blocked',
      transferOfLiability: false,
      escalate: true,
      reason: 'option-mismatch',
    };
  }
  if (basis === 'covered') {
    return {
      claim: 'submit',
      modifiers: [],
      patientBillLine: 'blocked',
      transferOfLiability: false,
      escalate: false,
      reason: 'covered-service-no-abn',
    };
  }
  if (basis === 'statutorily-excluded') {
    const voluntary = validity.valid && validity.evidence === 'signed';
    if (voluntary && option === 'option-2-do-not-bill') {
      return {
        claim: 'do-not-submit',
        modifiers: [],
        patientBillLine: 'allowed',
        transferOfLiability: true,
        escalate: false,
        reason: 'patient-requested-no-claim',
      };
    }
    return {
      claim: 'submit',
      modifiers: voluntary ? ['GX', 'GY'] : ['GY'],
      patientBillLine: 'allowed',
      transferOfLiability: true,
      escalate: false,
      reason: voluntary ? 'excluded-with-voluntary-abn' : 'excluded-not-a-benefit',
    };
  }
  // basis === 'required-abn'
  if (!validity.valid) {
    return {
      claim: 'submit',
      modifiers: ['GZ'],
      patientBillLine: 'blocked',
      transferOfLiability: false,
      escalate: true,
      reason: `no-valid-abn:${validity.defects.join('|')}`,
    };
  }
  if (validity.evidence === 'refused') {
    // Witnessed refusal: self-pay-at-risk per policy, but no signed choice to bill under GA.
    return {
      claim: 'submit',
      modifiers: ['GA'],
      patientBillLine: 'allowed',
      transferOfLiability: true,
      escalate: false,
      reason: 'abn-refusal-witnessed',
    };
  }
  switch (option) {
    case 'option-1-bill-medicare':
      return {
        claim: 'submit',
        modifiers: ['GA'],
        patientBillLine: 'allowed',
        transferOfLiability: true,
        escalate: false,
        reason: 'valid-abn-option-1',
      };
    case 'option-2-do-not-bill':
      return {
        claim: 'do-not-submit',
        modifiers: [],
        patientBillLine: 'allowed',
        transferOfLiability: true,
        escalate: false,
        reason: 'valid-abn-option-2',
      };
    case 'option-3-decline-service':
    case null:
      return {
        claim: 'do-not-submit',
        modifiers: [],
        patientBillLine: 'blocked',
        transferOfLiability: false,
        escalate: option === null,
        reason: option === null ? 'abn-option-missing' : 'service-declined',
      };
  }
}

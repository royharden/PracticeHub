import { describe, expect, it } from 'vitest';

import type { AbnValidity } from './abn.js';
import { decideLiability } from './modifiers.js';

const signedWith = (option: AbnValidity['option']): AbnValidity => ({
  valid: true,
  defects: [],
  evidence: 'signed',
  option,
});
const valid: AbnValidity = signedWith('option-1-bill-medicare');
const refused: AbnValidity = { valid: true, defects: [], evidence: 'refused', option: null };
const invalid: AbnValidity = { valid: false, defects: ['late'], evidence: 'none', option: null };
const missing: AbnValidity = { valid: false, defects: ['missing'], evidence: 'none', option: null };

describe('WP-094 GA/GX/GY/GZ modifiers and patient liability', () => {
  it('GA: required ABN, valid, option 1: claim with GA, patient may be billed', () => {
    expect(
      decideLiability({ basis: 'required-abn', validity: valid, option: 'option-1-bill-medicare' }),
    ).toEqual({
      claim: 'submit',
      modifiers: ['GA'],
      patientBillLine: 'allowed',
      transferOfLiability: true,
      escalate: false,
      reason: 'valid-abn-option-1',
    });
  });

  it('GZ: required ABN missing or invalid: claim with GZ, patient bill line blocked, escalated, never cured', () => {
    for (const validity of [missing, invalid]) {
      const decision = decideLiability({
        basis: 'required-abn',
        validity,
        option: 'option-1-bill-medicare',
      });
      expect(decision).toMatchObject({
        claim: 'submit',
        modifiers: ['GZ'],
        patientBillLine: 'blocked',
        transferOfLiability: false,
        escalate: true,
      });
    }
  });

  it('GY: statutorily excluded without a voluntary ABN', () => {
    expect(
      decideLiability({ basis: 'statutorily-excluded', validity: missing, option: null }),
    ).toMatchObject({
      claim: 'submit',
      modifiers: ['GY'],
      patientBillLine: 'allowed',
    });
  });

  it('GX with GY: statutorily excluded with a valid voluntary ABN', () => {
    expect(
      decideLiability({
        basis: 'statutorily-excluded',
        validity: valid,
        option: 'option-1-bill-medicare',
      }),
    ).toMatchObject({ claim: 'submit', modifiers: ['GX', 'GY'], patientBillLine: 'allowed' });
  });

  it('option 2 means no claim is submitted, on a required or voluntary ABN', () => {
    expect(
      decideLiability({
        basis: 'required-abn',
        validity: signedWith('option-2-do-not-bill'),
        option: 'option-2-do-not-bill',
      }),
    ).toMatchObject({
      claim: 'do-not-submit',
      modifiers: [],
      patientBillLine: 'allowed',
    });
    expect(
      decideLiability({
        basis: 'statutorily-excluded',
        validity: signedWith('option-2-do-not-bill'),
        option: 'option-2-do-not-bill',
      }),
    ).toMatchObject({ claim: 'do-not-submit', modifiers: [] });
  });

  it('option 3 means no service, no claim and no patient bill', () => {
    expect(
      decideLiability({
        basis: 'required-abn',
        validity: signedWith('option-3-decline-service'),
        option: 'option-3-decline-service',
      }),
    ).toMatchObject({
      claim: 'do-not-submit',
      patientBillLine: 'blocked',
      reason: 'service-declined',
    });
  });

  it('a witnessed refusal bills under GA as self-pay-at-risk', () => {
    expect(
      decideLiability({ basis: 'required-abn', validity: refused, option: null }),
    ).toMatchObject({
      modifiers: ['GA'],
      patientBillLine: 'allowed',
      reason: 'abn-refusal-witnessed',
    });
  });

  it('a covered service needs no modifier and never bills the patient for the covered amount', () => {
    expect(decideLiability({ basis: 'covered', validity: missing, option: null })).toMatchObject({
      claim: 'submit',
      modifiers: [],
      patientBillLine: 'blocked',
    });
  });

  it('a valid signed ABN with no option recorded escalates instead of billing', () => {
    expect(decideLiability({ basis: 'required-abn', validity: signedWith(null) })).toMatchObject({
      claim: 'do-not-submit',
      patientBillLine: 'blocked',
      escalate: true,
      reason: 'abn-option-missing',
    });
  });
});

/**
 * WP-074 targeted fix (review D55-WP-074-a2-review-2, probes P1-P3).
 * Each test fails on the attempt-2 bundle and passes on the fix.
 */
import { describe, expect, it } from 'vitest';

import { partnerEvents } from './channels.js';
import { ReferralError, type ReferralCase } from './contracts.js';
import { applyPartnerEvent, instant, reviewResults, sendReferral } from './loop.js';
import { consentFor, day, directory, NPI, notes, opened, rails, RECORDS } from './test-harness.js';

const dir = directory();
const context = { directory: dir, notes: notes() };

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ReferralError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

function send(referral: ReferralCase, consent = consentFor(referral.destinationNpi)): ReferralCase {
  return sendReferral(
    referral,
    { consent, records: RECORDS, at: day(0), coordinatorId: 'synthetic-coordinator-1' },
    rails(dir),
  );
}

describe('[F1] patient state is validated, and full names resolve (probe P2)', () => {
  it('holds a Minnesota patient recorded as a full name for written consent', () => {
    for (const patientState of ['Minnesota', 'MINNESOTA', ' minnesota ']) {
      const held = send(opened({ patientState, destinationNpi: NPI.orthoMn }));
      expect(held.stage).toBe('created');
      expect(held.holds.at(-1)?.reason).toBe('mn-written-consent-required');
      expect(held.disclosures).toHaveLength(0);
    }
  });

  it('holds an unknown state instead of releasing records', () => {
    for (const patientState of ['Minnesotta', 'XX', '']) {
      const held = send(opened({ patientState, destinationNpi: NPI.orthoMn }));
      expect(held.stage).toBe('created');
      expect(held.holds.at(-1)?.reason).toBe('patient-state-unknown');
      expect(held.disclosures).toHaveLength(0);
    }
    expect(send(opened({ patientState: 'Nevada' })).stage).toBe('sent');
  });
});

describe('[F2] a decline after the visit keeps the loop open for results (probe P1)', () => {
  it('accepts a later consult note after a post-visit decline, and it must be reviewed', () => {
    let referral = send(opened());
    const [seen, declined, note] = partnerEvents('esp', referral.referralId, referral.patientRef, [
      { kind: 'seen', at: day(5) },
      { kind: 'declined', at: day(6), detail: 'no further visits' },
      { kind: 'consult-note', at: day(9), consultNoteRef: 'synthetic-consult-note-0001' },
    ]);
    if (!seen || !declined || !note) throw new Error('script produced no events');
    referral = applyPartnerEvent(referral, seen, context);
    referral = applyPartnerEvent(referral, declined, context);
    expect(referral.closure).toBeNull();
    expect(referral.stage).toBe('seen');
    expect(referral.escalations.at(-1)?.to).toBe('referral-coordinator');
    referral = applyPartnerEvent(referral, note, context);
    expect(referral.stage).toBe('results-returned');
    expect(reviewResults(referral, 'synthetic-clinician-a', day(10)).stage).toBe('reviewed');
  });
});

describe('[F3] instants are parsed strictly (probe P3)', () => {
  it('refuses non-ISO and impossible dates, and accepts zoned ISO instants', () => {
    for (const bad of [
      '1',
      'June 2099',
      '2026-02-30T00:00:00Z',
      '2026-01-05',
      '2026-01-05T25:00:00Z',
      '2026-01-05T10:00:00',
    ]) {
      expect(codeOf(() => instant(bad, 'probe'))).toBe('INVALID_INSTANT');
    }
    expect(instant('2026-01-05T15:00:00.000Z', 'ok')).toBe(Date.parse('2026-01-05T15:00:00.000Z'));
    expect(instant('2026-01-05T10:00:00-05:00', 'ok')).toBe(Date.parse('2026-01-05T15:00:00Z'));
  });

  it('treats a malformed consent expiry like "June 2099" as no consent', () => {
    const held = send(opened(), consentFor(NPI.cardiology, { expiresAt: 'June 2099' }));
    expect(held.stage).toBe('created');
    expect(held.holds.at(-1)?.reason).toBe('consent-required');
    expect(held.disclosures).toHaveLength(0);
  });
});

/**
 * WP-074 rework 1 regressions (review D55-WP-074-a1-review-1, probes A-E).
 * Each test fails on the attempt-1 bundle and passes on attempt 2.
 */
import { describe, expect, it } from 'vitest';

import { partnerEvents } from './channels.js';
import { ReferralError, type ReferralCase } from './contracts.js';
import { parseDirectorySlice } from './directory.js';
import { applyPartnerEvent, closeLoop, escalate, logOutreach, sendReferral } from './loop.js';
import {
  consentFor,
  day,
  directory,
  NPI,
  notes,
  opened,
  rails,
  readFixture,
  RECORDS,
} from './test-harness.js';

const dir = directory();

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ReferralError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

function sendWith(referral: ReferralCase, consent: ReturnType<typeof consentFor>): ReferralCase {
  return sendReferral(
    referral,
    { consent, records: RECORDS, at: day(0), coordinatorId: 'synthetic-coordinator-1' },
    rails(dir),
  );
}

describe('[high] an unparseable consent expiry is no consent (probe A)', () => {
  it('holds the referral and discloses nothing', () => {
    const held = sendWith(opened(), consentFor(NPI.cardiology, { expiresAt: 'not-a-date' }));
    expect(held.stage).toBe('created');
    expect(held.disclosures).toHaveLength(0);
    expect(held.holds.at(-1)?.reason).toBe('consent-required');
  });

  it('refuses an unparseable send instant outright', () => {
    expect(
      codeOf(() =>
        sendReferral(
          opened(),
          {
            consent: consentFor(NPI.cardiology),
            records: RECORDS,
            at: 'garbage',
            coordinatorId: 'synthetic-coordinator-1',
          },
          rails(dir),
        ),
      ),
    ).toBe('INVALID_INSTANT');
  });
});

describe('[high] a decline cannot close a loop whose results await review (probe B)', () => {
  it('refuses a declined event after results-returned and keeps the loop open', () => {
    let referral = sendWith(opened(), consentFor(NPI.cardiology));
    const [note, declined] = partnerEvents('esp', referral.referralId, referral.patientRef, [
      { kind: 'consult-note', at: day(9), consultNoteRef: 'synthetic-consult-note-0001' },
      { kind: 'declined', at: day(10), detail: 'late decline' },
    ]);
    if (!note || !declined) throw new Error('script produced no events');
    referral = applyPartnerEvent(referral, note, { directory: dir, notes: notes() });
    expect(
      codeOf(() => applyPartnerEvent(referral, declined, { directory: dir, notes: notes() })),
    ).toBe('DECLINE_AFTER_RESULTS');
    expect(referral.stage).toBe('results-returned');
    expect(referral.closure).toBeNull();
  });
});

describe('[medium] an unparseable instant never satisfies the outer bound (probe C)', () => {
  it('refuses to close at a garbage instant', () => {
    let referral = sendWith(opened(), consentFor(NPI.cardiology));
    referral = logOutreach(referral, { at: day(20), method: 'call', note: 'left message' });
    referral = escalate(referral, day(45), 'referring-clinician', 'outer bound passed');
    expect(
      codeOf(() =>
        closeLoop(
          referral,
          'no-results-after-outer-bound',
          'garbage',
          'synthetic-coordinator-1',
          dir,
        ),
      ),
    ).toBe('INVALID_INSTANT');
    expect(referral.closure).toBeNull();
  });
});

describe('[medium] Minnesota is matched case-insensitively (probe D)', () => {
  it('applies the written-consent rule to mn, Mn and " MN "', () => {
    for (const patientState of ['mn', 'Mn', ' MN ']) {
      const held = sendWith(
        opened({ patientState, destinationNpi: NPI.orthoMn }),
        consentFor(NPI.orthoMn),
      );
      expect(held.stage).toBe('created');
      expect(held.holds.at(-1)?.reason).toBe('mn-written-consent-required');
      expect(held.disclosures).toHaveLength(0);
    }
  });
});

describe('[medium] consent is bound to the patient and tenant (probe E)', () => {
  it('holds a send under another patient’s or tenant’s consent', () => {
    for (const other of [
      consentFor(NPI.cardiology, {
        patientRef: 'synthetic-patient-9999',
        consentRef: 'other-patient',
      }),
      consentFor(NPI.cardiology, { tenantId: 'riverbend-synthetic', consentRef: 'other-tenant' }),
    ]) {
      const held = sendWith(opened(), other);
      expect(held.stage).toBe('created');
      expect(held.disclosures).toHaveLength(0);
      expect(held.holds.at(-1)?.reason).toBe('consent-required');
    }
  });
});

describe('[low] a directory slice with a duplicate NPI is refused', () => {
  it('rejects the slice instead of keeping the last row', () => {
    const raw = readFixture('nppes-slice.v1.json') as { entries: unknown[] };
    const duplicate = { ...raw, entries: [...raw.entries, raw.entries[0]] };
    expect(codeOf(() => parseDirectorySlice(duplicate))).toBe('DIRECTORY_DUPLICATE');
  });
});

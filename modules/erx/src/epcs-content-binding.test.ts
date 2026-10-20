/**
 * WP-067 attempt 3 targeted fix (review D46-WP-067-a2-review-2 N1): an EPCS signature is bound to
 * the prescription content that was challenged. Fails on candidates/D52-WP-067-a2, passes on a3.
 */
import { describe, expect, it } from 'vitest';

import { ComposerError, EpcsSimulator, type PrescriptionDraft } from './native-composer.js';

const PRESCRIBER = '1234567893';
const PASSWORD = 'synthetic-pass-a';
const AT = '2026-02-01T09:00:00Z';

const d1: PrescriptionDraft = {
  draftId: 'rx-probe-1',
  prescriberNpi: PRESCRIBER,
  patientRef: 'pt-synth-1',
  medicationRef: 'med:low-dose',
  sig: '1 tab daily',
  quantity: 30,
  jurisdiction: 'FL',
  controlledSchedule: 'IV',
};

function challengeAndCode(sim: EpcsSimulator, device: ReturnType<EpcsSimulator['enroll']>) {
  const challenge = sim.issueChallenge(PRESCRIBER, d1.draftId, d1);
  return {
    challengeId: challenge.challengeId,
    password: PASSWORD,
    deviceCode: device.code(challenge),
    at: AT,
  };
}

describe('WP-067 EPCS signature is bound to the challenged prescription content', () => {
  it("refuses the reviewer's altered-d1 probe: same draftId, different drug, sig and schedule", () => {
    const sim = new EpcsSimulator();
    const device = sim.enroll(PRESCRIBER, PASSWORD);
    const input = challengeAndCode(sim, device);
    const altered: PrescriptionDraft = {
      ...d1,
      medicationRef: 'med:oxycodone-80',
      sig: '2 tabs q4h',
      controlledSchedule: 'II',
    };
    expect(() => sim.sign(altered, input)).toThrowError(new ComposerError('EPCS_CONTENT_MISMATCH'));
    // The refused attempt does not consume the challenge: the unaltered prescription still signs.
    expect(sim.sign(d1, input)).toMatchObject({ draftId: 'rx-probe-1', prescriberNpi: PRESCRIBER });
  });

  it.each([
    ['the drug', { medicationRef: 'med:other' }],
    ['the sig', { sig: '2 tabs daily' }],
    ['the quantity', { quantity: 90 }],
    ['the schedule', { controlledSchedule: 'III' as const }],
    ['the patient', { patientRef: 'pt-synth-2' }],
    ['the jurisdiction', { jurisdiction: 'NV' }],
  ])('refuses a signature when %s differs from what was challenged', (_label, change) => {
    const sim = new EpcsSimulator();
    const device = sim.enroll(PRESCRIBER, PASSWORD);
    const input = challengeAndCode(sim, device);
    expect(() => sim.sign({ ...d1, ...change }, input)).toThrowError(
      new ComposerError('EPCS_CONTENT_MISMATCH'),
    );
  });

  it('control: the unaltered prescription signs', () => {
    const sim = new EpcsSimulator();
    const device = sim.enroll(PRESCRIBER, PASSWORD);
    expect(sim.sign(d1, challengeAndCode(sim, device)).draftId).toBe('rx-probe-1');
  });
});

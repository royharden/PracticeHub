/**
 * Hardening H-23 (NR-177): the transmit path verifies that the EPCS signature matches the canonical
 * content hash of the payload being transmitted, and refuses a mismatch (tamper between sign and
 * transmit). Uses only APIs that exist in candidates/D52-WP-067-a3, where it fails on behaviour.
 */
import { describe, expect, it } from 'vitest';

import { ErxEmbed, ErxError, fixtureVendorId } from './erx.js';
import {
  ComposerError,
  composePayload,
  EpcsSimulator,
  NativeRail,
  prescriptionContentHash,
  type ComposedPrescription,
  type PrescriptionDraft,
  type SignedPrescription,
} from './native-composer.js';

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

function signD1(): SignedPrescription {
  const sim = new EpcsSimulator();
  const device = sim.enroll(PRESCRIBER, PASSWORD);
  const challenge = sim.issueChallenge(PRESCRIBER, d1.draftId, d1);
  return sim.sign(d1, {
    challengeId: challenge.challengeId,
    password: PASSWORD,
    deviceCode: device.code(challenge),
    at: AT,
  });
}

function liveRail() {
  const sent: string[] = [];
  const rail = new NativeRail(
    { transmit: (payload) => void sent.push(payload.medicationRef) },
    'live',
  );
  return { rail, sent };
}

const tampered: readonly (readonly [string, Partial<ComposedPrescription>])[] = [
  [
    'the drug, sig and schedule (the reviewer probe)',
    { medicationRef: 'med:oxycodone-80', sig: '2 tabs q4h', controlledSchedule: 'II' },
  ],
  ['the quantity', { quantity: 90 }],
  ['the patient', { patientRef: 'pt-synth-2' }],
  ['the jurisdiction', { jurisdiction: 'NV' }],
  ['the prescriber', { prescriberNpi: '1245319599' }],
];

describe('NR-177: a live transmit carries only the content the signature attests to', () => {
  for (const [label, change] of tampered) {
    it(`refuses a payload altered after signing (${label}) and never reaches the port`, () => {
      const signature = signD1();
      const { rail, sent } = liveRail();
      expect(() => rail.send({ ...composePayload(d1), ...change }, signature)).toThrowError(
        new ComposerError('EPCS_CONTENT_MISMATCH'),
      );
      expect(sent).toEqual([]);
    });
  }

  it('control: the exact signed content transmits once, and the signature names its content hash', () => {
    const signature = signD1();
    expect(signature.contentHash).toBe(prescriptionContentHash(d1));
    const { rail, sent } = liveRail();
    rail.send(composePayload(d1), signature);
    expect(sent).toEqual(['med:low-dose']);
  });
});

describe('WP-066 pass-2 note F5: a whitespace-only medicationRef is invalid', () => {
  it('refuses a transmit whose medicationRef is only whitespace', () => {
    expect(() =>
      new ErxEmbed().transmit({
        tenantId: 'tenant-synth-01',
        vendorId: fixtureVendorId,
        kind: 'refill',
        itemId: 'rx-ws-1',
        jurisdiction: 'FL',
        medicationRef: '   ',
      }),
    ).toThrowError(new ErxError('INVALID_INPUT'));
  });
});

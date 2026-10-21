import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as nativeModule from './native-composer.js';
import {
  ComposerError,
  composePayload,
  EpcsSimulator,
  runNativeShadow,
  validateDraft,
  type EpcsDevice,
  type PdmpPort,
  type PrescriptionDraft,
  type ShadowCorpusEntry,
  type SignedPrescription,
} from './native-composer.js';

const directory = dirname(fileURLToPath(import.meta.url));
const corpus = (
  JSON.parse(readFileSync(resolve(directory, '../fixtures/native-shadow-corpus.json'), 'utf8')) as {
    entries: ShadowCorpusEntry[];
  }
).entries;

const PRESCRIBER_A = '1234567893';
const PRESCRIBER_B = '1245319599';
const PASSWORD_A = 'synthetic-pass-a';
const PASSWORD_B = 'synthetic-pass-b';
const AT = '2026-02-01T09:00:00Z';

function setup() {
  const sim = new EpcsSimulator();
  const devices: Record<string, EpcsDevice> = {
    [PRESCRIBER_A]: sim.enroll(PRESCRIBER_A, PASSWORD_A),
    [PRESCRIBER_B]: sim.enroll(PRESCRIBER_B, PASSWORD_B),
  };
  const passwords: Record<string, string> = {
    [PRESCRIBER_A]: PASSWORD_A,
    [PRESCRIBER_B]: PASSWORD_B,
  };
  let signs = 0;
  const sign = (draft: PrescriptionDraft): SignedPrescription => {
    const challenge = sim.issueChallenge(draft.prescriberNpi, draft.draftId, draft);
    const device = devices[draft.prescriberNpi];
    if (device === undefined) throw new ComposerError('EPCS_DENIED');
    const signed = sim.sign(draft, {
      challengeId: challenge.challengeId,
      password: passwords[draft.prescriberNpi] ?? '',
      deviceCode: device.code(challenge),
      at: AT,
    });
    signs += 1;
    return signed;
  };
  const transmitted: string[] = [];
  const transmit = {
    transmit: (payload: { draftId: string }) => void transmitted.push(payload.draftId),
  };
  const pdmp: PdmpPort = { check: () => 'checked' };
  return { sim, devices, sign, transmit, transmitted, pdmp, signs: () => signs };
}

const draftA: PrescriptionDraft = {
  draftId: 'rx-sign-1',
  prescriberNpi: PRESCRIBER_A,
  medicationRef: 'med-synth-oxycodone-5mg',
  sig: 'Take 1 tablet every 6 hours as needed',
  jurisdiction: 'FL',
  controlledSchedule: 'II',
};

describe('WP-067 native-shadow parity harness (review F1)', () => {
  it('composes every composable corpus draft to its hand-written reference and transmits nothing', () => {
    const h = setup();
    const report = runNativeShadow(corpus, h);
    expect(report.results).toHaveLength(6);
    expect(report.composable).toBe(3);
    expect(report.composedMatching).toBe(3);
    expect(report.composeRate).toBe(1);
    expect(report.outcomeMismatches).toEqual([]);
    expect(report.transmitCalls).toBe(0);
    expect(h.transmitted).toEqual([]);
    expect(report.pdmpChecks).toBe(1);
    expect(report.parity).toBe(true);
    expect(h.signs()).toBe(3);
    expect(
      report.results
        .filter((r) => r.outcome === 'failed')
        .map((r) => [r.draftId, r.outcome === 'failed' && r.reason]),
    ).toEqual([
      ['rx-xx-1', 'JURISDICTION_BLOCKED'],
      ['rx-dir-miss', 'DIRECTORY_MISS'],
      ['rx-no-sig', 'INVALID_DRAFT'],
    ]);
  });

  it('fails parity when the native composer drops the sig (mutant)', () => {
    const report = runNativeShadow(corpus, {
      ...setup(),
      compose: (draft) => ({ ...composePayload(draft), sig: '' }),
    });
    expect(report.parity).toBe(false);
    expect(report.composeRate).toBe(0);
    const first = report.results[0];
    expect(first?.outcome === 'composed' && first.mismatches.map((m) => m.field)).toEqual(['sig']);
  });

  it('fails parity when the native composer adds or renames a field (mutant)', () => {
    const report = runNativeShadow(corpus, {
      ...setup(),
      compose: (draft) => {
        const { jurisdiction, ...rest } = composePayload(draft);
        return { ...rest, state: jurisdiction } as unknown as ReturnType<typeof composePayload>;
      },
    });
    expect(report.parity).toBe(false);
    const first = report.results[0];
    expect(first?.outcome === 'composed' && first.mismatches.map((m) => m.field)).toEqual([
      'jurisdiction',
      'state',
    ]);
  });

  it('counts transmits at the port: a live rail is seen (control for the zero)', () => {
    const h = setup();
    const report = runNativeShadow(corpus, { ...h, mode: 'live' });
    expect(report.transmitCalls).toBe(3);
    expect(h.transmitted).toEqual(['rx-fl-1', 'rx-fl-cii', 'rx-fl-2']);
    expect(report.parity).toBe(false);
  });

  it('one bad draft never aborts the batch, and the rate drops for a composable draft that fails', () => {
    const report = runNativeShadow(corpus, { ...setup(), pdmp: { check: () => 'unavailable' } });
    expect(report.results).toHaveLength(6);
    expect(report.results.find((r) => r.draftId === 'rx-fl-cii')).toEqual({
      draftId: 'rx-fl-cii',
      outcome: 'failed',
      reason: 'PDMP_REQUIRED',
    });
    expect(report.composedMatching).toBe(2);
    expect(report.composeRate).toBeCloseTo(2 / 3);
    expect(report.outcomeMismatches).toEqual(['rx-fl-cii']);
    expect(report.parity).toBe(false);
  });

  it('flags an expected failure that composes instead (corpus outcome mismatch)', () => {
    const permissive = {
      resolve: (jurisdiction: string) => ({
        topic: 'erx-epcs-pdmp' as const,
        jurisdiction,
        resolved: true,
        obligations: [],
      }),
    };
    const report = runNativeShadow(corpus, { ...setup(), jurisdictions: permissive });
    expect(report.outcomeMismatches).toEqual(['rx-xx-1']);
    expect(report.parity).toBe(false);
  });
});

describe('WP-067 EPCS two-factor at signing (review F2)', () => {
  it('signs one prescription with the prescriber password and device code', () => {
    const { sim, devices } = setup();
    const challenge = sim.issueChallenge(PRESCRIBER_A, draftA.draftId, draftA);
    const signed = sim.sign(draftA, {
      challengeId: challenge.challengeId,
      password: PASSWORD_A,
      deviceCode: devices[PRESCRIBER_A]?.code(challenge) ?? '',
      at: AT,
    });
    expect(signed).toMatchObject({
      draftId: 'rx-sign-1',
      prescriberNpi: PRESCRIBER_A,
      challengeId: challenge.challengeId,
    });
  });

  it('refuses a wrong second factor, and a wrong password', () => {
    const { sim, devices } = setup();
    const challenge = sim.issueChallenge(PRESCRIBER_A, draftA.draftId, draftA);
    expect(() =>
      sim.sign(draftA, {
        challengeId: challenge.challengeId,
        password: PASSWORD_A,
        deviceCode: '0'.repeat(64),
        at: AT,
      }),
    ).toThrowError(new ComposerError('EPCS_DENIED'));
    expect(() =>
      sim.sign(draftA, {
        challengeId: challenge.challengeId,
        password: 'not-the-password',
        deviceCode: devices[PRESCRIBER_A]?.code(challenge) ?? '',
        at: AT,
      }),
    ).toThrowError(new ComposerError('EPCS_DENIED'));
  });

  it('refuses a replayed token', () => {
    const { sim, devices } = setup();
    const challenge = sim.issueChallenge(PRESCRIBER_A, draftA.draftId, draftA);
    const input = {
      challengeId: challenge.challengeId,
      password: PASSWORD_A,
      deviceCode: devices[PRESCRIBER_A]?.code(challenge) ?? '',
      at: AT,
    };
    sim.sign(draftA, input);
    expect(() => sim.sign(draftA, input)).toThrowError(new ComposerError('EPCS_REPLAY'));
  });

  it('refuses factors belonging to another prescriber', () => {
    const { sim, devices } = setup();
    const challenge = sim.issueChallenge(PRESCRIBER_A, draftA.draftId, draftA);
    // Prescriber B's password and device on a challenge for A's prescription.
    expect(() =>
      sim.sign(draftA, {
        challengeId: challenge.challengeId,
        password: PASSWORD_B,
        deviceCode: devices[PRESCRIBER_B]?.code(challenge) ?? '',
        at: AT,
      }),
    ).toThrowError(new ComposerError('EPCS_DENIED'));
    // B's own valid challenge used to sign A's prescription.
    const forB = sim.issueChallenge(PRESCRIBER_B, draftA.draftId, {
      ...draftA,
      prescriberNpi: PRESCRIBER_B,
    });
    expect(() =>
      sim.sign(draftA, {
        challengeId: forB.challengeId,
        password: PASSWORD_B,
        deviceCode: devices[PRESCRIBER_B]?.code(forB) ?? '',
        at: AT,
      }),
    ).toThrowError(new ComposerError('EPCS_WRONG_PRESCRIBER'));
  });

  it('binds a challenge to one draft, refuses unknown challenges, and exports no static credential', () => {
    const { sim, devices } = setup();
    const challenge = sim.issueChallenge(PRESCRIBER_A, 'rx-other', {
      ...draftA,
      draftId: 'rx-other',
    });
    expect(() =>
      sim.sign(draftA, {
        challengeId: challenge.challengeId,
        password: PASSWORD_A,
        deviceCode: devices[PRESCRIBER_A]?.code(challenge) ?? '',
        at: AT,
      }),
    ).toThrowError(new ComposerError('EPCS_WRONG_PRESCRIBER'));
    expect(() =>
      sim.sign(draftA, { challengeId: 'epcs-999', password: PASSWORD_A, deviceCode: 'x', at: AT }),
    ).toThrowError(new ComposerError('EPCS_UNKNOWN_CHALLENGE'));
    expect(Object.keys(nativeModule)).not.toContain('epcsSimulator');
    expect(JSON.stringify(devices[PRESCRIBER_A])).not.toContain(PASSWORD_A);
  });

  it('the shadow harness signs each draft separately: a signer that refuses fails only that draft', () => {
    const h = setup();
    const report = runNativeShadow(corpus, {
      ...h,
      sign: (draft) => {
        if (draft.draftId === 'rx-fl-2') throw new ComposerError('EPCS_DENIED');
        return h.sign(draft);
      },
    });
    expect(report.results.find((r) => r.draftId === 'rx-fl-2')).toEqual({
      draftId: 'rx-fl-2',
      outcome: 'failed',
      reason: 'EPCS_DENIED',
    });
    expect(report.composedMatching).toBe(2);
  });
});

describe('WP-067 native validator (review F3)', () => {
  it('rejects the illegal fixture jurisdiction XX and an unknown one', () => {
    expect(() => validateDraft({ ...draftA, jurisdiction: 'XX' })).toThrowError(
      new ComposerError('JURISDICTION_BLOCKED'),
    );
    expect(() => validateDraft({ ...draftA, jurisdiction: 'ZZ' })).toThrowError(
      new ComposerError('JURISDICTION_BLOCKED'),
    );
  });

  it.each([
    ['an empty sig', { sig: ' ' }],
    ['an empty medication', { medicationRef: '' }],
    ['a malformed NPI', { prescriberNpi: '123' }],
    ['a malformed draft id', { draftId: 'bad id' }],
    ['an unknown schedule', { controlledSchedule: 'I' as unknown as 'II' }],
  ])('rejects %s', (_label, change) => {
    expect(() => validateDraft({ ...draftA, ...change })).toThrowError(
      new ComposerError('INVALID_DRAFT'),
    );
  });

  it('rejects an unknown prescriber and accepts a complete FL draft', () => {
    expect(() => validateDraft({ ...draftA, prescriberNpi: '1999999999' })).toThrowError(
      new ComposerError('DIRECTORY_MISS'),
    );
    expect(() => validateDraft(draftA)).not.toThrow();
  });
});

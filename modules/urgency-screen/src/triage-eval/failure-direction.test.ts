import { describe, expect, it } from 'vitest';
import { compactReading, normalizeForScreen } from '../normalize.js';
import { LANDED_URGENCY_SCREEN, inputForCase } from './evaluate.js';
import { FAULTS, runFailureDirectionSuite } from './failure-direction.js';
import { GOLDEN_SET_V1, GOLDEN_SET_V2 } from './golden-set.js';
import type { FailureDirectionReport, FaultId, GoldenCase } from './types.js';
import {
  alwaysUrgentCandidate,
  killSwitchIgnoringCandidate,
  killSwitchRoutineCandidate,
  normalizingUnionCandidate,
  throwingCandidate,
} from './test-doubles.js';

function inducedFor(report: FailureDirectionReport, fault: FaultId): string[] {
  return report.outcomes
    .filter((outcome) => outcome.fault === fault && outcome.induced)
    .map((outcome) => outcome.caseId);
}

describe('WP-104 failure-direction suite on the landed WP-045 screen', () => {
  const report = runFailureDirectionSuite(LANDED_URGENCY_SCREEN, GOLDEN_SET_V1);

  it('runs every applicable fault on every golden case', () => {
    expect(FAULTS.map((spec) => spec.fault)).toEqual([
      'kill-switch',
      'uppercase',
      'curly-apostrophe',
      'extra-whitespace',
      'language-unknown',
      'unmatched-identity',
      'business-hours',
      'voice-transcript',
      'no-break-space',
      'zero-width-space',
      'zero-width-joiner',
      'zero-width-non-joiner',
      'soft-hyphen',
      'full-width',
      'decomposed-accents',
      'mislabel-en-as-es',
      'mislabel-es-as-en',
      'zero-width-separator',
    ]);
    const killSwitch = report.outcomes.filter((outcome) => outcome.fault === 'kill-switch');
    expect(killSwitch).toHaveLength(GOLDEN_SET_V1.cases.length);
    expect(report.outcomes.length).toBeGreaterThan(GOLDEN_SET_V1.cases.length * 5);
  });

  it('FAILURE: a tripped kill switch hands every case to a human as urgent', () => {
    const killSwitch = report.outcomes.filter((outcome) => outcome.fault === 'kill-switch');
    expect(killSwitch.every((outcome) => outcome.safe)).toBe(true);
    expect(killSwitch.every((outcome) => outcome.routing === 'human_review')).toBe(true);
    expect(killSwitch.every((outcome) => outcome.observed === 'urgent')).toBe(true);
  });

  it('uppercase, unmatched identity, business hours and voice transcript induce no under-triage', () => {
    for (const fault of [
      'uppercase',
      'unmatched-identity',
      'business-hours',
      'voice-transcript',
    ] as const) {
      expect(inducedFor(report, fault)).toEqual([]);
    }
  });

  it('typography and language faults induce no under-triage; the 23 base-screen cases stay urgent', () => {
    expect(inducedFor(report, 'curly-apostrophe')).toEqual([]);
    expect(inducedFor(report, 'extra-whitespace')).toEqual([]);
    expect(inducedFor(report, 'language-unknown')).toEqual([]);
    expect(report.induced).toEqual([]);
    expect(report.unsafe).toEqual([]);
    const unsafe = report.outcomes.filter((outcome) => !outcome.safe);
    expect(unsafe).toEqual([]);
    const baseScreenInduced = [
      'en-u-02|curly-apostrophe',
      ...['en-u-01', 'en-u-02', 'en-u-03', 'en-u-08', 'en-u-09', 'en-u-10'].map(
        (id) => `${id}|extra-whitespace`,
      ),
      ...['es-u-01', 'es-u-02', 'es-u-06', 'un-u-04'].map((id) => `${id}|extra-whitespace`),
      ...['en-u-01', 'en-u-02', 'en-u-03', 'en-u-04', 'en-u-05', 'en-u-06', 'en-u-07'].map(
        (id) => `${id}|language-unknown`,
      ),
      ...['en-u-08', 'es-u-01', 'es-u-02', 'es-u-04', 'es-u-05'].map(
        (id) => `${id}|language-unknown`,
      ),
    ];
    expect(baseScreenInduced).toHaveLength(23);
    const byKey = new Map(report.outcomes.map((outcome) => [outcome.key, outcome]));
    for (const key of baseScreenInduced) {
      expect(byKey.get(key)?.observed, key).toBe('urgent');
      expect(byKey.get(key)?.safe, key).toBe(true);
    }
    expect(report.outcomes).toHaveLength(579);
  });

  it('every Unicode and mislabel fault induces no under-triage on revision 1', () => {
    for (const spec of FAULTS) {
      expect(inducedFor(report, spec.fault), spec.fault).toEqual([]);
    }
  });
});

/** The two paraphrases the WP-045 a4 keyword screen misses: probes, unsafe under any fault. */
const KNOWN_KEYWORD_GAPS = ['own-oh-en-03', 'own-o2-en-05'];

/**
 * The a3 finding: a message that already carries one invisible character (U+2060, word joiner, in
 * 'kill<WJ>myself') and gets a different one inside a word. WP-045 a4 reads it with every format
 * character deleted and the spaces closed up, so each of these must be urgent, never induced.
 */
const MIXED_FORMAT_CHARACTER_KEYS = [
  'rv-ty-18|zero-width-space',
  'rv-ty-18|zero-width-joiner',
  'rv-ty-18|zero-width-non-joiner',
  'rv-ty-18|soft-hyphen',
];

describe('WP-104 text faults change bytes, not meaning', () => {
  it('each text fault rewrites the message and normalizes back to the same words', () => {
    const english = inputForCase(GOLDEN_SET_V1.cases[0] as GoldenCase);
    const spanish = inputForCase(
      GOLDEN_SET_V1.cases.find((item) => item.caseId === 'es-u-03') as GoldenCase,
    );
    const textFaults: readonly [FaultId, typeof english][] = [
      ['no-break-space', english],
      ['zero-width-space', english],
      ['zero-width-joiner', english],
      ['zero-width-non-joiner', english],
      ['soft-hyphen', english],
      ['full-width', english],
      ['decomposed-accents', spanish],
    ];
    for (const [fault, input] of textFaults) {
      const spec = FAULTS.find((item) => item.fault === fault);
      const perturbed = spec?.perturb(input).text ?? input.text;
      expect(perturbed, fault).not.toBe(input.text);
      expect(normalizeForScreen(perturbed), fault).toBe(normalizeForScreen(input.text));
    }
  });

  it('the zero-width separator rewrites every space and keeps the words in the compact reading', () => {
    const input = inputForCase(GOLDEN_SET_V1.cases[0] as GoldenCase);
    const spec = FAULTS.find((item) => item.fault === 'zero-width-separator');
    const perturbed = spec?.perturb(input).text ?? input.text;
    expect(perturbed).not.toBe(input.text);
    expect(perturbed).not.toContain(' ');
    expect(compactReading(perturbed)).toBe(normalizeForScreen(input.text).replaceAll(' ', ''));
  });
});

describe('WP-104 failure-direction suite on golden revision 2 (WP-045 a4)', () => {
  const report = runFailureDirectionSuite(LANDED_URGENCY_SCREEN, GOLDEN_SET_V2);

  it('exercises every new fault on at least fifty cases', () => {
    expect(report.outcomes).toHaveLength(5273);
    for (const fault of [
      'no-break-space',
      'zero-width-space',
      'zero-width-joiner',
      'zero-width-non-joiner',
      'soft-hyphen',
      'full-width',
      'decomposed-accents',
      'mislabel-en-as-es',
      'mislabel-es-as-en',
      'zero-width-separator',
    ] as const) {
      const applied = report.outcomes.filter((outcome) => outcome.fault === fault).length;
      expect(applied, fault).toBeGreaterThanOrEqual(50);
    }
  });

  it('the kill switch is safe on all 351 cases', () => {
    const killSwitch = report.outcomes.filter((outcome) => outcome.fault === 'kill-switch');
    expect(killSwitch).toHaveLength(351);
    expect(killSwitch.every((outcome) => outcome.safe)).toBe(true);
  });

  it('no fault induces under-triage on WP-045 a4', () => {
    expect(report.induced).toEqual([]);
  });

  it('the mixed invisible-character cases are urgent and safe on WP-045 a4', () => {
    for (const key of MIXED_FORMAT_CHARACTER_KEYS) {
      const outcome = report.outcomes.find((item) => item.key === key);
      expect(outcome?.expected, key).toBe('urgent');
      expect(outcome?.observed, key).toBe('urgent');
      expect(outcome?.safe, key).toBe(true);
    }
  });

  it('every unsafe outcome is one of the two pinned keyword gaps', () => {
    expect(report.unsafe).toHaveLength(30);
    expect(report.unsafe.every((key) => KNOWN_KEYWORD_GAPS.includes(key.split('|')[0] ?? ''))).toBe(
      true,
    );
  });
});

describe('WP-104 the failure-direction suite can fail and can pass', () => {
  it('catches a candidate that ignores the kill switch on every case', () => {
    const report = runFailureDirectionSuite(killSwitchIgnoringCandidate, GOLDEN_SET_V1);
    const killSwitch = report.outcomes.filter((outcome) => outcome.fault === 'kill-switch');
    expect(killSwitch.every((outcome) => !outcome.safe)).toBe(true);
    expect(report.unsafe).toContain('en-r-01|kill-switch');
  });

  it('a kill-switch hand-off labelled routine is unsafe even with no contract breach', () => {
    const report = runFailureDirectionSuite(killSwitchRoutineCandidate, GOLDEN_SET_V1);
    const killSwitch = report.outcomes.filter((outcome) => outcome.fault === 'kill-switch');
    expect(killSwitch.every((outcome) => outcome.routing === 'human_review')).toBe(true);
    expect(killSwitch.every((outcome) => outcome.observed === 'routine' && !outcome.safe)).toBe(
      true,
    );
  });

  it('treats a thrown classifier as unsafe under every fault', () => {
    const report = runFailureDirectionSuite(throwingCandidate, GOLDEN_SET_V1);
    expect(report.outcomes.every((outcome) => !outcome.safe && outcome.observed === 'error')).toBe(
      true,
    );
  });

  it('a normalizing, vocabulary-union candidate induces no under-triage under any fault', () => {
    const report = runFailureDirectionSuite(normalizingUnionCandidate, GOLDEN_SET_V1);
    expect(report.induced).toEqual([]);
    const stillMissed = [...new Set(report.unsafe.map((key) => key.split('|')[0]))];
    expect(stillMissed).toEqual([]);
  });

  it('over-triage is the safe direction: always-urgent is unsafe nowhere', () => {
    const report = runFailureDirectionSuite(alwaysUrgentCandidate, GOLDEN_SET_V1);
    expect(report.unsafe).toEqual([]);
    expect(report.overTriage).toBeGreaterThan(0);
  });
});

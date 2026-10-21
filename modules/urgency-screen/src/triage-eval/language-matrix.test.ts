import { describe, expect, it } from 'vitest';
import { EMERGENCY_LINE } from '../types.js';
import { LANDED_URGENCY_SCREEN, evaluateClassifier } from './evaluate.js';
import { GOLDEN_SET_V1, GOLDEN_SET_V2, goldenSetDigest } from './golden-set.js';
import {
  alwaysRoutineCandidate,
  alwaysUrgentCandidate,
  disclaimerDroppingCandidate,
  throwingCandidate,
} from './test-doubles.js';

/**
 * Probes the landed screen misses. WP-104 attempt 1 found seven on the base screen (pr-en-01,
 * pr-en-02, pr-en-03, pr-es-01, pr-es-02, pr-un-01, pr-mis-01); WP-045 attempt 2 closed all of
 * them. Any miss that comes back fails this pin. When the screen changes, re-derive this list;
 * never edit it to match.
 */
const LANDED_PROBE_MISSES: readonly string[] = [];

describe('WP-104 language matrix on the landed WP-045 screen', () => {
  const report = evaluateClassifier(LANDED_URGENCY_SCREEN, GOLDEN_SET_V1);

  it('evaluates every golden case against the exact golden bytes', () => {
    expect(report.outcomes).toHaveLength(GOLDEN_SET_V1.cases.length);
    expect(report.goldenSetDigest).toBe(goldenSetDigest(GOLDEN_SET_V1));
    expect(report.classifierVersions).toEqual(['keyword-classifier.v4+ai-screen-double.v4']);
    expect(report.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(evaluateClassifier(LANDED_URGENCY_SCREEN, GOLDEN_SET_V1).evidenceDigest).toBe(
      report.evidenceDigest,
    );
  });

  it('passes the matrix in en, es and unknown: every seed urgent case is caught', () => {
    expect(report.matrix.map((cell) => [cell.language, cell.passes])).toEqual([
      ['en', true],
      ['es', true],
      ['unknown', true],
    ]);
    expect(report.matrixPasses).toBe(true);
    for (const cell of report.matrix) {
      expect(cell.urgentCases).toBeGreaterThan(0);
      expect(cell.routineCases).toBeGreaterThan(0);
      expect(cell.seedUnderTriage).toBe(0);
      expect(cell.breaches).toBe(0);
      expect(cell.errors).toBe(0);
    }
    const seedUrgent = report.outcomes.filter(
      (outcome) => outcome.source === 'seed' && outcome.expected === 'urgent',
    );
    expect(seedUrgent).toHaveLength(23);
    expect(seedUrgent.every((outcome) => outcome.observed === 'urgent')).toBe(true);
  });

  it('every seed error is over-triage: a negated mention escalates, it is never reassured', () => {
    expect(report.overTriage).toEqual(['en-r-05']);
    const seedErrors = report.outcomes.filter(
      (outcome) => outcome.source === 'seed' && outcome.direction !== 'correct',
    );
    expect(seedErrors.map((outcome) => [outcome.caseId, outcome.direction])).toEqual([
      ['en-r-05', 'over-triage'],
    ]);
  });

  it('the landed screen catches all seven probes: no under-triage anywhere in the golden set', () => {
    expect(report.underTriage).toEqual(LANDED_PROBE_MISSES);
    const missed = report.outcomes.filter((outcome) => outcome.direction === 'under-triage');
    expect(missed).toEqual([]);
    const probes = report.outcomes.filter((outcome) => outcome.source === 'probe');
    expect(probes.map((outcome) => outcome.caseId)).toEqual([
      'pr-en-01',
      'pr-en-02',
      'pr-en-03',
      'pr-es-01',
      'pr-es-02',
      'pr-un-01',
      'pr-mis-01',
    ]);
    expect(probes.every((outcome) => outcome.observed === 'urgent')).toBe(true);
    expect(probes.every((outcome) => outcome.routing === 'page_oncall')).toBe(true);
    expect(report.urgentRecall).toBe(1);
    expect(report.accuracy).toBeCloseTo(39 / 40, 10);
  });

  it('keeps the 911 line, the advisory flag and the ruleset version on every fact', () => {
    expect(report.outcomes.every((outcome) => outcome.breaches.length === 0)).toBe(true);
    expect(EMERGENCY_LINE).toContain('911');
  });
});

describe('WP-104 language matrix on golden revision 2 (WP-045 a3)', () => {
  const report = evaluateClassifier(LANDED_URGENCY_SCREEN, GOLDEN_SET_V2);

  it('passes in en, es and unknown with like-for-like urgent coverage', () => {
    expect(report.matrix.map((cell) => [cell.language, cell.urgentCases, cell.passes])).toEqual([
      ['en', 147, true],
      ['es', 103, true],
      ['unknown', 25, true],
    ]);
    expect(report.matrix.every((cell) => cell.seedUnderTriage === 0)).toBe(true);
    expect(report.matrixPasses).toBe(true);
  });

  it('the Spanish cell covers stroke, unconscious, bleeding and seizure, and catches them', () => {
    const spanish = [
      'rv-es-stk-01',
      'rv-es-stk-02',
      'rv-es-stk-03',
      'rv-es-stk-04',
      'rv-es-oth-01',
      'rv-es-oth-02',
      'rv-es-oth-03',
    ];
    const byId = new Map(report.outcomes.map((outcome) => [outcome.caseId, outcome]));
    for (const caseId of spanish) {
      expect(byId.get(caseId)?.language, caseId).toBe('es');
      expect(byId.get(caseId)?.observed, caseId).toBe('urgent');
    }
  });

  it('under-triages only the two pinned keyword gaps, both probes', () => {
    expect(report.underTriage).toEqual(['own-oh-en-03', 'own-o2-en-05']);
    const missed = report.outcomes.filter((outcome) => outcome.direction === 'under-triage');
    expect(missed.every((outcome) => outcome.source === 'probe')).toBe(true);
  });

  // rv-rt-08 ('Aires' with 'cuesta') and rv-rt-09 ('aire acondicionado' with 'falta') match the a2
  // breathing rule by substring; WP-045 a4 keeps the a2 union (decision D-2.2: safer by construction).
  it('over-triages exactly the accepted historical mentions, idioms and a2 substring matches', () => {
    expect(report.overTriage).toEqual([
      'en-r-05',
      'rv-rt-01',
      'rv-rt-03',
      'rv-rt-04',
      'rv-rt-05',
      'rv-rt-06',
      'rv-rt-07',
      'rv-rt-08',
      'rv-rt-09',
      'rv-rt-10',
      'rv-rt-16',
      'rv-rt-17',
      'own-o3r-01',
      'own-o3r-12',
    ]);
  });
});

describe('WP-104 the matrix can fail', () => {
  it('an always-routine classifier fails every language cell on seed under-triage', () => {
    const report = evaluateClassifier(alwaysRoutineCandidate, GOLDEN_SET_V1);
    expect(report.matrixPasses).toBe(false);
    expect(report.matrix.every((cell) => !cell.passes && cell.seedUnderTriage > 0)).toBe(true);
    expect(report.urgentRecall).toBe(0);
  });

  it('an always-urgent classifier passes: its only failures are over-triage', () => {
    const report = evaluateClassifier(alwaysUrgentCandidate, GOLDEN_SET_V1);
    expect(report.matrixPasses).toBe(true);
    expect(report.underTriage).toEqual([]);
    expect(report.overTriage).toHaveLength(10);
  });

  it('a classifier that drops the 911 line is recorded as a breach and fails the matrix', () => {
    const report = evaluateClassifier(disclaimerDroppingCandidate, GOLDEN_SET_V1);
    expect(report.matrixPasses).toBe(false);
    expect(
      report.outcomes.every((outcome) => outcome.breaches.includes('emergency-line-missing')),
    ).toBe(true);
  });

  it('a classifier that throws is an error on every case, never a pass', () => {
    const report = evaluateClassifier(throwingCandidate, GOLDEN_SET_V1);
    expect(report.matrixPasses).toBe(false);
    expect(report.outcomes.every((outcome) => outcome.direction === 'error')).toBe(true);
    expect(report.outcomes[0]?.breaches).toEqual(['classifier-threw:model-sim timeout']);
    expect(report.accuracy).toBe(0);
  });
});

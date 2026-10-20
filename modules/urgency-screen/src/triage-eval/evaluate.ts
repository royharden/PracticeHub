import { createHash } from 'node:crypto';
import { screenInbound } from '../screen.js';
import {
  EMERGENCY_LINE,
  type UrgencyClass,
  type UrgencyScreenInput,
  type VersionedUrgencyFact,
} from '../types.js';
import { MATRIX_LANGUAGES, goldenSetDigest } from './golden-set.js';
import {
  TRIAGE_EVAL_VERSION,
  type CaseOutcome,
  type EvalReport,
  type GoldenCase,
  type GoldenSet,
  type LanguageCell,
  type TriageClassifier,
  type TriageDirection,
} from './types.js';

export const EVAL_TENANT_ID = 'tenant-synthetic-triage-eval' as const;
const EVAL_RECEIVED_AT = '2026-01-01T03:00:00Z';

/** The landed WP-045 screen, read-only: the baseline every classifier change is judged against. */
export const LANDED_URGENCY_SCREEN: TriageClassifier = Object.freeze({
  classifierId: 'wp045-landed-screen',
  classify: screenInbound,
});

export function inputForCase(goldenCase: GoldenCase): UrgencyScreenInput {
  return {
    tenantId: EVAL_TENANT_ID,
    inboundId: goldenCase.caseId,
    receivedAt: EVAL_RECEIVED_AT,
    channel: goldenCase.channel,
    language: goldenCase.language,
    text: goldenCase.text,
    unmatched: false,
    afterHours: goldenCase.afterHours,
    killSwitchTripped: false,
    synthetic: true,
  };
}

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Contract checks every fact must pass whatever its class (REQ-COMM-001 AC2/AC4/AC6/EX1). */
export function factBreaches(input: UrgencyScreenInput, fact: VersionedUrgencyFact): string[] {
  const breaches: string[] = [];
  if (fact.inboundId !== input.inboundId) breaches.push('fact-not-bound-to-inbound');
  if (fact.class !== 'urgent' && fact.class !== 'routine') breaches.push('class-out-of-range');
  if (!Number.isFinite(fact.confidence) || fact.confidence < 0 || fact.confidence > 1) {
    breaches.push('confidence-out-of-range');
  }
  if (fact.emergencyLineRequired !== true) breaches.push('emergency-line-not-required');
  if (!Array.isArray(fact.reasons) || !fact.reasons.includes(`disclaimer:${EMERGENCY_LINE}`)) {
    breaches.push('emergency-line-missing');
  }
  if (fact.advisoryOnly !== true) breaches.push('not-advisory');
  if (typeof fact.classifierVersion !== 'string' || fact.classifierVersion.trim() === '') {
    breaches.push('classifier-version-missing');
  }
  if (fact.synthetic !== true) breaches.push('not-synthetic');
  if (input.killSwitchTripped && (!fact.humanFallback || fact.routing !== 'human_review')) {
    breaches.push('kill-switch-not-human');
  }
  if (fact.humanFallback && fact.routing !== 'human_review') {
    breaches.push('fallback-not-human-review');
  }
  if (
    fact.class === 'urgent' &&
    input.afterHours &&
    !fact.humanFallback &&
    fact.routing !== 'page_oncall'
  ) {
    breaches.push('after-hours-urgent-not-paged');
  }
  return breaches;
}

export function directionOf(
  expected: UrgencyClass,
  observed: UrgencyClass | 'error',
): TriageDirection {
  if (observed === 'error') return 'error';
  if (observed === expected) return 'correct';
  return expected === 'urgent' ? 'under-triage' : 'over-triage';
}

export interface ClassifiedCase {
  readonly observed: UrgencyClass | 'error';
  readonly routing: CaseOutcome['routing'];
  readonly humanFallback: boolean;
  readonly classifierVersion: string;
  readonly breaches: readonly string[];
}

/** Runs one input; a throw or a malformed fact is recorded, never swallowed as a pass. */
export function classifyForEval(
  classifier: TriageClassifier,
  input: UrgencyScreenInput,
): ClassifiedCase {
  try {
    const fact = classifier.classify(input);
    const breaches = factBreaches(input, fact);
    const observed =
      fact.class === 'urgent' || fact.class === 'routine' ? fact.class : ('error' as const);
    return {
      observed,
      routing: observed === 'error' ? 'error' : fact.routing,
      humanFallback: fact.humanFallback === true,
      classifierVersion: typeof fact.classifierVersion === 'string' ? fact.classifierVersion : '',
      breaches,
    };
  } catch (error) {
    return {
      observed: 'error',
      routing: 'error',
      humanFallback: false,
      classifierVersion: '',
      breaches: [`classifier-threw:${error instanceof Error ? error.message : 'unknown'}`],
    };
  }
}

function matrixFor(goldenSet: GoldenSet, outcomes: readonly CaseOutcome[]): LanguageCell[] {
  return MATRIX_LANGUAGES.map((language) => {
    const cell = outcomes.filter((outcome) => outcome.language === language);
    const urgent = cell.filter((outcome) => outcome.expected === 'urgent');
    const routineCases = cell.filter((outcome) => outcome.expected === 'routine').length;
    const seedUnderTriage = cell.filter(
      (outcome) => outcome.source === 'seed' && outcome.direction === 'under-triage',
    ).length;
    const breaches = cell.filter((outcome) => outcome.breaches.length > 0).length;
    const errors = cell.filter((outcome) => outcome.direction === 'error').length;
    const declared = goldenSet.cases.filter((item) => item.language === language).length;
    return {
      language,
      urgentCases: urgent.length,
      routineCases,
      urgentCaught: urgent.filter((outcome) => outcome.observed === 'urgent').length,
      overTriage: cell.filter((outcome) => outcome.direction === 'over-triage').length,
      underTriage: cell.filter((outcome) => outcome.direction === 'under-triage').length,
      seedUnderTriage,
      breaches,
      errors,
      passes:
        cell.length === declared &&
        urgent.length > 0 &&
        routineCases > 0 &&
        seedUnderTriage === 0 &&
        breaches === 0 &&
        errors === 0,
    };
  });
}

/**
 * Evaluates a classifier against the full golden set. A language cell passes only when it holds
 * urgent and routine cases, catches every seed urgent case, and has no contract breach or error.
 */
export function evaluateClassifier(classifier: TriageClassifier, goldenSet: GoldenSet): EvalReport {
  const outcomes: CaseOutcome[] = goldenSet.cases.map((goldenCase) => {
    const result = classifyForEval(classifier, inputForCase(goldenCase));
    return Object.freeze({
      caseId: goldenCase.caseId,
      language: goldenCase.language,
      source: goldenCase.source,
      expected: goldenCase.expected,
      observed: result.observed,
      routing: result.routing,
      classifierVersion: result.classifierVersion,
      direction: directionOf(goldenCase.expected, result.observed),
      breaches: Object.freeze([...result.breaches]),
    });
  });
  const matrix = matrixFor(goldenSet, outcomes);
  const urgentExpected = outcomes.filter((outcome) => outcome.expected === 'urgent');
  const digest = goldenSetDigest(goldenSet);
  const classifierVersions = [...new Set(outcomes.map((outcome) => outcome.classifierVersion))]
    .filter((version) => version !== '')
    .sort();
  const evidence = {
    evalVersion: TRIAGE_EVAL_VERSION,
    goldenSetDigest: digest,
    classifierId: classifier.classifierId,
    classifierVersions,
    outcomes,
  };
  return Object.freeze({
    evalVersion: TRIAGE_EVAL_VERSION,
    goldenSetRevision: goldenSet.revision,
    goldenSetDigest: digest,
    classifierId: classifier.classifierId,
    classifierVersions: Object.freeze(classifierVersions),
    outcomes: Object.freeze(outcomes),
    matrix: Object.freeze(matrix.map((cell) => Object.freeze(cell))),
    matrixPasses: matrix.every((cell) => cell.passes),
    accuracy:
      outcomes.length === 0
        ? 0
        : outcomes.filter((outcome) => outcome.direction === 'correct').length / outcomes.length,
    urgentRecall:
      urgentExpected.length === 0
        ? 0
        : urgentExpected.filter((outcome) => outcome.observed === 'urgent').length /
          urgentExpected.length,
    underTriage: Object.freeze(
      outcomes.filter((outcome) => outcome.direction === 'under-triage').map((o) => o.caseId),
    ),
    overTriage: Object.freeze(
      outcomes.filter((outcome) => outcome.direction === 'over-triage').map((o) => o.caseId),
    ),
    evidenceDigest: sha256Json(evidence),
    synthetic: true,
  });
}

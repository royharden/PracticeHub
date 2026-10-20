import { beforeAll, describe, expect, it } from 'vitest';
import { LANDED_URGENCY_SCREEN, evaluateClassifier } from './evaluate.js';
import { FAULTS, runFailureDirectionSuite } from './failure-direction.js';
import {
  BASELINE_CATCH_LIST_V1,
  catchListDigest,
  catchListKey,
  catchListLabels,
  evaluateCatchList,
} from './catch-list.js';
import { GOLDEN_SET_V1, GOLDEN_SET_V2, addConfirmedMiss, goldenSetDigest } from './golden-set.js';
import { reviewClassifierChange } from './promotion-gate.js';
import {
  coverageTrimmingCandidate,
  killSwitchIgnoringCandidate,
  labelLimitedCandidate,
  normalizingUnionCandidate,
  tunedRegressingCandidate,
} from './test-doubles.js';
import type {
  CatchListEntry,
  ClassifierChangeRequest,
  GoldenSet,
  HumanApproval,
  TriageClassifier,
} from './types.js';
import { Wp101EvalHarnessPlaceholder } from './wp101-eval-harness-placeholder.js';

const AUTHOR = 'tuning-engineer-synthetic';
const APPROVER = 'clinical-safety-reviewer-synthetic';

const ALTERED_CATCH_LISTS: readonly { name: string; list: readonly CatchListEntry[] }[] = [
  { name: 'empty', list: [] },
  { name: 'shortened', list: BASELINE_CATCH_LIST_V1.slice(1) },
  { name: 'reordered', list: [...BASELINE_CATCH_LIST_V1].reverse() },
  {
    name: 'reworded',
    list: BASELINE_CATCH_LIST_V1.map((entry, index) =>
      index === 0 ? { ...entry, text: `${entry.text} again` } : entry,
    ),
  },
  {
    name: 'case-only',
    list: BASELINE_CATCH_LIST_V1.map((entry, index) =>
      index === 0 ? { ...entry, text: entry.text.toUpperCase() } : entry,
    ),
  },
];

type BaselineReports = Pick<
  ClassifierChangeRequest,
  'baseline' | 'baselineFaults' | 'baselineCatch'
>;

let revision2Baseline: BaselineReports | undefined;
let revision2Faults: readonly {
  readonly spec: (typeof FAULTS)[number];
  readonly fault: (typeof FAULTS)[number]['fault'];
  readonly applies: (typeof FAULTS)[number]['applies'];
  readonly perturb: (typeof FAULTS)[number]['perturb'];
}[] = [];

function evaluateBaseline(goldenSet: GoldenSet): BaselineReports {
  return Object.freeze({
    baseline: evaluateClassifier(LANDED_URGENCY_SCREEN, goldenSet),
    baselineFaults: runFailureDirectionSuite(LANDED_URGENCY_SCREEN, goldenSet),
    baselineCatch: evaluateCatchList(LANDED_URGENCY_SCREEN, BASELINE_CATCH_LIST_V1),
  });
}

// These two revision-2 regression cases share only the immutable landed reports.
// Real evaluation stays inside the unchanged default hook budget; candidates stay fresh.
beforeAll(() => {
  // FAULTS freezes its array, not each descriptor: changed descriptors must miss the fixture.
  revision2Faults = Object.freeze(
    FAULTS.map((spec) =>
      Object.freeze({ spec, fault: spec.fault, applies: spec.applies, perturb: spec.perturb }),
    ),
  );
  revision2Baseline = evaluateBaseline(GOLDEN_SET_V2);
});

function baselineFor(goldenSet: GoldenSet): BaselineReports {
  if (
    goldenSet === GOLDEN_SET_V2 &&
    revision2Baseline !== undefined &&
    revision2Baseline.baseline.goldenSetDigest === goldenSetDigest(goldenSet) &&
    FAULTS.length === revision2Faults.length &&
    revision2Faults.every(
      (saved, index) =>
        FAULTS[index] === saved.spec &&
        saved.spec.fault === saved.fault &&
        saved.spec.applies === saved.applies &&
        saved.spec.perturb === saved.perturb,
    )
  ) {
    return revision2Baseline;
  }
  return evaluateBaseline(goldenSet);
}

function request(
  candidateClassifier: TriageClassifier,
  goldenSet: GoldenSet = GOLDEN_SET_V1,
  approve: boolean | ((approval: HumanApproval) => HumanApproval) = false,
): ClassifierChangeRequest {
  const candidate = evaluateClassifier(candidateClassifier, goldenSet);
  const candidateFaults = runFailureDirectionSuite(candidateClassifier, goldenSet);
  const approval: HumanApproval = {
    catchListDigest: catchListDigest(BASELINE_CATCH_LIST_V1),
    approverId: APPROVER,
    approverKind: 'human',
    approvedAt: '2026-01-02T15:00:00Z',
    candidateDigest: candidate.evidenceDigest,
    candidateFaultDigest: candidateFaults.evidenceDigest,
    goldenSetDigest: goldenSetDigest(goldenSet),
  };
  const baselineReports = baselineFor(goldenSet);
  return {
    changeId: `change-${candidateClassifier.classifierId}`,
    authorId: AUTHOR,
    goldenSet,
    baseline: baselineReports.baseline,
    candidate,
    baselineFaults: baselineReports.baselineFaults,
    candidateFaults,
    baselineCatch: baselineReports.baselineCatch,
    candidateCatch: evaluateCatchList(candidateClassifier, BASELINE_CATCH_LIST_V1),
    approval: approve === false ? null : approve === true ? approval : approve(approval),
  };
}

describe('H28 registered catch-list and approval binding', () => {
  const registeredDigest = catchListDigest(BASELINE_CATCH_LIST_V1);

  it.each(ALTERED_CATCH_LISTS)('BLOCKS equal-both $name actual catch lists', ({ list }) => {
    // what_bug_this_catches: mutually matching reports could replace registered coverage
    // underneath an otherwise valid approval, bypassing all dropped-reading checks.
    const digest = catchListDigest(list);
    const complete = request(normalizingUnionCandidate, GOLDEN_SET_V1, true);
    const baselineCatch = evaluateCatchList(LANDED_URGENCY_SCREEN, list);
    const candidateCatch = evaluateCatchList(normalizingUnionCandidate, list);
    expect(digest).not.toBe(registeredDigest);
    expect(baselineCatch.catchListDigest).toBe(candidateCatch.catchListDigest);
    expect(baselineCatch.urgent).toEqual(candidateCatch.urgent);
    const harness = new Wp101EvalHarnessPlaceholder();
    const decision = reviewClassifierChange(
      { ...complete, baselineCatch, candidateCatch },
      harness,
    );
    expect(decision).toEqual({
      status: 'blocked',
      reasons: ['catch-list-unregistered:baseline', 'catch-list-unregistered:candidate'],
    });
    expect(harness.changes()).toEqual([]);
  });

  it.each(['baseline', 'candidate'] as const)(
    'BLOCKS an unregistered %s report independently',
    (side) => {
      // what_bug_this_catches: checking only one report leaves the other unbound.
      const complete = request(normalizingUnionCandidate, GOLDEN_SET_V1, true);
      const baselineCatch = evaluateCatchList(LANDED_URGENCY_SCREEN, []);
      const candidateCatch = evaluateCatchList(normalizingUnionCandidate, []);
      const harness = new Wp101EvalHarnessPlaceholder();
      const decision = reviewClassifierChange(
        side === 'baseline' ? { ...complete, baselineCatch } : { ...complete, candidateCatch },
        harness,
      );
      expect(decision.status).toBe('blocked');
      expect(decision.reasons).toContain(`catch-list-unregistered:${side}`);
      expect(harness.changes()).toEqual([]);
    },
  );

  it.each([
    { name: 'missing', digest: undefined },
    { name: 'wrong', digest: '0'.repeat(64) },
    { name: 'stale', digest: catchListDigest(BASELINE_CATCH_LIST_V1.slice(1)) },
  ])('BLOCKS a $name approval catch-list digest', ({ digest }) => {
    // what_bug_this_catches: valid golden/fault evidence cannot authorize a different
    // catch list, and legacy runtime approvals with no digest must fail closed.
    const complete = request(normalizingUnionCandidate, GOLDEN_SET_V1, true);
    if (complete.approval === null) throw new Error('synthetic approval fixture missing');
    const { catchListDigest: priorDigest, ...withoutDigest } = complete.approval;
    expect(priorDigest).toBe(registeredDigest);
    const approval = (
      digest === undefined ? withoutDigest : { ...withoutDigest, catchListDigest: digest }
    ) as HumanApproval;
    const harness = new Wp101EvalHarnessPlaceholder();
    expect(reviewClassifierChange({ ...complete, approval }, harness)).toEqual({
      status: 'blocked',
      reasons: ['approval-digest-mismatch:catch-list'],
    });
    expect(harness.changes()).toEqual([]);
  });

  it('registered coverage waits without approval and persists its exact digest with synthetic approval', () => {
    // what_bug_this_catches: registry hardening must retain the human gate and bind
    // its audit record to the exact list the named non-author reviewed.
    const harness = new Wp101EvalHarnessPlaceholder();
    expect(reviewClassifierChange(request(normalizingUnionCandidate), harness)).toEqual({
      status: 'awaiting-human-approval',
      reasons: ['human-approval-required'],
    });
    expect(harness.changes()).toEqual([]);
    const complete = request(normalizingUnionCandidate, GOLDEN_SET_V1, true);
    expect(complete.approval?.approverId).toBe(APPROVER);
    expect(complete.approval?.approverId).not.toBe(complete.authorId);
    expect(complete.approval?.catchListDigest).toBe(registeredDigest);
    const decision = reviewClassifierChange(complete, harness);
    if (decision.status !== 'approved') throw new Error(decision.reasons.join(', '));
    expect(decision.change.catchListDigest).toBe(registeredDigest);
    expect(harness.changes()).toEqual([decision.change]);
    expect(harness.changes()[0]?.catchListDigest).toBe(registeredDigest);
  });
});

describe('WP-104 classifier change gate', () => {
  it('BLOCKS a tuned change that wins on over-triage but regresses one urgent golden case', () => {
    const change = request(tunedRegressingCandidate, GOLDEN_SET_V1, true);
    expect(change.candidate.overTriage.length).toBeLessThan(change.baseline.overTriage.length);
    expect(change.candidate.accuracy).toBeGreaterThanOrEqual(change.baseline.accuracy);
    const harness = new Wp101EvalHarnessPlaceholder();
    const decision = reviewClassifierChange(change, harness);
    expect(decision.status).toBe('blocked');
    expect(decision.reasons).toContain('urgent-regression:en-u-06');
    expect(decision.reasons).toContain('language-matrix-fails:en');
    expect(decision.reasons).toContain('fault-regression:en-u-06|uppercase');
    expect(harness.changes()).toEqual([]);
  });

  it('BLOCKS a change that stops honoring the kill switch, even with no clean regression', () => {
    const change = request(killSwitchIgnoringCandidate, GOLDEN_SET_V1, true);
    const decision = reviewClassifierChange(change, new Wp101EvalHarnessPlaceholder());
    expect(decision.status).toBe('blocked');
    expect(decision.reasons.filter((reason) => reason.startsWith('urgent-regression:'))).toEqual(
      [],
    );
    expect(decision.reasons).toContain('kill-switch-unsafe:en-u-01');
    expect(decision.reasons).toContain('fault-regression:en-r-01|kill-switch');
  });

  it('FREEZES tuning while the eval harness or golden store is down', () => {
    const harness = new Wp101EvalHarnessPlaceholder();
    harness.setAvailable(false);
    const decision = reviewClassifierChange(
      request(normalizingUnionCandidate, GOLDEN_SET_V1, true),
      harness,
    );
    expect(decision).toEqual({ status: 'frozen', reasons: ['eval-harness-unavailable'] });
    expect(
      reviewClassifierChange(request(tunedRegressingCandidate, GOLDEN_SET_V1, true), harness),
    ).toEqual({ status: 'frozen', reasons: ['eval-harness-unavailable'] });
    expect(harness.changes()).toEqual([]);
  });

  it('a safe candidate without a human approval waits; nothing auto-deploys', () => {
    const harness = new Wp101EvalHarnessPlaceholder();
    const decision = reviewClassifierChange(request(normalizingUnionCandidate), harness);
    expect(decision).toEqual({
      status: 'awaiting-human-approval',
      reasons: ['human-approval-required'],
    });
    expect(harness.changes()).toEqual([]);
  });

  it('BLOCKS approval by the author, by a non-human, or bound to other evidence', () => {
    const harness = new Wp101EvalHarnessPlaceholder();
    const byAuthor = reviewClassifierChange(
      request(normalizingUnionCandidate, GOLDEN_SET_V1, (a) => ({ ...a, approverId: AUTHOR })),
      harness,
    );
    expect(byAuthor.reasons).toEqual(['approval-by-author']);
    const byModel = reviewClassifierChange(
      request(normalizingUnionCandidate, GOLDEN_SET_V1, (a) => ({
        ...a,
        approverKind: 'ai' as unknown as 'human',
      })),
      harness,
    );
    expect(byModel.reasons).toEqual(['approval-not-human']);
    const stale = reviewClassifierChange(
      request(normalizingUnionCandidate, GOLDEN_SET_V1, (a) => ({
        ...a,
        candidateDigest: '0'.repeat(64),
      })),
      harness,
    );
    expect(stale.status).toBe('blocked');
    expect(stale.reasons).toEqual(['approval-digest-mismatch:candidate']);
    expect(harness.changes()).toEqual([]);
  });

  it('APPROVES a safe change with a human approval and records prior version, evidence and approver', () => {
    const harness = new Wp101EvalHarnessPlaceholder();
    const change = request(normalizingUnionCandidate, GOLDEN_SET_V1, true);
    const decision = reviewClassifierChange(change, harness);
    if (decision.status !== 'approved') throw new Error(decision.reasons.join(', '));
    expect(decision.change).toEqual({
      catchListDigest: catchListDigest(BASELINE_CATCH_LIST_V1),
      changeId: 'change-double.normalize-union',
      authorId: AUTHOR,
      priorClassifierId: 'wp045-landed-screen',
      priorClassifierVersions: ['keyword-classifier.v4+ai-screen-double.v4'],
      newClassifierId: 'double.normalize-union',
      newClassifierVersions: ['keyword-classifier.v4+ai-screen-double.v4+normalize-union.double'],
      goldenSetRevision: 1,
      goldenSetDigest: goldenSetDigest(GOLDEN_SET_V1),
      baselineDigest: change.baseline.evidenceDigest,
      candidateDigest: change.candidate.evidenceDigest,
      candidateFaultDigest: change.candidateFaults.evidenceDigest,
      approverId: APPROVER,
      approvedAt: '2026-01-02T15:00:00Z',
      rollbackTo: 'wp045-landed-screen',
      fallback: 'human-only',
      synthetic: true,
    });
    expect(harness.changes()).toEqual([decision.change]);
    expect(change.candidate.urgentRecall).toBe(1);
    expect(change.candidate.urgentRecall).toBeGreaterThanOrEqual(change.baseline.urgentRecall);
  });
});

describe('WP-104 gate against the full, current golden set', () => {
  const v2 = addConfirmedMiss(GOLDEN_SET_V1, {
    inboundId: 'inb-miss-7',
    language: 'es',
    channel: 'sms',
    afterHours: true,
    text: 'me quiero morir',
    observedClass: 'routine',
    observedClassifierVersion: 'keyword-classifier.v1+ai-screen-double.v1',
    correctedClass: 'urgent',
    failureMode: 'paraphrase',
    reviewerId: 'oncall-synthetic-2',
    reviewerKind: 'human',
    synthetic: true,
  });

  it('BLOCKS a change whose baseline was run on an older golden revision', () => {
    const change = request(normalizingUnionCandidate, v2, true);
    const stale = {
      ...change,
      baseline: evaluateClassifier(LANDED_URGENCY_SCREEN, GOLDEN_SET_V1),
    };
    const decision = reviewClassifierChange(stale, new Wp101EvalHarnessPlaceholder());
    expect(decision.status).toBe('blocked');
    expect(decision.reasons).toContain('golden-set-mismatch:baseline');
    expect(decision.reasons).toContain('coverage-incomplete:baseline');
  });

  it('the confirmed miss is scored on the new revision and binds the approval to it', () => {
    const change = request(normalizingUnionCandidate, v2, true);
    const scored = change.baseline.outcomes.find((outcome) => outcome.caseId === 'miss-inb-miss-7');
    expect(scored?.source).toBe('confirmed-miss');
    expect(scored?.observed).toBe('urgent');
    expect(change.baseline.outcomes).toHaveLength(41);
    const decision = reviewClassifierChange(change, new Wp101EvalHarnessPlaceholder());
    if (decision.status !== 'approved') throw new Error(decision.reasons.join(', '));
    expect(decision.change.goldenSetRevision).toBe(2);
    expect(decision.change.goldenSetDigest).toBe(goldenSetDigest(v2));
  });
});

/**
 * WP-104 a2 review: the gate approved a change that dropped 15 of 16 urgent phrasings the
 * classifier of record catches, because revision 1 held none of them. Revision 2 does.
 */
describe('WP-104 gate blind spot closed by golden revision 2', () => {
  const DROPPED = [
    'rv-en-sui-12',
    'a2h-01',
    'a2h-03',
    'rv-en-br-01',
    'rv-en-br-06',
    'rv-es-sui-06',
    'rv-es-sui-04',
    'a2h-10',
    'rv-es-br-03',
    'a2h-14',
    'rv-en-br-10',
    'a2h-02',
    'a2h-11',
    'rv-en-chest-05',
    'a2h-08',
  ];
  const KEPT = 'rv-en-sui-03';

  function textsOf(caseIds: readonly string[]): string[] {
    const byId = new Map(GOLDEN_SET_V2.cases.map((item) => [item.caseId, item.text]));
    return caseIds.map((caseId) => {
      const text = byId.get(caseId);
      if (text === undefined) throw new Error(`golden revision 2 has no case ${caseId}`);
      return text;
    });
  }

  it('BLOCKS a change that drops 15 of 16 urgent phrasings, naming every one', () => {
    expect(DROPPED).toHaveLength(15);
    const trimmed = coverageTrimmingCandidate(textsOf(DROPPED));
    const decision = reviewClassifierChange(
      request(trimmed, GOLDEN_SET_V2, true),
      new Wp101EvalHarnessPlaceholder(),
    );
    expect(decision.status).toBe('blocked');
    for (const caseId of DROPPED) {
      expect(decision.reasons, caseId).toContain(`urgent-regression:${caseId}`);
    }
    expect(decision.reasons).not.toContain(`urgent-regression:${KEPT}`);
    expect(textsOf([KEPT])).toEqual(["I've been thinking about killing myself"]);
  });

  it('the same change sails through revision 1 on the golden set alone', () => {
    const trimmed = coverageTrimmingCandidate(textsOf(DROPPED));
    const decision = reviewClassifierChange(
      request(trimmed, GOLDEN_SET_V1, true),
      new Wp101EvalHarnessPlaceholder(),
    );
    expect(decision.status).toBe('approved');
  });
});

/**
 * WP-104 a3 review 2: the gate approved WP-045 a2 -> a3 although a3 dropped phrasings a2 and the
 * landed screen caught, because the golden set did not hold them. The baseline catch list does.
 */
describe('WP-104 a4: the gate blocks any drop of a baseline-urgent phrasing', () => {
  const lostByA3 = BASELINE_CATCH_LIST_V1.filter((entry) => !entry.id.startsWith('cl-fmt'));
  const keysOf = (entries: readonly CatchListEntry[]): string[] =>
    entries.flatMap((entry) =>
      catchListLabels(entry).map((language) => catchListKey(entry, language)),
    );

  it('the baseline catches every catch-list phrasing under every label', () => {
    const report = evaluateCatchList(LANDED_URGENCY_SCREEN, BASELINE_CATCH_LIST_V1);
    expect(report.total).toBe(54);
    expect(report.urgent).toEqual(keysOf(BASELINE_CATCH_LIST_V1));
    expect(report.urgent.slice(0, 3)).toEqual([
      'cl-landed-01~en',
      'cl-landed-01~unknown',
      'cl-landed-01~es',
    ]);
  });

  it('BLOCKS the a2 -> a3 drops, naming every dropped reading, even with golden revision 2', () => {
    const a3Like = coverageTrimmingCandidate(lostByA3.map((entry) => entry.text));
    const decision = reviewClassifierChange(
      request(a3Like, GOLDEN_SET_V2, true),
      new Wp101EvalHarnessPlaceholder(),
    );
    expect(decision.status).toBe('blocked');
    expect(
      decision.reasons.filter((reason) => reason.startsWith('catch-list-regression:')),
    ).toEqual(keysOf(lostByA3).map((key) => `catch-list-regression:${key}`));
    expect(decision.reasons.some((reason) => reason.startsWith('urgent-regression:'))).toBe(false);
  });

  it('BLOCKS dropping a phrasing the baseline caught only under its declared language', () => {
    const entry = BASELINE_CATCH_LIST_V1[0] as CatchListEntry;
    expect(entry.text).toBe('periods of unconsciousness');
    const declaredOnly = labelLimitedCandidate([entry.text], [entry.language]);
    const baselineCatch = evaluateCatchList(declaredOnly, BASELINE_CATCH_LIST_V1);
    expect(baselineCatch.urgent).toContain('cl-landed-01~en');
    expect(baselineCatch.urgent).not.toContain('cl-landed-01~unknown');
    const change: ClassifierChangeRequest = {
      ...request(coverageTrimmingCandidate([entry.text]), GOLDEN_SET_V1, true),
      baseline: evaluateClassifier(declaredOnly, GOLDEN_SET_V1),
      baselineFaults: runFailureDirectionSuite(declaredOnly, GOLDEN_SET_V1),
      baselineCatch,
    };
    expect(reviewClassifierChange(change, new Wp101EvalHarnessPlaceholder())).toEqual({
      status: 'blocked',
      reasons: ['catch-list-regression:cl-landed-01~en'],
    });
  });

  it('BLOCKS a change request without catch-list reports, or with mismatched ones', () => {
    const complete = request(normalizingUnionCandidate, GOLDEN_SET_V1, true);
    const { baselineCatch, candidateCatch, ...withoutCatch } = complete;
    expect(baselineCatch.total).toBe(candidateCatch.total);
    const missing = reviewClassifierChange(
      withoutCatch as unknown as ClassifierChangeRequest,
      new Wp101EvalHarnessPlaceholder(),
    );
    expect(missing).toEqual({ status: 'blocked', reasons: ['catch-list-missing'] });
    const shortened = evaluateCatchList(normalizingUnionCandidate, BASELINE_CATCH_LIST_V1.slice(1));
    const mismatched = reviewClassifierChange(
      { ...complete, candidateCatch: shortened },
      new Wp101EvalHarnessPlaceholder(),
    );
    expect(mismatched.status).toBe('blocked');
    expect(mismatched.reasons).toContain('catch-list-mismatch');
    const reworded = evaluateCatchList(
      normalizingUnionCandidate,
      BASELINE_CATCH_LIST_V1.map((entry, index) =>
        index === 0 ? { ...entry, text: `${entry.text} again` } : entry,
      ),
    );
    expect(reworded.urgent).toEqual(candidateCatch.urgent);
    const swapped = reviewClassifierChange(
      { ...complete, candidateCatch: reworded },
      new Wp101EvalHarnessPlaceholder(),
    );
    expect(swapped).toEqual({
      status: 'blocked',
      reasons: ['catch-list-mismatch', 'catch-list-unregistered:candidate'],
    });
  });
});

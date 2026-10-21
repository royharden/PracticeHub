import { BASELINE_CATCH_LIST_V1, catchListDigest } from './catch-list.js';
import { goldenSetDigest } from './golden-set.js';
import type { EvalHarnessPort } from './wp101-eval-harness-placeholder.js';
import type {
  ClassifierChangeDecision,
  ClassifierChangeRecord,
  ClassifierChangeRequest,
  EvalReport,
  FailureDirectionReport,
  GoldenSet,
} from './types.js';

// Only the registered list defines the catch coverage a promotion may rely on.
const REGISTERED_CATCH_LIST_DIGEST = catchListDigest(BASELINE_CATCH_LIST_V1);

function coverageReasons(
  label: string,
  goldenSet: GoldenSet,
  digest: string,
  report: EvalReport,
  faults: FailureDirectionReport,
): string[] {
  const reasons: string[] = [];
  if (report.goldenSetDigest !== digest) reasons.push(`golden-set-mismatch:${label}`);
  if (faults.goldenSetDigest !== digest) reasons.push(`golden-set-mismatch:${label}-faults`);
  if (faults.classifierId !== report.classifierId) reasons.push(`fault-report-mismatch:${label}`);
  const covered = new Set(report.outcomes.map((outcome) => outcome.caseId));
  const missing = goldenSet.cases.filter((item) => !covered.has(item.caseId));
  if (missing.length > 0 || report.outcomes.length !== goldenSet.cases.length) {
    reasons.push(`coverage-incomplete:${label}`);
  }
  return reasons;
}

/**
 * Any urgent golden case the baseline caught and the candidate does not, clean or under a fault,
 * blocks the change whatever the aggregate metrics say (REQ-AI-065 EX1).
 */
export function urgentRegressions(baseline: EvalReport, candidate: EvalReport): string[] {
  const caught = new Set(
    baseline.outcomes
      .filter((outcome) => outcome.expected === 'urgent' && outcome.observed === 'urgent')
      .map((outcome) => outcome.caseId),
  );
  return candidate.outcomes
    .filter((outcome) => caught.has(outcome.caseId) && outcome.observed !== 'urgent')
    .map((outcome) => outcome.caseId);
}

/**
 * Any catch-list reading (a phrasing under one label) the baseline catches and the candidate does
 * not blocks the change (WP-104 a4): the golden set cannot enumerate every phrasing a classifier
 * catches, so drops are also checked against the baseline catch list.
 */
export function catchListReasons(request: ClassifierChangeRequest): string[] {
  const { baselineCatch, candidateCatch } = request;
  const reasons: string[] = [];
  if (baselineCatch === undefined || candidateCatch === undefined) {
    return ['catch-list-missing'];
  }
  if (baselineCatch.catchListDigest !== candidateCatch.catchListDigest) {
    reasons.push('catch-list-mismatch');
  }
  if (baselineCatch.catchListDigest !== REGISTERED_CATCH_LIST_DIGEST) {
    reasons.push('catch-list-unregistered:baseline');
  }
  if (candidateCatch.catchListDigest !== REGISTERED_CATCH_LIST_DIGEST) {
    reasons.push('catch-list-unregistered:candidate');
  }
  if (baselineCatch.classifierId !== request.baseline.classifierId) {
    reasons.push('catch-list-report-mismatch:baseline');
  }
  if (candidateCatch.classifierId !== request.candidate.classifierId) {
    reasons.push('catch-list-report-mismatch:candidate');
  }
  const kept = new Set(candidateCatch.urgent);
  for (const id of baselineCatch.urgent) {
    if (!kept.has(id)) reasons.push(`catch-list-regression:${id}`);
  }
  return reasons;
}

export function faultRegressions(
  baseline: FailureDirectionReport,
  candidate: FailureDirectionReport,
): string[] {
  const alreadyUnsafe = new Set(baseline.unsafe);
  return candidate.unsafe.filter((key) => !alreadyUnsafe.has(key));
}

function candidateReasons(request: ClassifierChangeRequest): string[] {
  const { baseline, candidate, baselineFaults, candidateFaults } = request;
  const reasons: string[] = [];
  for (const caseId of urgentRegressions(baseline, candidate)) {
    reasons.push(`urgent-regression:${caseId}`);
  }
  for (const key of faultRegressions(baselineFaults, candidateFaults)) {
    reasons.push(`fault-regression:${key}`);
  }
  for (const outcome of candidateFaults.outcomes) {
    if (outcome.fault === 'kill-switch' && !outcome.safe) {
      reasons.push(`kill-switch-unsafe:${outcome.caseId}`);
    }
  }
  for (const cell of candidate.matrix) {
    if (!cell.passes) reasons.push(`language-matrix-fails:${cell.language}`);
  }
  for (const outcome of candidate.outcomes) {
    if (outcome.direction === 'error') reasons.push(`classifier-error:${outcome.caseId}`);
    for (const breach of outcome.breaches) reasons.push(`breach:${outcome.caseId}:${breach}`);
  }
  return reasons;
}

function approvalReasons(request: ClassifierChangeRequest, digest: string): string[] {
  const { approval } = request;
  if (approval === null) return [];
  const reasons: string[] = [];
  if (approval.approverKind !== 'human') reasons.push('approval-not-human');
  if (approval.approverId.trim() === '') reasons.push('approval-unnamed');
  if (approval.approverId === request.authorId) reasons.push('approval-by-author');
  if (approval.candidateDigest !== request.candidate.evidenceDigest) {
    reasons.push('approval-digest-mismatch:candidate');
  }
  if (approval.candidateFaultDigest !== request.candidateFaults.evidenceDigest) {
    reasons.push('approval-digest-mismatch:candidate-faults');
  }
  if (approval.goldenSetDigest !== digest) reasons.push('approval-digest-mismatch:golden-set');
  if (approval.catchListDigest !== REGISTERED_CATCH_LIST_DIGEST) {
    reasons.push('approval-digest-mismatch:catch-list');
  }
  return reasons;
}

/**
 * Human-gated classifier change review (REQ-AI-065 AC2/AC3/EX1/EX3). Harness down freezes tuning;
 * a passing candidate still waits for a human who is not its author; nothing auto-deploys.
 */
export function reviewClassifierChange(
  request: ClassifierChangeRequest,
  harness: EvalHarnessPort,
): ClassifierChangeDecision {
  if (!harness.isAvailable()) {
    return { status: 'frozen', reasons: ['eval-harness-unavailable'] };
  }
  const digest = goldenSetDigest(request.goldenSet);
  const blocked = [
    ...coverageReasons(
      'baseline',
      request.goldenSet,
      digest,
      request.baseline,
      request.baselineFaults,
    ),
    ...coverageReasons(
      'candidate',
      request.goldenSet,
      digest,
      request.candidate,
      request.candidateFaults,
    ),
    ...candidateReasons(request),
    ...catchListReasons(request),
    ...approvalReasons(request, digest),
  ];
  if (blocked.length > 0) return { status: 'blocked', reasons: blocked };
  if (request.approval === null) {
    return { status: 'awaiting-human-approval', reasons: ['human-approval-required'] };
  }
  const change: ClassifierChangeRecord = Object.freeze({
    changeId: request.changeId,
    authorId: request.authorId,
    priorClassifierId: request.baseline.classifierId,
    priorClassifierVersions: request.baseline.classifierVersions,
    newClassifierId: request.candidate.classifierId,
    newClassifierVersions: request.candidate.classifierVersions,
    goldenSetRevision: request.goldenSet.revision,
    goldenSetDigest: digest,
    catchListDigest: REGISTERED_CATCH_LIST_DIGEST,
    baselineDigest: request.baseline.evidenceDigest,
    candidateDigest: request.candidate.evidenceDigest,
    candidateFaultDigest: request.candidateFaults.evidenceDigest,
    approverId: request.approval.approverId,
    approvedAt: request.approval.approvedAt,
    rollbackTo: request.baseline.classifierId,
    fallback: 'human-only',
    synthetic: true,
  });
  try {
    harness.recordChange(change);
  } catch {
    return { status: 'frozen', reasons: ['eval-harness-unavailable'] };
  }
  return { status: 'approved', reasons: [], change };
}

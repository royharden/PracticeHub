import type {
  InboundChannel,
  RoutingAction,
  ScreenLanguage,
  UrgencyClass,
  UrgencyScreenInput,
  VersionedUrgencyFact,
} from '../types.js';

export const TRIAGE_EVAL_VERSION = 'triage-eval.v1' as const;
export const GOLDEN_SET_SERIES = 'triage-golden' as const;

/**
 * Why a golden case exists. `seed` sits inside the screen's declared vocabulary and must always
 * be caught; `probe` is a realistic variant outside it; `confirmed-miss` came through the
 * feedback loop (REQ-AI-065 AC1).
 */
export type GoldenCaseSource = 'seed' | 'probe' | 'confirmed-miss';

export type FailureMode =
  | 'imminent-danger-keyword'
  | 'assistive-escalation-phrase'
  | 'routine-admin'
  | 'negated-or-historical'
  | 'paraphrase'
  | 'orthography'
  | 'language-unknown'
  | 'language-mislabel';

export interface GoldenCase {
  readonly caseId: string;
  readonly language: ScreenLanguage;
  readonly channel: InboundChannel;
  readonly afterHours: boolean;
  readonly text: string;
  readonly expected: UrgencyClass;
  readonly failureMode: FailureMode;
  readonly source: GoldenCaseSource;
  readonly synthetic: true;
}

/** The original message, the misclassification and the human-corrected label (REQ-COMM-041 AC3). */
export interface ConfirmedMissRecord {
  readonly caseId: string;
  readonly inboundId: string;
  readonly observedClass: UrgencyClass;
  readonly observedClassifierVersion: string;
  readonly correctedClass: UrgencyClass;
  readonly reviewerId: string;
  readonly reviewerKind: 'human';
}

export interface GoldenSet {
  readonly series: typeof GOLDEN_SET_SERIES;
  readonly revision: number;
  readonly parentRevision: number | null;
  readonly cases: readonly GoldenCase[];
  readonly misses: readonly ConfirmedMissRecord[];
  readonly synthetic: true;
}

/** Anything that turns one inbound into a versioned urgency fact: the landed screen or a candidate change. */
export interface TriageClassifier {
  readonly classifierId: string;
  classify(input: UrgencyScreenInput): VersionedUrgencyFact;
}

export type TriageDirection = 'correct' | 'over-triage' | 'under-triage' | 'error';

export interface CaseOutcome {
  readonly caseId: string;
  readonly language: ScreenLanguage;
  readonly source: GoldenCaseSource;
  readonly expected: UrgencyClass;
  readonly observed: UrgencyClass | 'error';
  readonly routing: RoutingAction | 'error';
  readonly classifierVersion: string;
  readonly direction: TriageDirection;
  readonly breaches: readonly string[];
}

export interface LanguageCell {
  readonly language: ScreenLanguage;
  readonly urgentCases: number;
  readonly routineCases: number;
  readonly urgentCaught: number;
  readonly overTriage: number;
  readonly underTriage: number;
  readonly seedUnderTriage: number;
  readonly breaches: number;
  readonly errors: number;
  readonly passes: boolean;
}

export interface EvalReport {
  readonly evalVersion: typeof TRIAGE_EVAL_VERSION;
  readonly goldenSetRevision: number;
  readonly goldenSetDigest: string;
  readonly classifierId: string;
  readonly classifierVersions: readonly string[];
  readonly outcomes: readonly CaseOutcome[];
  readonly matrix: readonly LanguageCell[];
  readonly matrixPasses: boolean;
  readonly accuracy: number;
  readonly urgentRecall: number;
  readonly underTriage: readonly string[];
  readonly overTriage: readonly string[];
  readonly evidenceDigest: string;
  readonly synthetic: true;
}

export type FaultId =
  | 'kill-switch'
  | 'uppercase'
  | 'curly-apostrophe'
  | 'extra-whitespace'
  | 'language-unknown'
  | 'unmatched-identity'
  | 'business-hours'
  | 'voice-transcript'
  | 'no-break-space'
  | 'zero-width-space'
  | 'zero-width-joiner'
  | 'zero-width-non-joiner'
  | 'soft-hyphen'
  | 'full-width'
  | 'decomposed-accents'
  | 'mislabel-en-as-es'
  | 'mislabel-es-as-en'
  | 'zero-width-separator';

export interface FaultOutcome {
  readonly key: string;
  readonly caseId: string;
  readonly fault: FaultId;
  readonly expected: UrgencyClass;
  readonly observed: UrgencyClass | 'error';
  readonly routing: RoutingAction | 'error';
  readonly safe: boolean;
  /** Unsafe under the fault although the same classifier was safe on the clean case. */
  readonly induced: boolean;
}

export interface FailureDirectionReport {
  readonly evalVersion: typeof TRIAGE_EVAL_VERSION;
  readonly goldenSetDigest: string;
  readonly classifierId: string;
  readonly outcomes: readonly FaultOutcome[];
  readonly unsafe: readonly string[];
  readonly induced: readonly string[];
  readonly overTriage: number;
  readonly evidenceDigest: string;
  readonly synthetic: true;
}

export interface HumanApproval {
  /** Exact registered catch-list content reviewed for this change. */
  readonly catchListDigest: string;
  readonly approverId: string;
  readonly approverKind: 'human';
  readonly approvedAt: string;
  readonly candidateDigest: string;
  readonly candidateFaultDigest: string;
  readonly goldenSetDigest: string;
}

/** Prior version, eval results and approver, so the change is auditable and reversible (REQ-AI-065 AC3). */
export interface ClassifierChangeRecord {
  /** Exact registered catch-list content reviewed for this change. */
  readonly catchListDigest: string;
  readonly changeId: string;
  readonly authorId: string;
  readonly priorClassifierId: string;
  readonly priorClassifierVersions: readonly string[];
  readonly newClassifierId: string;
  readonly newClassifierVersions: readonly string[];
  readonly goldenSetRevision: number;
  readonly goldenSetDigest: string;
  readonly baselineDigest: string;
  readonly candidateDigest: string;
  readonly candidateFaultDigest: string;
  readonly approverId: string;
  readonly approvedAt: string;
  readonly rollbackTo: string;
  readonly fallback: 'human-only';
  readonly synthetic: true;
}

/** A phrasing an earlier version caught that no later candidate may drop (WP-104 a4). */
export interface CatchListEntry {
  readonly id: string;
  readonly language: ScreenLanguage;
  readonly text: string;
  readonly synthetic: true;
}

export interface CatchListReport {
  readonly evalVersion: typeof TRIAGE_EVAL_VERSION;
  readonly catchListDigest: string;
  readonly classifierId: string;
  /** Readings scored: each entry under its own language, `unknown` and the other language. */
  readonly total: number;
  /** `<id>~<label>` for each reading the classifier marks urgent, in list and label order. */
  readonly urgent: readonly string[];
  readonly evidenceDigest: string;
  readonly synthetic: true;
}

export interface ClassifierChangeRequest {
  readonly changeId: string;
  readonly authorId: string;
  readonly goldenSet: GoldenSet;
  readonly baseline: EvalReport;
  readonly candidate: EvalReport;
  readonly baselineFaults: FailureDirectionReport;
  readonly candidateFaults: FailureDirectionReport;
  /** The baseline catch list, scored for both classifiers; a dropped phrasing blocks the change. */
  readonly baselineCatch: CatchListReport;
  readonly candidateCatch: CatchListReport;
  readonly approval: HumanApproval | null;
}

export type ClassifierChangeDecision =
  | { readonly status: 'frozen'; readonly reasons: readonly string[] }
  | { readonly status: 'blocked'; readonly reasons: readonly string[] }
  | { readonly status: 'awaiting-human-approval'; readonly reasons: readonly string[] }
  | {
      readonly status: 'approved';
      readonly reasons: readonly string[];
      readonly change: ClassifierChangeRecord;
    };

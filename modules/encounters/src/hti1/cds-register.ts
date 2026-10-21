import { missingAttributes, type DsiCatalog } from './dsi.js';

/**
 * CDS classification register (WP-096; R6-REQ-092). Every AI use case is
 * classified against the four Non-Device CDS criteria.
 *
 * - `non-device-cds` requires all four criteria, and deploys clinically only
 *   with a registered, complete predictive DSI (the CDS-DSI link).
 * - A use case that failed a criterion may be `assistive-only` only with a
 *   recorded redesign, and never when it analyzes images or signals (a device
 *   function however it is presented).
 * - `escalated-device-review` never deploys; leaving it needs a recorded
 *   device-review decision.
 * - A classification is never overwritten: `reclassify` keeps the history.
 */

export interface NonDeviceCriteria {
  readonly noImageOrSignalAnalysis: boolean;
  readonly displaysOrAnalyzesMedicalInfo: boolean;
  readonly recommendationSupportsNotReplacesJudgment: boolean;
  readonly basisIndependentlyReviewable: boolean;
}

export type CdsClassification = 'non-device-cds' | 'assistive-only' | 'escalated-device-review';

export interface RedesignRecord {
  readonly changedCriteria: readonly (keyof NonDeviceCriteria)[];
  readonly reviewer: string;
  readonly rationale: string;
}

export interface CdsRegisterEntry {
  readonly useCaseId: string;
  readonly featureRef: string;
  readonly criteria: NonDeviceCriteria;
  readonly classification: CdsClassification;
  readonly predictiveDsiRef: string | null;
  readonly reviewedBy: string;
  /** Required for assistive-only when a criterion failed. */
  readonly redesign?: RedesignRecord;
  readonly synthetic: true;
}

export interface ReclassificationRecord {
  readonly prior: CdsRegisterEntry;
  readonly reviewer: string;
  readonly reason: string;
  readonly deviceReviewDecisionRef: string | null;
}

export class CdsRegisterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CdsRegisterError';
  }
}

export function meetsAllNonDeviceCriteria(criteria: NonDeviceCriteria): boolean {
  return (
    criteria.noImageOrSignalAnalysis &&
    criteria.displaysOrAnalyzesMedicalInfo &&
    criteria.recommendationSupportsNotReplacesJudgment &&
    criteria.basisIndependentlyReviewable
  );
}

function failedCriteria(criteria: NonDeviceCriteria): (keyof NonDeviceCriteria)[] {
  return (Object.keys(criteria) as (keyof NonDeviceCriteria)[]).filter((key) => !criteria[key]);
}

export class CdsRegister {
  private readonly entries = new Map<string, CdsRegisterEntry>();
  private readonly history = new Map<string, ReclassificationRecord[]>();

  /** `dsiCatalog` links the register to DSI source attributes (R6-REQ-042). */
  public constructor(private readonly dsiCatalog?: DsiCatalog) {}

  public classify(entry: CdsRegisterEntry): CdsRegisterEntry {
    if (this.entries.has(entry.useCaseId)) {
      throw new CdsRegisterError(`${entry.useCaseId} is already classified; use reclassify`);
    }
    this.validate(entry);
    this.entries.set(entry.useCaseId, entry);
    return entry;
  }

  public reclassify(
    next: CdsRegisterEntry,
    change: {
      readonly reviewer: string;
      readonly reason: string;
      readonly deviceReviewDecisionRef?: string;
    },
  ): CdsRegisterEntry {
    const prior = this.entries.get(next.useCaseId);
    if (prior === undefined) {
      throw new CdsRegisterError(`${next.useCaseId} is not classified`);
    }
    if (change.reviewer.trim() === '' || change.reason.trim() === '') {
      throw new CdsRegisterError('a reclassification needs a reviewer and a reason');
    }
    const decisionRef = change.deviceReviewDecisionRef?.trim() ?? '';
    if (
      prior.classification === 'escalated-device-review' &&
      next.classification !== 'escalated-device-review' &&
      decisionRef === ''
    ) {
      throw new CdsRegisterError('leaving device review needs a recorded device-review decision');
    }
    this.validate(next);
    const log = this.history.get(next.useCaseId) ?? [];
    log.push({
      prior,
      reviewer: change.reviewer,
      reason: change.reason,
      deviceReviewDecisionRef: decisionRef === '' ? null : decisionRef,
    });
    this.history.set(next.useCaseId, log);
    this.entries.set(next.useCaseId, next);
    return next;
  }

  public mayDeployClinically(useCaseId: string): boolean {
    const entry = this.entries.get(useCaseId);
    if (entry === undefined || entry.classification === 'escalated-device-review') {
      return false;
    }
    if (!entry.criteria.noImageOrSignalAnalysis) {
      return false;
    }
    if (entry.classification === 'assistive-only') {
      return meetsAllNonDeviceCriteria(entry.criteria) || entry.redesign !== undefined;
    }
    // non-device-cds: must carry a predictive DSI that is registered and complete. Without a linked
    // catalog the registration cannot be verified, so the entry does not deploy (fail closed).
    if (entry.predictiveDsiRef === null) {
      return false;
    }
    if (this.dsiCatalog === undefined) {
      return false;
    }
    const record = this.dsiCatalog.get(entry.predictiveDsiRef);
    return (
      record !== undefined && record.kind === 'predictive' && missingAttributes(record).length === 0
    );
  }

  /** Features with no classified use case. An empty result means complete. */
  public unclassifiedFeatures(featureRefs: readonly string[]): readonly string[] {
    const covered = new Set([...this.entries.values()].map((entry) => entry.featureRef));
    return featureRefs.filter((feature) => !covered.has(feature));
  }

  /** Non-device CDS entries that cannot deploy until they reference a predictive DSI. */
  public entriesNeedingDsi(): readonly CdsRegisterEntry[] {
    return [...this.entries.values()].filter(
      (entry) => entry.classification === 'non-device-cds' && entry.predictiveDsiRef === null,
    );
  }

  public get(useCaseId: string): CdsRegisterEntry | undefined {
    return this.entries.get(useCaseId);
  }

  public historyOf(useCaseId: string): readonly ReclassificationRecord[] {
    return [...(this.history.get(useCaseId) ?? [])];
  }

  private validate(entry: CdsRegisterEntry): void {
    if (entry.reviewedBy.trim() === '') {
      throw new CdsRegisterError('a classification needs a named reviewer');
    }
    const failed = failedCriteria(entry.criteria);
    if (entry.classification === 'non-device-cds' && failed.length > 0) {
      throw new CdsRegisterError(`${entry.useCaseId} fails a Non-Device CDS criterion`);
    }
    if (entry.classification === 'assistive-only' && failed.length > 0) {
      if (!entry.criteria.noImageOrSignalAnalysis) {
        throw new CdsRegisterError(
          `${entry.useCaseId} analyzes images or signals: escalate for device review`,
        );
      }
      const redesign = entry.redesign;
      if (
        redesign === undefined ||
        redesign.reviewer.trim() === '' ||
        redesign.rationale.trim() === '' ||
        !failed.every((criterion) => redesign.changedCriteria.includes(criterion))
      ) {
        throw new CdsRegisterError(
          `${entry.useCaseId} failed ${failed.join(', ')}: assistive-only needs a recorded redesign covering each`,
        );
      }
    }
  }
}

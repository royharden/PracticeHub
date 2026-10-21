import { createHash } from 'node:crypto';

import type { WorkbenchContext } from '../types.js';
import {
  identityMatchAttributeNames,
  specializedReviewPatternNames,
  type Confidence,
  type EngineMergeCase,
  type IdentityMergeEnginePort,
  type MatchAttribute,
  type SpecializedPattern,
} from './engine-port.js';

export class MergeQueueError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MergeQueueError';
  }
}

/**
 * One scored identity candidate from the import (the `IdentityCandidatePort`
 * output WP-110 hands off; FWD-MIG-012-IDENTITY-QUEUE). Attribute NAMES only.
 */
export interface ImportIdentityCandidate {
  readonly tenantId: string;
  readonly waveRef: string;
  readonly candidateRef: string;
  readonly importedPersonId: string;
  readonly existingPersonId: string;
  readonly matchedAttributes: readonly MatchAttribute[];
  readonly conflictingAttributes: readonly MatchAttribute[];
  readonly confidence: Confidence;
  /** Integer 0..1000; higher is a stronger match. */
  readonly score: number;
  readonly specializedPatterns: readonly SpecializedPattern[];
  readonly contactRisk: boolean;
  readonly sourceIdRefs: readonly string[];
  readonly synthetic: true;
}

export const mergeQueueLanes = [
  'specialized-review',
  'ambiguous',
  'high-confidence',
  'standard-review',
] as const;

export type MergeQueueLane = (typeof mergeQueueLanes)[number];

export interface QueuedMergeCase {
  readonly caseId: string;
  readonly stableKey: string;
  readonly candidateRef: string;
  readonly importedPersonId: string;
  readonly existingPersonId: string;
  readonly score: number;
  readonly lane: MergeQueueLane;
  readonly engineCase: EngineMergeCase;
}

export interface MergeQueueFeedReceipt {
  readonly opened: number;
  readonly alreadyQueued: number;
  readonly laneCounts: Readonly<Record<MergeQueueLane, number>>;
}

const refPattern = /^[a-z0-9][a-z0-9:._-]{0,127}$/;

function laneRank(lane: MergeQueueLane): number {
  return mergeQueueLanes.indexOf(lane);
}

/**
 * Import-scale duplicate-identity merge queue. Feeding is idempotent by
 * (tenant, wave, unordered person pair). Feeding opens governed merge cases
 * through the engine and never merges. A person under review in more than one
 * open case is ambiguous and leaves the bulk-eligible lane.
 */
export class ImportMergeQueue {
  readonly #cases = new Map<string, QueuedMergeCase>();
  readonly #byKey = new Map<string, string>();

  public constructor(
    private readonly engine: IdentityMergeEnginePort,
    public readonly context: WorkbenchContext,
    private readonly openedBy: string,
  ) {
    if (!refPattern.test(context.tenantId) || !refPattern.test(context.waveRef)) {
      throw new MergeQueueError('queue context must use constrained tenant and wave refs');
    }
    if (!refPattern.test(openedBy)) {
      throw new MergeQueueError('queue must record who opens its cases');
    }
  }

  #validate(candidate: ImportIdentityCandidate): void {
    if (candidate.synthetic !== true) {
      throw new MergeQueueError('identity candidate lacks the synthetic watermark');
    }
    if (
      candidate.tenantId !== this.context.tenantId ||
      candidate.waveRef !== this.context.waveRef
    ) {
      throw new MergeQueueError(`${candidate.candidateRef} crosses tenant or wave scope`);
    }
    for (const ref of [
      candidate.candidateRef,
      candidate.importedPersonId,
      candidate.existingPersonId,
    ]) {
      if (!refPattern.test(ref)) {
        throw new MergeQueueError('identity candidate carries an unconstrained reference');
      }
    }
    if (candidate.importedPersonId === candidate.existingPersonId) {
      throw new MergeQueueError(`${candidate.candidateRef} pairs a person with themselves`);
    }
    if (!Number.isInteger(candidate.score) || candidate.score < 0 || candidate.score > 1000) {
      throw new MergeQueueError(`${candidate.candidateRef} score must be an integer 0..1000`);
    }
    const attributes: readonly string[] = identityMatchAttributeNames;
    if (
      [...candidate.matchedAttributes, ...candidate.conflictingAttributes].some(
        (name) => !attributes.includes(name),
      )
    ) {
      throw new MergeQueueError(`${candidate.candidateRef} names an unknown identity attribute`);
    }
    const patterns: readonly string[] = specializedReviewPatternNames;
    if (candidate.specializedPatterns.some((pattern) => !patterns.includes(pattern))) {
      throw new MergeQueueError(`${candidate.candidateRef} names an unknown review pattern`);
    }
  }

  #baseLane(engineCase: EngineMergeCase): MergeQueueLane {
    if (engineCase.specializedPatterns.length > 0 || engineCase.contactRisk) {
      return 'specialized-review';
    }
    if (engineCase.confidence === 'high' && engineCase.conflictingAttributes.length === 0) {
      return 'high-confidence';
    }
    return 'standard-review';
  }

  #relane(): void {
    const exposure = new Map<string, number>();
    for (const queued of this.openCases()) {
      for (const person of queued.engineCase.personIds) {
        exposure.set(person, (exposure.get(person) ?? 0) + 1);
      }
    }
    for (const [caseId, queued] of this.#cases) {
      if (queued.engineCase.status !== 'open') {
        continue;
      }
      const base = this.#baseLane(queued.engineCase);
      const ambiguous = queued.engineCase.personIds.some(
        (person) => (exposure.get(person) ?? 0) > 1,
      );
      const lane = base === 'specialized-review' ? base : ambiguous ? 'ambiguous' : base;
      if (lane !== queued.lane) {
        this.#cases.set(caseId, { ...queued, lane });
      }
    }
  }

  public feed(candidates: readonly ImportIdentityCandidate[]): MergeQueueFeedReceipt {
    for (const candidate of candidates) {
      this.#validate(candidate);
    }
    let opened = 0;
    let alreadyQueued = 0;
    for (const candidate of candidates) {
      const pair = [candidate.importedPersonId, candidate.existingPersonId].sort();
      const stableKey = `${candidate.tenantId}|${candidate.waveRef}|${pair.join('|')}`;
      if (this.#byKey.has(stableKey)) {
        alreadyQueued += 1;
        continue;
      }
      const caseId = `mq-${createHash('sha256').update(stableKey).digest('hex').slice(0, 24)}`;
      const engineCase = this.engine.openMergeCase({
        caseId,
        tenantId: candidate.tenantId,
        kind: 'possible-match',
        personIds: [candidate.existingPersonId, candidate.importedPersonId],
        matchedAttributes: candidate.matchedAttributes,
        conflictingAttributes: candidate.conflictingAttributes,
        confidence: candidate.confidence,
        contactRisk: candidate.contactRisk,
        sourceIdRefs: candidate.sourceIdRefs,
        specializedPatterns: candidate.specializedPatterns,
        openedBy: this.openedBy,
        source: `migration-import:${candidate.waveRef}`,
      });
      this.#cases.set(caseId, {
        caseId,
        stableKey,
        candidateRef: candidate.candidateRef,
        importedPersonId: candidate.importedPersonId,
        existingPersonId: candidate.existingPersonId,
        score: candidate.score,
        lane: this.#baseLane(engineCase),
        engineCase,
      });
      this.#byKey.set(stableKey, caseId);
      opened += 1;
    }
    this.#relane();
    const laneCounts: Record<MergeQueueLane, number> = {
      'specialized-review': 0,
      ambiguous: 0,
      'high-confidence': 0,
      'standard-review': 0,
    };
    for (const queued of this.openCases()) {
      laneCounts[queued.lane] += 1;
    }
    return { opened, alreadyQueued, laneCounts };
  }

  public get(caseId: string): QueuedMergeCase | undefined {
    return this.#cases.get(caseId);
  }

  public openCases(): readonly QueuedMergeCase[] {
    return [...this.#cases.values()]
      .filter((queued) => queued.engineCase.status === 'open')
      .sort(
        (a, b) =>
          laneRank(a.lane) - laneRank(b.lane) ||
          b.score - a.score ||
          (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0),
      );
  }

  /** Deterministic keyset paging over open cases (lane priority, score desc, case id). */
  public page(options: {
    readonly limit: number;
    readonly lane?: MergeQueueLane;
    readonly afterCaseId?: string;
  }): { readonly items: readonly QueuedMergeCase[]; readonly nextAfter?: string } {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) {
      throw new MergeQueueError('page limit must be an integer 1..500');
    }
    const ordered = this.openCases().filter(
      (queued) => options.lane === undefined || queued.lane === options.lane,
    );
    const start =
      options.afterCaseId === undefined
        ? 0
        : ordered.findIndex((queued) => queued.caseId === options.afterCaseId) + 1;
    if (options.afterCaseId !== undefined && start === 0) {
      throw new MergeQueueError('paging cursor is not an open case in this view');
    }
    const items = ordered.slice(start, start + options.limit);
    const last = items.at(-1);
    return start + options.limit < ordered.length && last !== undefined
      ? { items, nextAfter: last.caseId }
      : { items };
  }

  /** Records the engine's resolved case (the queue itself never resolves or merges). */
  public recordResolution(resolved: EngineMergeCase): void {
    const queued = this.#cases.get(resolved.caseId);
    if (queued === undefined || resolved.tenantId !== this.context.tenantId) {
      throw new MergeQueueError(`${resolved.caseId} is not a case of this queue`);
    }
    this.#cases.set(resolved.caseId, { ...queued, engineCase: resolved });
    this.#relane();
  }
}

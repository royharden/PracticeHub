export const CASH_FULFILLMENT_STAGES = Object.freeze([
  Object.freeze({ stage: 'paid', ownerRole: 'role:billing-owner', agingThresholdMinutes: 60 }),
  Object.freeze({
    stage: 'scheduled',
    ownerRole: 'role:scheduling-owner',
    agingThresholdMinutes: 120,
  }),
  Object.freeze({
    stage: 'performed',
    ownerRole: 'role:clinical-owner',
    agingThresholdMinutes: 180,
  }),
  Object.freeze({
    stage: 'resulted',
    ownerRole: 'role:clinical-owner',
    agingThresholdMinutes: 240,
  }),
  Object.freeze({
    stage: 'reviewed',
    ownerRole: 'role:clinician-owner',
    agingThresholdMinutes: 300,
  }),
  Object.freeze({
    stage: 'delivered',
    ownerRole: 'role:guide-owner',
    agingThresholdMinutes: 360,
  }),
] as const);

export type CashFulfillmentStage = (typeof CASH_FULFILLMENT_STAGES)[number]['stage'];

/** Days after payment before paid-but-not-performed work counts as leakage (NR-175). */
export const CASH_LEAKAGE_GRACE_DAYS = 7;

export class CashPipelineError extends Error {
  public constructor(
    public readonly code:
      | 'STAGE_OWNER_REQUIRED'
      | 'STAGE_UNKNOWN'
      | 'CLOCK_INVALID'
      | 'WORK_CONFLICT'
      | 'NOT_FOUND'
      | 'STAGE_REGRESSION'
      | 'CORRECTION_INVALID',
  ) {
    super(code);
    this.name = 'CashPipelineError';
  }
}

export interface CashQueueEntry {
  readonly workRef: string;
  readonly stage: CashFulfillmentStage;
  readonly ownerRole: string;
  readonly ageMinutes: number;
  readonly thresholdMinutes: number;
}

export interface CashQueueReport {
  readonly entries: readonly CashQueueEntry[];
  /** Work the clock could not age (for example entered after `now`); reported, never fatal. */
  readonly skipped: readonly { readonly workRef: string; readonly reason: 'CLOCK_INVALID' }[];
}

export interface CashPackageRollup {
  readonly packageRef: string;
  readonly children: readonly {
    readonly childRef: string;
    readonly stage: CashFulfillmentStage;
    readonly fulfilled: boolean;
  }[];
  readonly unfulfilledChildRefs: readonly string[];
  readonly partial: boolean;
}

export interface CashLeakage {
  readonly paidNotPerformed: number;
  readonly workRefs: readonly string[];
}

interface TrackedWork {
  readonly tenantId: string;
  readonly workRef: string;
  readonly packageRef: string;
  readonly stage: CashFulfillmentStage;
  readonly enteredAt: string;
}

/** One append-only transition of a work item (NR-093: the pipeline is event-sourced). */
export interface CashStageEvent {
  readonly kind: 'tracked' | 'advanced' | 'corrected';
  readonly stage: CashFulfillmentStage;
  readonly enteredAt: string;
  readonly actorRef: string | null;
  readonly reason: string | null;
}

const stageRow = (stage: CashFulfillmentStage) => {
  const found = CASH_FULFILLMENT_STAGES.find((row) => row.stage === stage);
  if (found === undefined) throw new CashPipelineError('STAGE_UNKNOWN');
  const ownerRole: string = found.ownerRole;
  if (ownerRole === '') throw new CashPipelineError('STAGE_OWNER_REQUIRED');
  return found;
};

const stageIndex = (stage: CashFulfillmentStage): number =>
  CASH_FULFILLMENT_STAGES.findIndex((row) => row.stage === stage);

const instantMs = (value: string): number => {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new CashPipelineError('CLOCK_INVALID');
  return ms;
};

const ageMinutes = (enteredAt: string, now: string): number => {
  const start = instantMs(enteredAt);
  const end = instantMs(now);
  if (end < start) throw new CashPipelineError('CLOCK_INVALID');
  return Math.floor((end - start) / 60_000);
};

const workKey = (tenantId: string, workRef: string): string => JSON.stringify([tenantId, workRef]);

export class CashFulfillmentPipeline {
  readonly #works = new Map<string, TrackedWork>();
  readonly #history = new Map<string, CashStageEvent[]>();

  public track(work: TrackedWork): TrackedWork {
    stageRow(work.stage);
    if (work.workRef === '' || work.packageRef === '' || work.tenantId === '') {
      throw new CashPipelineError('WORK_CONFLICT');
    }
    instantMs(work.enteredAt);
    const key = workKey(work.tenantId, work.workRef);
    const prior = this.#works.get(key);
    const stored = Object.freeze({ ...work });
    if (prior !== undefined) {
      const first = this.#history.get(key)?.[0];
      const sameTrack =
        first !== undefined &&
        first.kind === 'tracked' &&
        first.stage === stored.stage &&
        first.enteredAt === stored.enteredAt &&
        prior.packageRef === stored.packageRef;
      if (!sameTrack) throw new CashPipelineError('WORK_CONFLICT');
      return prior;
    }
    this.#works.set(key, stored);
    this.#history.set(key, [
      Object.freeze({
        kind: 'tracked',
        stage: work.stage,
        enteredAt: work.enteredAt,
        actorRef: null,
        reason: null,
      }),
    ]);
    return stored;
  }

  /**
   * Moves work forward. A stage that is not later than the current one, or a time that does not
   * parse or is earlier than the current stage's time, is refused; nothing is overwritten.
   */
  public advance(
    tenantId: string,
    workRef: string,
    stage: CashFulfillmentStage,
    enteredAt: string,
  ): TrackedWork {
    const prior = this.#require(tenantId, workRef);
    stageRow(stage);
    if (stageIndex(stage) <= stageIndex(prior.stage))
      throw new CashPipelineError('STAGE_REGRESSION');
    this.#requireNotEarlier(prior, enteredAt);
    return this.#append(prior, stage, enteredAt, {
      kind: 'advanced',
      actorRef: null,
      reason: null,
    });
  }

  /**
   * A named correction: the only way to move work to an earlier (or the same) stage. It needs an
   * actor and a reason, and it is appended to the history like any other transition.
   */
  public correctStage(
    tenantId: string,
    workRef: string,
    stage: CashFulfillmentStage,
    enteredAt: string,
    correction: { readonly actorRef: string; readonly reason: string },
  ): TrackedWork {
    const prior = this.#require(tenantId, workRef);
    stageRow(stage);
    if (correction.actorRef.trim() === '' || correction.reason.trim() === '') {
      throw new CashPipelineError('CORRECTION_INVALID');
    }
    this.#requireNotEarlier(prior, enteredAt);
    return this.#append(prior, stage, enteredAt, {
      kind: 'corrected',
      actorRef: correction.actorRef,
      reason: correction.reason,
    });
  }

  public history(tenantId: string, workRef: string): readonly CashStageEvent[] {
    this.#require(tenantId, workRef);
    return Object.freeze([...(this.#history.get(workKey(tenantId, workRef)) ?? [])]);
  }

  /** Aged queue plus the work the clock could not age. One bad record never fails the tenant. */
  public agedQueueReport(tenantId: string, now: string): CashQueueReport {
    instantMs(now);
    const entries: CashQueueEntry[] = [];
    const skipped: { workRef: string; reason: 'CLOCK_INVALID' }[] = [];
    for (const work of this.#works.values()) {
      if (work.tenantId !== tenantId) continue;
      const stage = stageRow(work.stage);
      let age: number;
      try {
        age = ageMinutes(work.enteredAt, now);
      } catch {
        skipped.push({ workRef: work.workRef, reason: 'CLOCK_INVALID' });
        continue;
      }
      if (age < stage.agingThresholdMinutes) continue;
      entries.push(
        Object.freeze({
          workRef: work.workRef,
          stage: work.stage,
          ownerRole: stage.ownerRole,
          ageMinutes: age,
          thresholdMinutes: stage.agingThresholdMinutes,
        }),
      );
    }
    return Object.freeze({ entries: Object.freeze(entries), skipped: Object.freeze(skipped) });
  }

  public agedQueue(tenantId: string, now: string): readonly CashQueueEntry[] {
    return this.agedQueueReport(tenantId, now).entries;
  }

  public rollup(tenantId: string, packageRef: string): CashPackageRollup {
    const children = [...this.#works.values()]
      .filter((work) => work.tenantId === tenantId && work.packageRef === packageRef)
      .map((work) =>
        Object.freeze({
          childRef: work.workRef,
          stage: work.stage,
          fulfilled: work.stage === 'delivered',
        }),
      );
    const unfulfilledChildRefs = children
      .filter((child) => !child.fulfilled)
      .map((child) => child.childRef);
    const fulfilledCount = children.length - unfulfilledChildRefs.length;
    return Object.freeze({
      packageRef,
      children: Object.freeze(children),
      unfulfilledChildRefs: Object.freeze(unfulfilledChildRefs),
      partial: fulfilledCount > 0 && unfulfilledChildRefs.length > 0,
    });
  }

  /**
   * Paid work not yet performed. With options.now, work counts only once it has been paid for at
   * least graceDays (default 7; NR-175), measured from the first time it was at the paid stage
   * (or from when it was tracked, if it was tracked past paid). Without options the legacy ungraced
   * count is returned.
   * @deprecated the no-clock form; pass { now }.
   */
  public leakage(
    tenantId: string,
    options?: { readonly now: string; readonly graceDays?: number },
  ): CashLeakage {
    const performedAt = stageIndex('performed');
    const graceDays = options?.graceDays ?? CASH_LEAKAGE_GRACE_DAYS;
    if (!Number.isSafeInteger(graceDays) || graceDays < 0)
      throw new CashPipelineError('CLOCK_INVALID');
    const nowMs = options === undefined ? null : instantMs(options.now);
    const workRefs = [...this.#works.values()]
      .filter((work) => work.tenantId === tenantId && stageIndex(work.stage) < performedAt)
      .filter((work) => nowMs === null || nowMs - this.#paidAtMs(work) >= graceDays * 86_400_000)
      .map((work) => work.workRef);
    return Object.freeze({
      paidNotPerformed: workRefs.length,
      workRefs: Object.freeze(workRefs),
    });
  }

  #paidAtMs(work: TrackedWork): number {
    const events = this.#history.get(workKey(work.tenantId, work.workRef)) ?? [];
    const paid = events.find((event) => event.stage === 'paid') ?? events[0];
    return instantMs(paid?.enteredAt ?? work.enteredAt);
  }

  #require(tenantId: string, workRef: string): TrackedWork {
    const prior = this.#works.get(workKey(tenantId, workRef));
    if (prior === undefined) throw new CashPipelineError('NOT_FOUND');
    return prior;
  }

  #requireNotEarlier(prior: TrackedWork, enteredAt: string): void {
    if (instantMs(enteredAt) < instantMs(prior.enteredAt))
      throw new CashPipelineError('CLOCK_INVALID');
  }

  #append(
    prior: TrackedWork,
    stage: CashFulfillmentStage,
    enteredAt: string,
    event: Pick<CashStageEvent, 'kind' | 'actorRef' | 'reason'>,
  ): TrackedWork {
    const key = workKey(prior.tenantId, prior.workRef);
    const stored = Object.freeze({ ...prior, stage, enteredAt });
    this.#works.set(key, stored);
    this.#history.set(key, [
      ...(this.#history.get(key) ?? []),
      Object.freeze({ ...event, stage, enteredAt }),
    ]);
    return stored;
  }
}

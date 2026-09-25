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

export class CashPipelineError extends Error {
  public constructor(
    public readonly code:
      'STAGE_OWNER_REQUIRED' | 'STAGE_UNKNOWN' | 'CLOCK_INVALID' | 'WORK_CONFLICT' | 'NOT_FOUND',
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

const stageRow = (stage: CashFulfillmentStage) => {
  const found = CASH_FULFILLMENT_STAGES.find((row) => row.stage === stage);
  if (found === undefined) throw new CashPipelineError('STAGE_UNKNOWN');
  const ownerRole: string = found.ownerRole;
  if (ownerRole === '') throw new CashPipelineError('STAGE_OWNER_REQUIRED');
  return found;
};

const stageIndex = (stage: CashFulfillmentStage): number =>
  CASH_FULFILLMENT_STAGES.findIndex((row) => row.stage === stage);

const ageMinutes = (enteredAt: string, now: string): number => {
  const start = Date.parse(enteredAt);
  const end = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new CashPipelineError('CLOCK_INVALID');
  }
  return Math.floor((end - start) / 60_000);
};

const workKey = (tenantId: string, workRef: string): string => JSON.stringify([tenantId, workRef]);

export class CashFulfillmentPipeline {
  readonly #works = new Map<string, TrackedWork>();

  public track(work: TrackedWork): TrackedWork {
    stageRow(work.stage);
    if (work.workRef === '' || work.packageRef === '' || work.tenantId === '') {
      throw new CashPipelineError('WORK_CONFLICT');
    }
    ageMinutes(work.enteredAt, work.enteredAt);
    const key = workKey(work.tenantId, work.workRef);
    const prior = this.#works.get(key);
    const stored = Object.freeze({ ...work });
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(stored)) {
      throw new CashPipelineError('WORK_CONFLICT');
    }
    this.#works.set(key, stored);
    return stored;
  }

  public advance(
    tenantId: string,
    workRef: string,
    stage: CashFulfillmentStage,
    enteredAt: string,
  ): TrackedWork {
    const prior = this.#works.get(workKey(tenantId, workRef));
    if (prior === undefined) throw new CashPipelineError('NOT_FOUND');
    stageRow(stage);
    const stored = Object.freeze({ ...prior, stage, enteredAt });
    this.#works.set(workKey(tenantId, workRef), stored);
    return stored;
  }

  public agedQueue(tenantId: string, now: string): readonly CashQueueEntry[] {
    const entries: CashQueueEntry[] = [];
    for (const work of this.#works.values()) {
      if (work.tenantId !== tenantId) continue;
      const stage = stageRow(work.stage);
      const age = ageMinutes(work.enteredAt, now);
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
    return Object.freeze(entries);
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

  public leakage(tenantId: string): CashLeakage {
    const performedAt = stageIndex('performed');
    const workRefs = [...this.#works.values()]
      .filter((work) => work.tenantId === tenantId && stageIndex(work.stage) < performedAt)
      .map((work) => work.workRef);
    return Object.freeze({
      paidNotPerformed: workRefs.length,
      workRefs: Object.freeze(workRefs),
    });
  }
}

export const FULFILLMENT_STAGES = Object.freeze([
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

export type FulfillmentStage = (typeof FULFILLMENT_STAGES)[number]['stage'];

export interface StageDefinition {
  readonly stage: FulfillmentStage;
  readonly ownerRole: string;
  readonly agingThresholdMinutes: number;
}

export class PipelineError extends Error {
  public constructor(
    public readonly code: 'STAGE_OWNER_REQUIRED' | 'STAGE_UNKNOWN' | 'CLOCK_INVALID',
  ) {
    super(code);
    this.name = 'PipelineError';
  }
}

export interface AgedQueueEntry {
  readonly workRef: string;
  readonly stage: FulfillmentStage;
  readonly ownerRole: string;
  readonly ageMinutes: number;
  readonly thresholdMinutes: number;
}

export interface PackageChild {
  readonly childRef: string;
  readonly stage: FulfillmentStage;
}

export interface PackageRollup {
  readonly packageRef: string;
  readonly children: readonly {
    readonly childRef: string;
    readonly stage: FulfillmentStage;
    readonly fulfilled: boolean;
  }[];
  readonly unfulfilledChildRefs: readonly string[];
  readonly partial: boolean;
}

const stageIndex = (stage: FulfillmentStage): number =>
  FULFILLMENT_STAGES.findIndex((row) => row.stage === stage);

export const stageDefinition = (stage: FulfillmentStage): StageDefinition => {
  const found = FULFILLMENT_STAGES.find((row) => row.stage === stage);
  if (found === undefined) throw new PipelineError('STAGE_UNKNOWN');
  const ownerRole: string = found.ownerRole;
  if (ownerRole === '') throw new PipelineError('STAGE_OWNER_REQUIRED');
  return found;
};

export const ageMinutes = (enteredAt: string, now: string): number => {
  const start = Date.parse(enteredAt);
  const end = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new PipelineError('CLOCK_INVALID');
  }
  return Math.floor((end - start) / 60_000);
};

export const queueForAge = (input: {
  readonly workRef: string;
  readonly stage: StageDefinition;
  readonly enteredAt: string;
  readonly now: string;
}): AgedQueueEntry | null => {
  if (input.stage.ownerRole === '' || input.workRef === '') {
    throw new PipelineError('STAGE_OWNER_REQUIRED');
  }
  if (
    !Number.isSafeInteger(input.stage.agingThresholdMinutes) ||
    input.stage.agingThresholdMinutes <= 0
  ) {
    throw new PipelineError('CLOCK_INVALID');
  }
  const age = ageMinutes(input.enteredAt, input.now);
  if (age < input.stage.agingThresholdMinutes) return null;
  return Object.freeze({
    workRef: input.workRef,
    stage: input.stage.stage,
    ownerRole: input.stage.ownerRole,
    ageMinutes: age,
    thresholdMinutes: input.stage.agingThresholdMinutes,
  });
};

export const rollupPackage = (
  packageRef: string,
  children: readonly PackageChild[],
): PackageRollup => {
  const listed = children.map((child) =>
    Object.freeze({
      childRef: child.childRef,
      stage: child.stage,
      fulfilled: child.stage === 'delivered',
    }),
  );
  const unfulfilledChildRefs = listed
    .filter((child) => !child.fulfilled)
    .map((child) => child.childRef);
  const fulfilledCount = listed.length - unfulfilledChildRefs.length;
  return Object.freeze({
    packageRef,
    children: Object.freeze(listed),
    unfulfilledChildRefs: Object.freeze(unfulfilledChildRefs),
    partial: fulfilledCount > 0 && unfulfilledChildRefs.length > 0,
  });
};

export const leakageWorkRefs = (
  works: readonly { readonly workRef: string; readonly stage: FulfillmentStage }[],
): readonly string[] => {
  const performedAt = stageIndex('performed');
  return Object.freeze(
    works.filter((work) => stageIndex(work.stage) < performedAt).map((work) => work.workRef),
  );
};

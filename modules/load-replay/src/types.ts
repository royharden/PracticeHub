export const stressContracts = [
  'consent-ledger',
  'sla-engine',
  'entitlement-ledger',
  'mpi-merge-queues',
  'possible-match-search-p95',
] as const;
export type StressContract = (typeof stressContracts)[number];

export const loadReplayCeiling = 'simulated' as const;

export interface ReplayEvent {
  readonly id: string;
  readonly contract: StressContract;
  readonly synthetic: true;
}

export interface FlushProof {
  readonly applied: readonly string[];
  readonly duplicatesDropped: number;
  readonly lost: number;
  readonly synthetic: true;
}

export class LoadReplayRefusal extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LoadReplayRefusal';
  }
}

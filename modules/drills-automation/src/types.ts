export type DrillKind = 'failover' | 'restore' | 'kill-switch' | 'degraded';

export type DrillVerdict = 'passed' | 'failed' | 'skipped';

export interface DrillDefinition {
  readonly contractId: 'drill-registry/v1';
  readonly drillId: string;
  readonly kind: DrillKind;
  readonly cadenceMs: number;
  readonly synthetic: true;
}

export interface DrillRun {
  readonly drillId: string;
  readonly scheduledAt: string;
  readonly startedAt: string | null;
  readonly verdict: DrillVerdict;
  readonly releaseBlocking: boolean;
  readonly finding: string | null;
  readonly synthetic: true;
}

export class DrillError extends Error {
  public override readonly name = 'DrillError';
  public constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

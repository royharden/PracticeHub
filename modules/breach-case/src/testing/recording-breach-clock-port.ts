import type {
  BreachClockMutationInputV1,
  BreachClockOpenInputV1,
  BreachClockPortV1,
} from '../ports.js';
import type { JurisdictionDuty } from '../breach-case.js';

export class RecordingBreachClockPortV1 implements BreachClockPortV1 {
  public readonly version = 'v1' as const;
  public readonly opened: BreachClockOpenInputV1[] = [];
  public readonly escalated: BreachClockMutationInputV1[] = [];
  public readonly satisfied: BreachClockMutationInputV1[] = [];
  public readonly cancelled: BreachClockMutationInputV1[] = [];

  public constructor(private readonly duties: readonly JurisdictionDuty[]) {}

  public async openNotificationDuties(
    input: BreachClockOpenInputV1,
  ): Promise<readonly JurisdictionDuty[]> {
    this.opened.push(input);
    return this.duties.map((duty) => ({ ...duty }));
  }

  public async escalate(
    input: BreachClockMutationInputV1,
  ): Promise<{ readonly clockEventRef: string }> {
    this.escalated.push(input);
    return { clockEventRef: `clock-event:${input.idempotencyKey}` };
  }

  public async satisfy(
    input: BreachClockMutationInputV1,
  ): Promise<{ readonly clockEventRef: string }> {
    this.satisfied.push(input);
    return { clockEventRef: `clock-event:${input.idempotencyKey}` };
  }

  public async cancelWithEvidence(
    input: BreachClockMutationInputV1,
  ): Promise<{ readonly clockEventRef: string }> {
    this.cancelled.push(input);
    return { clockEventRef: `clock-event:${input.idempotencyKey}` };
  }
}

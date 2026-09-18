import type { HumanHandoff, TenantId, TouchpointId } from './types.js';
import { KillSwitchError } from './types.js';

export class HumanFallback {
  private readonly handoffs: HumanHandoff[] = [];

  public handoff(input: {
    readonly tenantId: TenantId;
    readonly touchpointId: TouchpointId;
    readonly inFlightRef: string;
    readonly at: string;
  }): HumanHandoff {
    if (input.inFlightRef.length === 0) {
      throw new KillSwitchError('in-flight ref required', 'missing-inflight');
    }
    const row: HumanHandoff = Object.freeze({
      tenantId: input.tenantId,
      touchpointId: input.touchpointId,
      inFlightRef: input.inFlightRef,
      handedOffAt: input.at,
      deadEnd: false,
      synthetic: true,
    });
    this.handoffs.push(row);
    return row;
  }

  public forTouchpoint(tenantId: TenantId, touchpointId: TouchpointId): readonly HumanHandoff[] {
    return this.handoffs.filter(
      (row) => row.tenantId === tenantId && row.touchpointId === touchpointId,
    );
  }
}

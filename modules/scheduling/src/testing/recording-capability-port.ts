import type { CapabilityDecision, CapabilityRequest, SchedulingCapabilityPort } from '../ports.js';

export class RecordingCapabilityPort implements SchedulingCapabilityPort {
  readonly requests: CapabilityRequest[] = [];
  private readonly decisions: CapabilityDecision[];

  constructor(decisions: readonly CapabilityDecision[] = [{ allowed: true }]) {
    this.decisions = [...decisions];
  }

  async evaluate(request: CapabilityRequest): Promise<CapabilityDecision> {
    this.requests.push(structuredClone(request));
    return this.decisions.shift() ?? { allowed: true };
  }
}

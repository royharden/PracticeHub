import type { GoldenSetEvidence, TouchpointId } from './types.js';
import { KillSwitchError } from './types.js';

/** Owned WP-101 double. Not modules/ai-evals. Golden-set floors for re-enable only. */
export class Wp101EvalDouble {
  public evidenceFor(touchpointId: TouchpointId, floorsMet: boolean): GoldenSetEvidence {
    return Object.freeze({
      contractId: 'wp101-eval-double/v1',
      touchpointId,
      evalRunRef: `eval-double:${touchpointId}`,
      floorsMet,
      synthetic: true,
    });
  }

  public requireFloors(evidence: GoldenSetEvidence): void {
    if (evidence.contractId !== 'wp101-eval-double/v1') {
      throw new KillSwitchError('unknown eval evidence', 'eval-contract');
    }
    if (!evidence.floorsMet) {
      throw new KillSwitchError('golden-set floors not met', 'eval-floors');
    }
  }
}

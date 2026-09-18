import type { KillSwitchConsole } from './kill-switch.js';
import type { ReenableDecision, SurfacePath } from './types.js';
import { KillSwitchError } from './types.js';
import type { Wp101EvalDouble } from './wp101-eval-double.js';

export class ReenableConsole {
  public constructor(
    private readonly kills: KillSwitchConsole,
    private readonly evals: Wp101EvalDouble,
  ) {}

  public apply(decision: ReenableDecision): SurfacePath {
    const kill = this.kills.currentKill(decision.tenantId, decision.touchpointId);
    if (kill === undefined) {
      throw new KillSwitchError('touchpoint is not killed', 'not-killed');
    }
    if (
      decision.practiceManagerSignOff.length === 0 ||
      decision.governanceBoardSignOff.length === 0
    ) {
      throw new KillSwitchError('dual sign-off required', 'sign-off');
    }
    if (decision.practiceManagerSignOff === decision.governanceBoardSignOff) {
      throw new KillSwitchError(
        'practice manager and board sign-off must be distinct',
        'sign-off-distinct',
      );
    }
    this.evals.requireFloors(decision.goldenSet);
    if (decision.goldenSet.touchpointId !== decision.touchpointId) {
      throw new KillSwitchError('eval evidence is for another touchpoint', 'eval-touchpoint');
    }
    if (!decision.supervisedRepilotCleared) {
      throw new KillSwitchError('supervised re-pilot has not cleared the threshold', 'repilot');
    }
    this.kills.releaseAfterGovernedReenable(decision.tenantId, decision.touchpointId);
    return this.kills.path(decision.tenantId, decision.touchpointId);
  }
}

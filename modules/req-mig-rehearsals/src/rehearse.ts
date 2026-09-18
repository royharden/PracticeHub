import type { CutoverDouble, WorkbenchDouble } from './ports.js';
import {
  RehearsalRefusal,
  rehearsalCeiling,
  type LeftoverReq,
  type RehearsalResult,
} from './types.js';

export interface RehearsalPorts {
  readonly workbench: WorkbenchDouble;
  readonly cutover: CutoverDouble;
}

export function assertSimulated(): void {
  if (rehearsalCeiling !== 'simulated') {
    throw new RehearsalRefusal('WP-129 rehearsals stay simulated');
  }
}

export function rehearse(ports: RehearsalPorts, req: LeftoverReq): RehearsalResult {
  assertSimulated();
  if (!ports.workbench.dryRunAccepted()) {
    throw new RehearsalRefusal('workbench double refused the leftover rehearsal');
  }
  if (req === 'REQ-MIG-001') {
    return { req, outcome: 'captured', synthetic: true };
  }
  if (req === 'REQ-MIG-007') {
    return { req, outcome: 'continued', synthetic: true };
  }
  if (req === 'REQ-MIG-008') {
    return { req, outcome: 'preserved', synthetic: true };
  }
  if (req === 'REQ-MIG-009') {
    return { req, outcome: 'reconciled', synthetic: true };
  }
  if (ports.cutover.frozen()) {
    throw new RehearsalRefusal('re-run protocol cannot mutate a frozen cutover mapping');
  }
  return { req, outcome: 'rerun', synthetic: true };
}

export function rewriteWorkbench(): never {
  throw new RehearsalRefusal('do not rewrite migration-workbench');
}

export function unresolvedP0StaysLegacy(): RehearsalResult {
  assertSimulated();
  return { req: 'REQ-MIG-001', outcome: 'blocked', synthetic: true };
}

export function privacyBypassForbidden(): never {
  throw new RehearsalRefusal('local practice may not bypass privacy or audit controls');
}

export function waveFailRedirectsIntake(): RehearsalResult {
  assertSimulated();
  return { req: 'REQ-MIG-007', outcome: 'continued', synthetic: true };
}

export function unmappedWorkflowPausesWave(): never {
  throw new RehearsalRefusal('unmapped workflow pauses the wave');
}

export function missingDeadlineInventoryBlocks(): never {
  throw new RehearsalRefusal('unbalanced deadline inventory blocks the cohort');
}

export function exclusive835ExtendsOverlap(): never {
  throw new RehearsalRefusal('exclusive 835 enrollment extends controlled overlap');
}

export function staleExtractBlocksRerun(): never {
  throw new RehearsalRefusal('stale extract blocks re-run until re-extract');
}

export function skippedCommsGateCutover(): never {
  throw new RehearsalRefusal('cutover is gated on stakeholder notification');
}

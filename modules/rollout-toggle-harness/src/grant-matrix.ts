import {
  capabilityStates,
  type CapabilityGrant,
  type CapabilityId,
  type CapabilityState,
} from '@practicehub/platform-core';

import { Wp030LocalDouble } from './bindings/wp030-binding.js';
import { Wp031LocalDouble } from './bindings/wp031-binding.js';
import { Wp032CapabilityDoubleV1 } from './bindings/wp032-capability-double-v1.js';
import {
  HarnessError,
  TENANT_A,
  TENANT_B,
  WP030_LOCAL_CAPABILITY_ID,
  WP031_LOCAL_CAPABILITY_ID,
  WP032_LOCAL_CAPABILITY_ID,
  localHarnessRegistry,
  type BindingParity,
  type EffectSnapshot,
  type GateInput,
  type LoopToggleBindingV1,
  type TenantScopedClinicalProposal,
  type TenantScopedLoopInput,
  type WorkPackageLoop,
} from './contracts.js';
import { EffectRecorder, tenantCount } from './effect-recorder.js';

export const matrixRows = [
  'M1',
  'M2',
  'M3',
  'M4',
  'M5',
  'M6',
  'M7',
  'M8',
  'M9',
  'M10',
  'M11',
  'M12',
  'M13',
  'M14',
] as const;
export type MatrixRow = (typeof matrixRows)[number];

const capabilityByPackage: Record<WorkPackageLoop, CapabilityId> = {
  'WP-030': WP030_LOCAL_CAPABILITY_ID,
  'WP-031': WP031_LOCAL_CAPABILITY_ID,
  'WP-032': WP032_LOCAL_CAPABILITY_ID,
};

export function makeGrant(
  capabilityId: CapabilityId,
  tenantId: string,
  state: CapabilityState,
  eventId: string,
): CapabilityGrant {
  return {
    capabilityId,
    tenantId,
    scope: {},
    state,
    sinceEventId: eventId,
    evidenceRefs: ['synthetic:wp034'],
    rollbackRef: 'rollback:wp034',
    synthetic: true,
  };
}

export function assertKnownState(state: string): CapabilityState {
  if (!(capabilityStates as readonly string[]).includes(state)) {
    throw new HarnessError('MALFORMED_GRANT_STATE', state);
  }
  return state as CapabilityState;
}

function loopInput(
  tenantId: string,
  requestKey: string,
  payloadHash = 'payload-v1',
): TenantScopedLoopInput {
  return { requestKey, tenantId, payloadHash, synthetic: true };
}

function clinicalInput(
  tenantId: string,
  requestKey: string,
  payloadHash = 'payload-v1',
): TenantScopedClinicalProposal {
  return {
    requestKey,
    tenantId,
    subjectRef: 'subject-1',
    proposalRef: 'proposal-1',
    expectedSourceVersion: 'v1',
    payloadHash,
    synthetic: true,
  };
}

function gateFor(
  registry: ReturnType<typeof localHarnessRegistry>,
  grants: readonly CapabilityGrant[],
  tenantId: string,
  checkpoint: 'enqueue' | 'drain',
  version: number,
): GateInput {
  return {
    registry,
    grants,
    grantSnapshotVersion: version,
    context: { tenantId, scope: {} },
    checkpoint,
  };
}

export interface MatrixWorld {
  readonly recorder: EffectRecorder;
  readonly registry: ReturnType<typeof localHarnessRegistry>;
  readonly binding:
    LoopToggleBindingV1<TenantScopedLoopInput, TenantScopedLoopInput> | Wp032CapabilityDoubleV1;
  readonly capabilityId: CapabilityId;
  readonly workPackage: WorkPackageLoop;
}

export function createWorld(workPackage: WorkPackageLoop): MatrixWorld {
  const recorder = new EffectRecorder();
  const registry = localHarnessRegistry();
  const capabilityId = capabilityByPackage[workPackage];
  const binding =
    workPackage === 'WP-030'
      ? new Wp030LocalDouble(recorder)
      : workPackage === 'WP-031'
        ? new Wp031LocalDouble(recorder)
        : new Wp032CapabilityDoubleV1(recorder);
  return { recorder, registry, binding, capabilityId, workPackage };
}

async function invoke(
  world: MatrixWorld,
  tenantId: string,
  grants: readonly CapabilityGrant[],
  checkpoint: 'enqueue' | 'drain',
  version: number,
  requestKey = 'op-1',
  payloadHash = 'payload-v1',
): Promise<EffectSnapshot> {
  const gate = gateFor(world.registry, grants, tenantId, checkpoint, version);
  if (world.workPackage === 'WP-032') {
    const double = world.binding as Wp032CapabilityDoubleV1;
    const input = clinicalInput(tenantId, requestKey, payloadHash);
    return checkpoint === 'enqueue' ? double.enqueue(input, gate) : double.drain(input, gate);
  }
  const binding = world.binding as LoopToggleBindingV1<
    TenantScopedLoopInput,
    TenantScopedLoopInput
  >;
  const input = loopInput(tenantId, requestKey, payloadHash);
  return checkpoint === 'enqueue' ? binding.enqueue(input, gate) : binding.drain(input, gate);
}

function grantsFor(
  capabilityId: CapabilityId,
  a: CapabilityState | 'absent',
  b: CapabilityState | 'absent',
): CapabilityGrant[] {
  const grants: CapabilityGrant[] = [];
  if (a !== 'absent') grants.push(makeGrant(capabilityId, TENANT_A, a, 'evt-a'));
  if (b !== 'absent') grants.push(makeGrant(capabilityId, TENANT_B, b, 'evt-b'));
  return grants;
}

function assertDenied(snapshot: EffectSnapshot, tenantId: string, drainedBefore: number): void {
  if (snapshot.lastDecision?.allowed === true) {
    throw new HarnessError('EXPECTED_DENY', tenantId);
  }
  if (tenantCount(snapshot.drainedEffects, tenantId) !== drainedBefore) {
    throw new HarnessError('DENY_LEFT_EFFECT', tenantId);
  }
}

function assertAllowedDrain(snapshot: EffectSnapshot, tenantId: string): void {
  const decision = snapshot.lastDecision;
  if (decision === null || decision.allowed !== true || decision.tenantId !== tenantId) {
    throw new HarnessError('EXPECTED_ALLOW', tenantId);
  }
  if (decision.checkpoint !== 'drain' || decision.minimumState !== 'simulated') {
    throw new HarnessError('DECISION_SHAPE', tenantId);
  }
  if (tenantCount(snapshot.drainedEffects, tenantId) < 1) {
    throw new HarnessError('MISSING_DRAIN_EFFECT', tenantId);
  }
}

export async function runMatrixRow(
  workPackage: WorkPackageLoop,
  row: MatrixRow,
  orientation: 'ab' | 'ba' = 'ab',
): Promise<EffectSnapshot> {
  if (row === 'M12') {
    assertKnownState('not-a-state');
  }
  const world = createWorld(workPackage);
  const first = orientation === 'ab' ? TENANT_A : TENANT_B;
  const second = orientation === 'ab' ? TENANT_B : TENANT_A;
  const pair = (
    left: CapabilityState | 'absent',
    right: CapabilityState | 'absent',
  ): CapabilityGrant[] =>
    orientation === 'ab'
      ? grantsFor(world.capabilityId, left, right)
      : grantsFor(world.capabilityId, right, left);

  if (row === 'M1' || row === 'M2') {
    const darkFirst = row === 'M1';
    const grants = darkFirst ? pair('disabled', 'simulated') : pair('simulated', 'disabled');
    const dark = darkFirst ? first : second;
    const lit = darkFirst ? second : first;
    const beforeDarkDrain = 0;
    assertDenied(await invoke(world, dark, grants, 'enqueue', 1), dark, beforeDarkDrain);
    assertDenied(await invoke(world, dark, grants, 'drain', 1), dark, beforeDarkDrain);
    await invoke(world, lit, grants, 'enqueue', 1);
    const after = await invoke(world, lit, grants, 'drain', 1);
    assertAllowedDrain(after, lit);
    if (tenantCount(after.drainedEffects, dark) !== 0) {
      throw new HarnessError('DARK_BLEED', dark);
    }
    return after;
  }

  if (row === 'M3') {
    const grants = pair('absent', 'simulated');
    assertDenied(await invoke(world, first, grants, 'enqueue', 1), first, 0);
    assertDenied(await invoke(world, first, grants, 'drain', 1), first, 0);
    await invoke(world, second, grants, 'enqueue', 1);
    return invoke(world, second, grants, 'drain', 1);
  }

  if (row === 'M4') {
    const grants = pair('scaffolded', 'simulated');
    assertDenied(await invoke(world, first, grants, 'enqueue', 1), first, 0);
    assertDenied(await invoke(world, first, grants, 'drain', 1), first, 0);
    await invoke(world, second, grants, 'enqueue', 1);
    return invoke(world, second, grants, 'drain', 1);
  }

  if (row === 'M5' || row === 'M6') {
    const grants = pair(row === 'M5' ? 'read-only' : 'retiring', 'simulated');
    assertDenied(await invoke(world, first, grants, 'enqueue', 1), first, 0);
    assertDenied(await invoke(world, first, grants, 'drain', 1), first, 0);
    await invoke(world, second, grants, 'enqueue', 1);
    return invoke(world, second, grants, 'drain', 1);
  }

  if (row === 'M7') {
    const n = pair('simulated', 'simulated');
    await invoke(world, first, n, 'enqueue', 1);
    await invoke(world, second, n, 'enqueue', 1);
    const n1 = pair('disabled', 'simulated');
    const afterFirstDrain = await invoke(world, first, n1, 'drain', 2);
    assertDenied(afterFirstDrain, first, 0);
    const after = await invoke(world, second, n1, 'drain', 2);
    if (tenantCount(after.queuedIntents, first) < 1) {
      throw new HarnessError('QUEUED_INTENT_LOST', first);
    }
    if (tenantCount(after.drainedEffects, first) !== 0) {
      throw new HarnessError('LOWERED_DRAIN_EFFECT', first);
    }
    assertAllowedDrain(after, second);
    return after;
  }

  if (row === 'M8') {
    const isolated = createWorld(workPackage);
    const onlyB = grantsFor(world.capabilityId, 'absent', 'simulated');
    await invoke(isolated, TENANT_B, onlyB, 'enqueue', 1, 'stable-b');
    const before = await invoke(isolated, TENANT_B, onlyB, 'drain', 1, 'stable-b');
    const both = grantsFor(world.capabilityId, 'simulated', 'simulated');
    await invoke(world, TENANT_B, onlyB, 'enqueue', 1, 'stable-b');
    const afterB = await invoke(world, TENANT_B, onlyB, 'drain', 1, 'stable-b');
    if (
      JSON.stringify(before.drainedEffects[TENANT_B]) !==
      JSON.stringify(afterB.drainedEffects[TENANT_B])
    ) {
      throw new HarnessError('NEIGHBOR_DELTA_DRIFT', TENANT_B);
    }
    await invoke(world, TENANT_A, both, 'enqueue', 2, 'op-a');
    return invoke(world, TENANT_A, both, 'drain', 2, 'op-a');
  }

  if (row === 'M9') {
    const grants = pair('simulated', 'disabled');
    const started = Promise.resolve();
    const left = invoke(world, first, grants, 'enqueue', 1, 'same-key');
    const right = started.then(() => invoke(world, first, grants, 'enqueue', 1, 'same-key'));
    await Promise.all([left, right]);
    const drain = await invoke(world, first, grants, 'drain', 1, 'same-key');
    if (tenantCount(drain.queuedIntents, first) !== 1) {
      throw new HarnessError('CONCURRENT_DOUBLE_INTENT', first);
    }
    assertDenied(await invoke(world, second, grants, 'enqueue', 1, 'same-key'), second, 0);
    return drain;
  }

  if (row === 'M10') {
    const grants = pair('disabled', 'active');
    assertDenied(await invoke(world, first, grants, 'enqueue', 1), first, 0);
    await invoke(world, second, grants, 'enqueue', 1);
    const after = await invoke(world, second, grants, 'drain', 1);
    if (after.lastDecision?.grantState !== 'active') {
      throw new HarnessError('ACTIVE_NEIGHBOR_REQUIRED', second);
    }
    return after;
  }

  if (row === 'M11') {
    const grants = pair('shadow', 'simulated');
    await invoke(world, first, grants, 'enqueue', 1);
    const afterFirst = await invoke(world, first, grants, 'drain', 1);
    if (tenantCount(afterFirst.drainedEffects, first) !== 0) {
      throw new HarnessError('SHADOW_DRAINED', first);
    }
    await invoke(world, second, grants, 'enqueue', 1);
    return invoke(world, second, grants, 'drain', 1);
  }

  if (row === 'M13') {
    const grants = pair('simulated', 'simulated');
    await invoke(world, first, grants, 'enqueue', 1, 'req-1', 'hash-1');
    const replay = await invoke(world, first, grants, 'enqueue', 1, 'req-1', 'hash-1');
    if (tenantCount(replay.queuedIntents, first) !== 1) {
      throw new HarnessError('REPLAY_NEW_INTENT', first);
    }
    try {
      await invoke(world, first, grants, 'enqueue', 1, 'req-1', 'hash-2');
      throw new HarnessError('CHANGED_PAYLOAD_ACCEPTED', first);
    } catch (error) {
      if (!(error instanceof HarnessError) || error.code !== 'IDEMPOTENCY_CONFLICT') {
        throw error;
      }
    }
    await invoke(world, second, grants, 'enqueue', 1, 'req-1', 'hash-1');
    const after = await invoke(world, second, grants, 'drain', 1, 'req-1', 'hash-1');
    if (tenantCount(after.queuedIntents, second) < 1) {
      throw new HarnessError('NEIGHBOR_REQUEST_FAILED', second);
    }
    return after;
  }

  if (row === 'M14') {
    const n = pair('simulated', 'simulated');
    await invoke(world, first, n, 'enqueue', 1);
    const lowered = pair('disabled', 'simulated');
    const after = await invoke(world, first, lowered, 'drain', 2);
    if (after.lastDecision?.registryVersion !== 2 || after.lastDecision.allowed !== false) {
      throw new HarnessError('STALE_ALLOW', first);
    }
    return after;
  }

  throw new HarnessError('UNSUPPORTED_MATRIX_ROW', row);
}

export function readinessReport(
  bindings: readonly { readonly parity: BindingParity; readonly workPackage: WorkPackageLoop }[],
): void {
  for (const binding of bindings) {
    if (binding.parity !== 'real-consumer') {
      throw new HarnessError('AGGREGATE_NOT_READY', `${binding.workPackage}:${binding.parity}`);
    }
  }
}

export function assertNotRealParity(parity: BindingParity): void {
  if (parity === 'real-consumer') {
    throw new HarnessError('FALSE_REAL_PARITY', parity);
  }
}

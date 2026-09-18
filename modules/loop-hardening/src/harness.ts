import { createHash } from 'node:crypto';

import {
  SimProcessKill,
  VendorSimEngine,
  type RailResponse,
  type SimEffectRecord,
  type SimReceipt,
} from '@practicehub/vendor-sim-kit';
import { athenaClinicalV1DoubleRail, ClinicalLoopV1Binding } from './bindings/clinical-loop-v1.js';
import { CommsLoopBinding } from './bindings/comms-loop.js';
import { PaidServiceLoopBinding } from './bindings/paid-service-loop.js';
import {
  invariantManifest,
  loopManifest,
  requireExecution,
  type ExecutionSpec,
  type KillPoint,
  type LoopId,
} from './manifest.js';
import { stripeSim, twilioSim } from '@practicehub/vendor-simulator';

export interface OwnedException {
  readonly ownerRef: string;
  readonly dueAt: string;
  readonly reason: string;
  readonly evidenceRef: string;
}

export interface ProductObservation {
  readonly state: string;
  readonly transitionCount: number;
  readonly evidenceRefs: readonly string[];
  readonly ownedException?: OwnedException;
  readonly correlationExact: boolean;
  readonly terminalRegression: boolean;
  readonly consentChecked?: boolean;
  readonly recoveryAttempts: number;
  readonly receiptIngressCount: number;
}

export interface LoopBinding {
  dispatch(): Promise<void>;
  recover(killPoint: KillPoint): Promise<void>;
  settle(): Promise<void>;
  productObservation(): ProductObservation;
  railResponses(): readonly RailResponse[];
  receipts(): readonly SimReceipt[];
}

export interface InvariantResult {
  readonly invariantId: keyof typeof invariantManifest;
  readonly disposition: string;
  readonly passed: boolean;
}

export interface HarnessResult {
  readonly execution: ExecutionSpec;
  readonly applicationKey: string;
  readonly effects: readonly SimEffectRecord[];
  readonly railResponses: readonly RailResponse[];
  readonly receipts: readonly SimReceipt[];
  readonly product: ProductObservation;
  readonly heartbeat: {
    readonly alarmed: boolean;
    readonly reasons: readonly string[];
    readonly deadMonitorReasons: readonly string[];
    readonly ownerRef: string;
    readonly dueAt: string;
  };
  readonly invariants: readonly InvariantResult[];
  readonly killedAt: KillPoint | null;
  readonly synthetic: true;
}

export function stableApplicationKey(input: {
  readonly loopId: LoopId;
  readonly tenantId: string;
  readonly logicalItemId: string;
  readonly operation: string;
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([input.loopId, input.tenantId, input.logicalItemId, input.operation]))
    .digest('hex');
  return `wp033-${digest}`;
}

export function assertStableApplicationKey(
  actual: string,
  input: Parameters<typeof stableApplicationKey>[0],
): void {
  if (actual !== stableApplicationKey(input)) throw new Error('WP033_STABLE_KEY_GUARD');
}

function createBinding(
  loopId: LoopId,
  engine: VendorSimEngine,
  applicationKey: string,
): LoopBinding {
  switch (loopId) {
    case '4A-comms-v1':
      return new CommsLoopBinding(engine, applicationKey);
    case '4B-paid-service-v1':
      return new PaidServiceLoopBinding(engine, applicationKey);
    case '4C-clinical-v1-double':
      return new ClinicalLoopV1Binding(engine, applicationKey);
    default: {
      const unreachable: never = loopId;
      throw new Error(`UNKNOWN_WP033_LOOP:${String(unreachable)}`);
    }
  }
}

function railsFor(loopId: LoopId) {
  switch (loopId) {
    case '4A-comms-v1':
      return [twilioSim];
    case '4B-paid-service-v1':
      return [stripeSim];
    case '4C-clinical-v1-double':
      return [athenaClinicalV1DoubleRail];
    default: {
      const unreachable: never = loopId;
      throw new Error(`UNKNOWN_WP033_LOOP:${String(unreachable)}`);
    }
  }
}

export async function runLoopHardeningExecution(executionId: string): Promise<HarnessResult> {
  const execution = requireExecution(executionId);
  const declaration = loopManifest[execution.loopId];
  const identity = {
    loopId: execution.loopId,
    tenantId: 'northwind-synthetic',
    logicalItemId: 'wp033-item-1',
    operation: declaration.operation,
  } as const;
  const applicationKey = stableApplicationKey(identity);
  assertStableApplicationKey(applicationKey, identity);

  const engine = new VendorSimEngine({ rails: railsFor(execution.loopId) });
  engine.controller.armScenario({
    railId: declaration.railId,
    primitiveId: execution.primitiveId,
    dataPolicy: 'synthetic-only',
    ...(execution.killPoint === undefined ? {} : { options: { killPoint: execution.killPoint } }),
  });
  const binding = createBinding(execution.loopId, engine, applicationKey);
  let killedAt: KillPoint | null = null;
  try {
    await binding.dispatch();
  } catch (error) {
    if (!(error instanceof SimProcessKill) || execution.primitiveId !== 'X-02') throw error;
    killedAt = error.killPoint;
    await binding.recover(error.killPoint);
  }
  await binding.settle();

  engine.recordHeartbeat(declaration.railId, '2026-09-12T15:01:00.000Z');
  const heartbeat = engine.heartbeatSweep().find((entry) => entry.railId === declaration.railId);
  if (heartbeat === undefined) throw new Error('WP033_HEARTBEAT_PROOF_MISSING');
  const deadMonitor = engine
    .heartbeatSweep(false)
    .find((entry) => entry.railId === declaration.railId);
  if (deadMonitor === undefined || !deadMonitor.reasons.includes('reconciliation-did-not-run')) {
    throw new Error('WP033_DEAD_MONITOR_PROOF_MISSING');
  }

  const effects = engine.snapshot().effects;
  if (effects.length > 1) throw new Error('WP033_DUPLICATE_EXTERNAL_EFFECT');
  if (effects.some((effect) => effect.synthetic !== true))
    throw new Error('WP033_NON_SYNTHETIC_EFFECT');
  if (binding.railResponses().some((response) => response.resendsExternalEffect !== false)) {
    throw new Error('WP033_BLIND_RESEND');
  }
  const product = binding.productObservation();
  if (product.terminalRegression) throw new Error('WP033_TERMINAL_REGRESSION');
  if (!product.correlationExact) throw new Error('WP033_CORRELATION_FAILURE');
  if (product.evidenceRefs.length === 0 && product.ownedException === undefined) {
    throw new Error('WP033_SILENT_LOSS');
  }
  if (product.transitionCount > 1) throw new Error('WP033_DUPLICATE_PRODUCT_TRANSITION');

  const receipts = binding.receipts();
  assertPrimitiveEvidence(execution, effects, receipts, binding.railResponses(), killedAt);
  const invariants = evaluateInvariants(
    execution,
    product,
    effects,
    heartbeat.verdict === 'alarm',
    deadMonitor.reasons,
    killedAt,
  );
  if (invariants.some((entry) => !entry.passed)) throw new Error('WP033_INVARIANT_FAILURE');

  return {
    execution,
    applicationKey,
    effects,
    railResponses: binding.railResponses(),
    receipts,
    product,
    heartbeat: {
      alarmed: heartbeat.verdict === 'alarm',
      reasons: heartbeat.reasons,
      deadMonitorReasons: deadMonitor.reasons,
      ownerRef: 'synthetic-staff:platform-ops-1',
      dueAt: '2026-09-12T15:15:00.000Z',
    },
    invariants,
    killedAt,
    synthetic: true,
  };
}

export async function runLoopHardeningHappyPath(loopId: LoopId): Promise<HarnessResult> {
  const declaration = loopManifest[loopId];
  const identity = {
    loopId,
    tenantId: 'northwind-synthetic',
    logicalItemId: 'wp033-item-1',
    operation: declaration.operation,
  } as const;
  const applicationKey = stableApplicationKey(identity);
  assertStableApplicationKey(applicationKey, identity);
  const engine = new VendorSimEngine({ rails: railsFor(loopId) });
  const binding = createBinding(loopId, engine, applicationKey);
  await binding.dispatch();
  await binding.settle();
  engine.recordHeartbeat(declaration.railId, '2026-09-12T15:01:00.000Z');
  const heartbeat = engine.heartbeatSweep().find((entry) => entry.railId === declaration.railId);
  if (heartbeat === undefined) throw new Error('WP033_HEARTBEAT_PROOF_MISSING');
  const deadMonitor = engine
    .heartbeatSweep(false)
    .find((entry) => entry.railId === declaration.railId);
  if (deadMonitor === undefined || !deadMonitor.reasons.includes('reconciliation-did-not-run')) {
    throw new Error('WP033_DEAD_MONITOR_PROOF_MISSING');
  }
  const effects = engine.snapshot().effects;
  if (effects.length !== 1) throw new Error('WP033_HAPPY_ONE_EFFECT_REQUIRED');
  if (effects.some((effect) => effect.synthetic !== true || effect.state !== 'landed')) {
    throw new Error('WP033_HAPPY_LANDED_SYNTHETIC_REQUIRED');
  }
  if (binding.railResponses().some((response) => response.resendsExternalEffect !== false)) {
    throw new Error('WP033_BLIND_RESEND');
  }
  const product = binding.productObservation();
  if (product.terminalRegression) throw new Error('WP033_TERMINAL_REGRESSION');
  if (!product.correlationExact) throw new Error('WP033_CORRELATION_FAILURE');
  if (product.evidenceRefs.length === 0) throw new Error('WP033_SILENT_LOSS');
  if (product.transitionCount !== 1) throw new Error('WP033_HAPPY_ONE_TRANSITION_REQUIRED');
  const happyExecution: ExecutionSpec = {
    executionId: `${loopId}:HAPPY-first-attempt`,
    loopId,
    primitiveId: 'X-03',
  };
  const invariants = evaluateInvariants(
    happyExecution,
    product,
    effects,
    heartbeat.verdict === 'alarm',
    deadMonitor.reasons,
    null,
  );
  if (invariants.some((entry) => !entry.passed)) throw new Error('WP033_INVARIANT_FAILURE');
  return {
    execution: happyExecution,
    applicationKey,
    effects,
    railResponses: binding.railResponses(),
    receipts: binding.receipts(),
    product,
    heartbeat: {
      alarmed: heartbeat.verdict === 'alarm',
      reasons: heartbeat.reasons,
      deadMonitorReasons: deadMonitor.reasons,
      ownerRef: 'synthetic-staff:platform-ops-1',
      dueAt: '2026-09-12T15:15:00.000Z',
    },
    invariants,
    killedAt: null,
    synthetic: true,
  };
}

function assertPrimitiveEvidence(
  execution: ExecutionSpec,
  effects: readonly SimEffectRecord[],
  receipts: readonly SimReceipt[],
  responses: readonly RailResponse[],
  killedAt: KillPoint | null,
): void {
  const effect = effects[0];
  switch (execution.primitiveId) {
    case 'X-02':
      if (killedAt !== execution.killPoint) throw new Error('WP033_X02_KILL_POINT_MISSING');
      if (execution.killPoint === 'after-effect-before-receipt') {
        if (effect?.state !== 'unknown' || effect.attempts !== 1 || receipts.length !== 0) {
          throw new Error('WP033_X02_UNKNOWN_RECOVERY_PROOF');
        }
      }
      if (execution.killPoint === 'after-receipt') {
        if (
          effect === undefined ||
          effect.attempts < 1 ||
          effect.attempts > 2 ||
          receipts.length !== 1
        ) {
          throw new Error('WP033_X02_POST_RECEIPT_REPLAY_PROOF');
        }
      }
      return;
    case 'X-03':
      if (effect?.attempts !== 2 || receipts.length !== 1) {
        throw new Error('WP033_X03_ENGINE_REPLAY_PROOF');
      }
      return;
    case 'X-04':
      if (
        responses[0]?.injectedPrimitiveId !== 'X-04' ||
        receipts.length !== 2 ||
        receipts[0]?.kind !== 'primary' ||
        receipts[1]?.kind !== 'duplicate'
      ) {
        throw new Error('WP033_X04_DUPLICATE_RECEIPT_PROOF');
      }
      return;
    case 'X-07':
      if (
        responses[0]?.injectedPrimitiveId !== 'X-07' ||
        receipts.length !== 2 ||
        receipts[0]?.sequence !== 2 ||
        receipts[1]?.sequence !== 1
      ) {
        throw new Error('WP033_X07_ORDER_PROOF');
      }
      return;
    default: {
      const unreachable: never = execution.primitiveId;
      throw new Error(`UNKNOWN_WP033_PRIMITIVE:${String(unreachable)}`);
    }
  }
}

function evaluateInvariants(
  execution: ExecutionSpec,
  product: ProductObservation,
  effects: readonly SimEffectRecord[],
  heartbeatAlarmed: boolean,
  deadMonitorReasons: readonly string[],
  killedAt: KillPoint | null,
): readonly InvariantResult[] {
  const evidenceOrException =
    product.evidenceRefs.length > 0 || product.ownedException !== undefined;
  const effect = effects[0];
  const honestUnknown =
    effect?.state !== 'unknown' ||
    (['unknown', 'reconciliation_held'] as readonly string[]).includes(product.state);
  const crashSafe =
    execution.primitiveId !== 'X-02' ||
    (killedAt === execution.killPoint &&
      (execution.killPoint !== 'after-effect-before-receipt' ||
        (honestUnknown && product.ownedException !== undefined)));
  const receiptIngressRequired =
    execution.primitiveId === 'X-04' || execution.primitiveId === 'X-07';
  const receiptIngressProven = !receiptIngressRequired || product.receiptIngressCount === 2;
  return [
    { invariantId: 'I-A', disposition: invariantManifest['I-A'], passed: evidenceOrException },
    {
      invariantId: 'I-B',
      disposition: invariantManifest['I-B'],
      passed: effects.length <= 1 && product.transitionCount <= 1 && receiptIngressProven,
    },
    {
      invariantId: 'I-C',
      disposition: invariantManifest['I-C'],
      passed: product.consentChecked ?? true,
    },
    {
      invariantId: 'I-D',
      disposition: invariantManifest['I-D'],
      passed: effects.every((entry) => entry.synthetic),
    },
    {
      invariantId: 'I-E',
      disposition: invariantManifest['I-E'],
      passed: product.recoveryAttempts <= 2 && evidenceOrException,
    },
    { invariantId: 'I-F', disposition: invariantManifest['I-F'], passed: evidenceOrException },
    {
      invariantId: 'I-G',
      disposition: invariantManifest['I-G'],
      passed: !product.terminalRegression && honestUnknown,
    },
    { invariantId: 'I-H', disposition: invariantManifest['I-H'], passed: crashSafe },
    {
      invariantId: 'I-I',
      disposition: invariantManifest['I-I'],
      passed: heartbeatAlarmed && deadMonitorReasons.includes('reconciliation-did-not-run'),
    },
  ];
}

/**
 * The dispatcher (WP-027) — the whole framework in one function.
 * Contract: docs/contracts/vendor-sim-scenario-api.md (FROZEN) §2/§6.
 *
 * Resolution order is the contract, and it is LEDGER-FIRST:
 *
 *   1. a `landed` record answers with the SAME receipt (`duplicateOf`), one more
 *      attempt, and no second external effect;
 *   2. an `unknown` or `partial` record answers `uncertain` and demands
 *      reconciliation — a blind resend has no code path;
 *   3. only then does the armed primitive shape the response.
 *
 * Because the ledger runs first, no injection can manufacture a duplicate
 * external effect: the primitives shape RECEIPTS and AVAILABILITY, never the
 * one-effect-per-idempotency-key rule.
 */

import { requireSyntheticInput } from '@practicehub/platform';
import type {
  RailScenarioOptions,
  RailSimulatorKillPoint,
} from '@practicehub/platform-integration';

import {
  assertRailHeartbeatModel,
  sweepRailHeartbeats,
  type RailHeartbeatEvaluation,
  type RailWindowObservation,
} from './heartbeat.js';
import type { InjectionPrimitive } from './primitives.js';
import { ScenarioController } from './scenario.js';
import {
  RailSimError,
  SimProcessKill,
  type RailRequest,
  type RailResponse,
  type RailResponseStatus,
  type RailSim,
} from './rail.js';
import {
  hashPayload,
  simRefPattern,
  InMemorySimStateStore,
  type SimEffectRecord,
  type SimEffectState,
  type SimHeartbeat,
  type SimReceipt,
  type SimReceiptKind,
  type SimStateSnapshot,
  type SimStateStore,
} from './store.js';

interface ReceiptPlan {
  readonly kind: SimReceiptKind;
  readonly sequence: number;
  readonly fenceCrossed?: boolean;
}

interface PrimitivePlan {
  readonly status: RailResponseStatus;
  readonly effectState: SimEffectState;
  /** Whether the response carries the receipt ref (a gap lands without one). */
  readonly issuesReceipt: boolean;
  readonly receipts: readonly ReceiptPlan[];
  readonly requiresReconciliation: boolean;
  /** Emitted receipts are drained in reverse order (the out-of-order shape). */
  readonly reverseDrainOrder?: boolean;
  readonly killPoint?: RailSimulatorKillPoint;
  readonly replayImmediately?: boolean;
  readonly versionDrift?: boolean;
}

const primaryOnly: readonly ReceiptPlan[] = [{ kind: 'primary', sequence: 1 }];

const landedPlan: PrimitivePlan = {
  status: 'accepted',
  effectState: 'landed',
  issuesReceipt: true,
  receipts: primaryOnly,
  requiresReconciliation: false,
};

function failedPlan(status: RailResponseStatus): PrimitivePlan {
  return {
    status,
    effectState: 'not-landed',
    issuesReceipt: false,
    receipts: [],
    requiresReconciliation: false,
  };
}

/**
 * The per-primitive plan. Every branch is total (the catalog is a closed
 * vocabulary and the default THROWS), so a primitive added to the catalog
 * without a dispatcher branch fails loudly instead of silently behaving like a
 * clean send — the review-009 discipline applied to the injection engine.
 */
function planForPrimitive(primitive: InjectionPrimitive): PrimitivePlan {
  switch (primitive.primitiveId) {
    case 'X-01':
      return landedPlan;
    case 'X-02':
      return { ...landedPlan, killPoint: 'after-effect-before-receipt' };
    case 'X-03':
      return { ...landedPlan, replayImmediately: true };
    case 'X-04':
      return {
        ...landedPlan,
        receipts: [
          { kind: 'primary', sequence: 1 },
          { kind: 'duplicate', sequence: 2 },
        ],
      };
    case 'X-05':
      return {
        status: 'uncertain',
        effectState: 'unknown',
        issuesReceipt: false,
        receipts: [],
        requiresReconciliation: true,
      };
    case 'X-06':
      return {
        status: 'accepted',
        effectState: 'landed',
        issuesReceipt: false,
        receipts: [],
        requiresReconciliation: true,
      };
    case 'X-07':
      return {
        ...landedPlan,
        receipts: [
          { kind: 'primary', sequence: 1 },
          { kind: 'late', sequence: 2, fenceCrossed: true },
        ],
        reverseDrainOrder: true,
      };
    case 'X-08':
      return {
        ...landedPlan,
        receipts: [{ kind: 'late', sequence: 1, fenceCrossed: true }],
        requiresReconciliation: true,
      };
    case 'X-09':
      return {
        ...landedPlan,
        receipts: [
          { kind: 'primary', sequence: 1 },
          { kind: 'corrected', sequence: 2 },
        ],
        requiresReconciliation: true,
      };
    case 'X-10':
      return {
        ...landedPlan,
        receipts: [
          { kind: 'primary', sequence: 1 },
          { kind: 'reversal', sequence: 2 },
        ],
        requiresReconciliation: true,
      };
    case 'X-11':
      return {
        status: 'accepted',
        effectState: 'partial',
        issuesReceipt: true,
        receipts: [{ kind: 'partial', sequence: 1 }],
        requiresReconciliation: true,
      };
    case 'X-12':
      return failedPlan('rejected');
    case 'X-13':
      return failedPlan('throttled');
    case 'X-14':
      return failedPlan('unauthorized');
    case 'X-15':
      return failedPlan('conflict');
    case 'X-16':
      return failedPlan('unavailable');
    case 'X-17':
      return {
        status: 'malformed',
        effectState: 'unknown',
        issuesReceipt: false,
        receipts: [],
        requiresReconciliation: true,
      };
    case 'X-18':
      return { ...landedPlan, requiresReconciliation: true, versionDrift: true };
    default:
      throw new RailSimError(
        `injection primitive ${primitive.primitiveId} has no dispatcher plan — the catalog and the engine disagree`,
      );
  }
}

export interface VendorSimEngineOptions {
  readonly rails: readonly RailSim[];
  readonly store?: SimStateStore;
  readonly controller?: ScenarioController;
  readonly dataPolicy?: string;
}

export class VendorSimEngine {
  public readonly store: SimStateStore;
  public readonly controller: ScenarioController;
  public readonly dataPolicy: string;
  private readonly railsById: Map<string, RailSim>;

  public constructor(options: VendorSimEngineOptions) {
    this.railsById = new Map(options.rails.map((rail) => [rail.railId, rail] as const));
    if (this.railsById.size !== options.rails.length) {
      throw new RailSimError('two rails declare the same railId');
    }
    // A rail whose declared band could contain zero would make silence quiet:
    // refused HERE, so no engine can ever be built around one.
    for (const rail of options.rails) {
      assertRailHeartbeatModel(rail.railId, rail.heartbeat);
    }
    this.store = options.store ?? new InMemorySimStateStore();
    this.controller = options.controller ?? new ScenarioController();
    this.dataPolicy = options.dataPolicy ?? 'synthetic-only';
  }

  public rails(): readonly RailSim[] {
    return [...this.railsById.values()].sort((left, right) =>
      left.railId.localeCompare(right.railId),
    );
  }

  public rail(railId: string): RailSim {
    const rail = this.railsById.get(railId);
    if (!rail) {
      throw new RailSimError(`unknown rail ${JSON.stringify(railId)}`);
    }
    return rail;
  }

  public drainReceipts(railId: string): readonly SimReceipt[] {
    this.rail(railId);
    return this.store.drainReceipts(railId);
  }

  public snapshot(): SimStateSnapshot {
    return this.store.snapshot();
  }

  /**
   * Record one idle liveness tick. The sim owns no clock (§3 of the WP-027
   * contract), so the caller supplies the instant and the sweep stays
   * reproducible.
   */
  public recordHeartbeat(railId: string, recordedAt: string): SimHeartbeat {
    this.rail(railId);
    return this.store.recordHeartbeat(railId, recordedAt);
  }

  /**
   * Derive one rail's window observation FROM THE LEDGER: an effect counts as
   * carried only when something actually landed (`landed` or `partial`). An
   * `unknown` outcome deliberately does not count — uncertainty reads as loss,
   * which is the fail-closed direction.
   */
  public observeWindow(railId: string, reconciliationRan = true): RailWindowObservation {
    this.rail(railId);
    const carried = (record: SimEffectRecord): boolean =>
      record.railId === railId && (record.state === 'landed' || record.state === 'partial');
    return {
      railId,
      observedEffects: this.store.listEffects().filter(carried).length,
      observedHeartbeats: this.store
        .listHeartbeats()
        .filter((heartbeat) => heartbeat.railId === railId).length,
      reconciliationRan,
    };
  }

  /** Every declared rail, judged against its own band. No rail is ever skipped. */
  public heartbeatSweep(reconciliationRan = true): readonly RailHeartbeatEvaluation[] {
    const rails = this.rails();
    return sweepRailHeartbeats(
      rails,
      rails.map((rail) => this.observeWindow(rail.railId, reconciliationRan)),
    );
  }

  /** Rollback: disarm every scenario and clear the ledger (the `sim reset` expectation). */
  public reset(): void {
    this.controller.disarmAll();
    this.store.reset();
  }

  public dispatch(request: RailRequest): RailResponse {
    requireSyntheticInput(request);
    const rail = this.rail(request.railId);
    if (!rail.operations.includes(request.operation)) {
      throw new RailSimError(
        `rail ${rail.railId} does not declare operation ${JSON.stringify(request.operation)}`,
      );
    }
    for (const [label, value] of [
      ['idempotencyKey', request.idempotencyKey],
      ['payloadRef', request.payloadRef],
    ] as const) {
      if (!simRefPattern.test(value)) {
        throw new RailSimError(`${label} ${JSON.stringify(value)} is not ref-grammar`);
      }
    }

    const effectKey = rail.effectKeyFor(request.operation, request);
    const existing = this.store.readEffect(rail.railId, request.idempotencyKey);
    const attempt = (existing?.attempts ?? 0) + 1;

    // (1)/(2) — the ledger decides before any injection can.
    if (existing && existing.state === 'landed') {
      return this.recordReplay(
        rail,
        request,
        existing,
        'deduplicated',
        existing.receiptRef === null,
      );
    }
    if (existing && (existing.state === 'unknown' || existing.state === 'partial')) {
      return this.recordReplay(rail, request, existing, 'uncertain', true);
    }

    // (3) — a fresh key, or a retry of an effect that never landed.
    const injected = this.controller.consume(rail.railId, attempt);
    const plan = injected ? planForPrimitive(injected.primitive) : landedPlan;
    const options: RailScenarioOptions = injected?.options ?? {};
    const killPoint = options.killPoint ?? plan.killPoint;
    const payloadHash = hashPayload(request.payload ?? null);
    const receiptRef = `${effectKey}:r${String(attempt)}`;

    if (plan.killPoint && killPoint === 'before-effect') {
      throw new SimProcessKill(killPoint, rail.railId, request.idempotencyKey);
    }

    // A crash before the receipt leaves the ledger without one: that ABSENCE is
    // what makes the state genuinely unknown on restart.
    const crashesBeforeReceipt = plan.killPoint !== undefined && killPoint !== 'after-receipt';
    const record: SimEffectRecord = {
      railId: rail.railId,
      operation: request.operation,
      effectKey,
      idempotencyKey: request.idempotencyKey,
      payloadHash,
      receiptRef: plan.issuesReceipt && !crashesBeforeReceipt ? receiptRef : null,
      state: plan.killPoint ? this.stateAtKill(killPoint, plan) : plan.effectState,
      attempts: attempt,
      firstSeenAt: existing?.firstSeenAt ?? request.requestedAt,
      lastSeenAt: request.requestedAt,
      synthetic: true,
    };
    this.store.writeEffect(record);

    if (plan.killPoint && killPoint === 'after-effect-before-receipt') {
      throw new SimProcessKill(killPoint, rail.railId, request.idempotencyKey);
    }

    const receipts = plan.receipts.map((receiptPlan) =>
      this.buildReceipt(rail, request, effectKey, receiptRef, receiptPlan),
    );
    if (receipts.length > 0) {
      this.store.appendReceipts(plan.reverseDrainOrder ? [...receipts].reverse() : receipts);
    }

    if (plan.killPoint && killPoint === 'after-receipt') {
      throw new SimProcessKill(killPoint, rail.railId, request.idempotencyKey);
    }

    // The replay primitive re-delivers the SAME request: the second pass runs
    // the ledger branch and proves one effect and one receipt survive a
    // re-delivery (there is no path that sends twice).
    if (plan.replayImmediately) {
      return this.dispatch(request);
    }

    return {
      railId: rail.railId,
      operation: request.operation,
      status: plan.status,
      effectKey,
      idempotencyKey: request.idempotencyKey,
      receiptRef: plan.issuesReceipt ? receiptRef : null,
      duplicateOf: null,
      requiresReconciliation: plan.requiresReconciliation,
      resendsExternalEffect: false,
      injectedPrimitiveId: injected?.primitive.primitiveId ?? null,
      outcomeClass: injected?.primitive.outcomeClass ?? null,
      declaredDelayMs: options.delayMs ?? (injected?.primitive.primitiveId === 'X-01' ? 250 : 0),
      retryAfterSeconds: plan.status === 'throttled' ? (options.retryAfterSeconds ?? 30) : null,
      vendorVersion: plan.versionDrift
        ? `${rail.pinnedVendorVersion}+drift`
        : rail.pinnedVendorVersion,
      attempts: attempt,
      effectState: record.state,
      synthetic: true,
    };
  }

  private stateAtKill(
    killPoint: RailSimulatorKillPoint | undefined,
    plan: PrimitivePlan,
  ): SimEffectState {
    if (killPoint === 'after-receipt') {
      return plan.effectState;
    }
    // Killed between the effect and its receipt: the external state is UNKNOWN,
    // and that is exactly what must survive the death.
    return 'unknown';
  }

  private buildReceipt(
    rail: RailSim,
    request: RailRequest,
    effectKey: string,
    receiptRef: string,
    plan: ReceiptPlan,
  ): SimReceipt {
    const derivedRef =
      plan.kind === 'corrected' || plan.kind === 'reversal'
        ? `${receiptRef}-${plan.kind}`
        : receiptRef;
    return {
      receiptRef: derivedRef,
      railId: rail.railId,
      effectKey,
      idempotencyKey: request.idempotencyKey,
      kind: plan.kind,
      sequence: plan.sequence,
      supersedesRef: plan.kind === 'corrected' ? receiptRef : null,
      reversesRef: plan.kind === 'reversal' ? receiptRef : null,
      fenceCrossed: plan.fenceCrossed ?? false,
      emittedAt: request.requestedAt,
      synthetic: true,
    };
  }

  /**
   * A re-delivery of a key the ledger already holds. One more attempt is
   * recorded; the effect, its state, and its receipt are untouched.
   */
  private recordReplay(
    rail: RailSim,
    request: RailRequest,
    existing: SimEffectRecord,
    status: RailResponseStatus,
    requiresReconciliation: boolean,
  ): RailResponse {
    const attempts = existing.attempts + 1;
    this.store.writeEffect({ ...existing, attempts, lastSeenAt: request.requestedAt });
    return {
      railId: rail.railId,
      operation: request.operation,
      status,
      effectKey: existing.effectKey,
      idempotencyKey: existing.idempotencyKey,
      receiptRef: existing.receiptRef,
      duplicateOf: existing.receiptRef,
      requiresReconciliation,
      resendsExternalEffect: false,
      injectedPrimitiveId: null,
      outcomeClass: null,
      declaredDelayMs: 0,
      retryAfterSeconds: null,
      vendorVersion: rail.pinnedVendorVersion,
      attempts,
      effectState: existing.state,
      synthetic: true,
    };
  }
}

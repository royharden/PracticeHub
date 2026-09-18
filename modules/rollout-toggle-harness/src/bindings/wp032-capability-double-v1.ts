import {
  CapabilityDeniedError,
  defineCommandHandler,
  type CapabilityId,
} from '@practicehub/platform-core';

import {
  HarnessError,
  WP032_DESCRIPTOR_SHA256,
  WP032_LOCAL_CAPABILITY_ID,
  effectIdFor,
  intentHashFor,
  type BindingParity,
  type ClinicalAcknowledgementInput,
  type EffectSnapshot,
  type GateInput,
  type LoopToggleBindingV1,
  type RecorderCategory,
  type RecorderEvent,
  type TenantScopedClinicalProposal,
} from '../contracts.js';
import type { EffectRecorder } from '../effect-recorder.js';

interface BoundRequest {
  readonly tenantId: string;
  readonly requestKey: string;
  readonly subjectRef: string;
  readonly proposalRef: string;
  readonly expectedSourceVersion: string;
  readonly payloadHash: string;
  readonly intentHash: string;
  readonly effectId: string;
  readonly operationId: string;
}

export class Wp032CapabilityDoubleV1
  implements LoopToggleBindingV1<TenantScopedClinicalProposal, TenantScopedClinicalProposal>
{
  public readonly contractVersion = 1 as const;
  public readonly workPackage = 'WP-032' as const;
  public readonly capabilityId: CapabilityId = WP032_LOCAL_CAPABILITY_ID;
  public readonly parity: BindingParity = 'versioned-double';
  public readonly contract = 'practicehub.wp032-capability-double' as const;
  public readonly version = 1 as const;
  public readonly contractHash = WP032_DESCRIPTOR_SHA256;
  public readonly minimumState = 'simulated' as const;

  readonly #bindings = new Map<string, BoundRequest>();
  readonly #recorder: EffectRecorder;
  readonly #acks = new Map<string, ClinicalAcknowledgementInput>();

  public constructor(recorder: EffectRecorder) {
    this.#recorder = recorder;
  }

  public enqueue(
    input: TenantScopedClinicalProposal,
    gate: GateInput,
  ): Promise<EffectSnapshot> {
    return this.#phase(input, gate, 'enqueue');
  }

  public drain(
    input: TenantScopedClinicalProposal,
    gate: GateInput,
  ): Promise<EffectSnapshot> {
    return this.#phase(input, gate, 'drain');
  }

  public reconcileAcknowledgement(
    input: ClinicalAcknowledgementInput,
    gate: GateInput,
  ): EffectSnapshot {
    const bound = this.#bindings.get(`${input.tenantId}::${input.requestKey}`);
    if (bound === undefined || bound.effectId !== input.effectId) {
      throw new HarnessError('FOREIGN_EFFECT_IDENTITY', input.effectId);
    }
    const existing = this.#acks.get(input.receiptId);
    if (existing !== undefined) {
      return this.#recorder.snapshot();
    }
    this.#acks.set(input.receiptId, input);
    this.#recorder.record({
      operationId: bound.operationId,
      effectId: bound.effectId,
      tenantId: input.tenantId,
      category: 'reconciliation',
      checkpoint: 'ack',
      capabilityId: this.capabilityId,
      grantState: gate.grants[0]?.state ?? 'none',
      grantSnapshotVersion: gate.grantSnapshotVersion,
      payload: { outcome: input.outcome, receiptId: input.receiptId },
      synthetic: true,
    });
    return this.#recorder.snapshot();
  }

  async #phase(
    input: TenantScopedClinicalProposal,
    gate: GateInput,
    checkpoint: 'enqueue' | 'drain',
  ): Promise<EffectSnapshot> {
    if (input.synthetic !== true) {
      throw new HarnessError('NON_SYNTHETIC', input.requestKey);
    }
    if (gate.context.tenantId !== input.tenantId) {
      throw new HarnessError('TENANT_CONTEXT_MISMATCH', input.tenantId);
    }
    const bound = checkpoint === 'enqueue' ? this.#bind(input) : this.#requireBound(input);
    const handler = defineCommandHandler({
      capabilityId: this.capabilityId,
      minimumState: 'simulated',
      handle: () => {
        if (checkpoint === 'enqueue') {
          const already = this.#recorder
            .snapshot()
            .queuedIntents[bound.tenantId]?.some((event) => event.operationId === bound.operationId);
          if (already === true) {
            return;
          }
          this.#recorder.record(this.#event(bound, gate, 'queuedIntent', 'enqueue'));
          return;
        }
        const grant = gate.grants.find((candidate) => candidate.tenantId === bound.tenantId);
        if (grant?.state === 'shadow') {
          this.#recorder.record(this.#event(bound, gate, 'sealedOutput', 'drain'));
          return;
        }
        this.#recorder.record(this.#event(bound, gate, 'bodyEntry', 'drain'));
        this.#recorder.record(this.#event(bound, gate, 'adapterCall', 'drain'));
        this.#recorder.record(this.#event(bound, gate, 'clinicalWrite', 'drain'));
        this.#recorder.record(this.#event(bound, gate, 'drainedEffect', 'drain'));
      },
    });
    try {
      const invocation = handler.invoke(gate.registry, gate.grants, gate.context, input, {
        checkpoint,
        registryVersion: gate.grantSnapshotVersion,
      });
      this.#recorder.setDecision(invocation.decision);
      await Promise.resolve(invocation.result);
    } catch (error) {
      if (error instanceof CapabilityDeniedError) {
        this.#recorder.setDecision(error.decision);
        return this.#recorder.snapshot();
      }
      throw error;
    }
    return this.#recorder.snapshot();
  }

  #bind(input: TenantScopedClinicalProposal): BoundRequest {
    const key = `${input.tenantId}::${input.requestKey}`;
    const intentHash = intentHashFor(input);
    const existing = this.#bindings.get(key);
    if (existing !== undefined) {
      if (existing.intentHash !== intentHash) {
        throw new HarnessError('IDEMPOTENCY_CONFLICT', key);
      }
      return existing;
    }
    const effectId = effectIdFor(input.tenantId, input.requestKey, intentHash);
    const bound: BoundRequest = {
      tenantId: input.tenantId,
      requestKey: input.requestKey,
      subjectRef: input.subjectRef,
      proposalRef: input.proposalRef,
      expectedSourceVersion: input.expectedSourceVersion,
      payloadHash: input.payloadHash,
      intentHash,
      effectId,
      operationId: `${input.tenantId}:${input.requestKey}`,
    };
    this.#bindings.set(key, bound);
    return bound;
  }

  #requireBound(input: TenantScopedClinicalProposal): BoundRequest {
    const existing = this.#bindings.get(`${input.tenantId}::${input.requestKey}`);
    if (existing === undefined) {
      throw new HarnessError('UNBOUND_REQUEST', input.requestKey);
    }
    if (existing.intentHash !== intentHashFor(input)) {
      throw new HarnessError('IDEMPOTENCY_CONFLICT', input.requestKey);
    }
    return existing;
  }

  #event(
    bound: BoundRequest,
    gate: GateInput,
    category: RecorderCategory,
    checkpoint: 'enqueue' | 'drain',
  ): RecorderEvent {
    return {
      operationId: bound.operationId,
      effectId: bound.effectId,
      tenantId: bound.tenantId,
      category,
      checkpoint,
      capabilityId: this.capabilityId,
      grantState: gate.grants.find((grant) => grant.tenantId === bound.tenantId)?.state ?? 'none',
      grantSnapshotVersion: gate.grantSnapshotVersion,
      payload: {
        requestKey: bound.requestKey,
        intentHash: bound.intentHash,
        subjectRef: bound.subjectRef,
      },
      synthetic: true,
    };
  }
}

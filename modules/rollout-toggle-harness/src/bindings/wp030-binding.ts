import {
  CapabilityDeniedError,
  defineCommandHandler,
  type CapabilityId,
} from '@practicehub/platform-core';

import {
  HarnessError,
  WP030_LOCAL_CAPABILITY_ID,
  type BindingParity,
  type EffectSnapshot,
  type GateInput,
  type LoopToggleBindingV1,
  type RecorderCategory,
  type RecorderEvent,
  type TenantScopedLoopInput,
} from '../contracts.js';
import type { EffectRecorder } from '../effect-recorder.js';

export class Wp030LocalDouble
  implements LoopToggleBindingV1<TenantScopedLoopInput, TenantScopedLoopInput>
{
  public readonly contractVersion = 1 as const;
  public readonly workPackage = 'WP-030' as const;
  public readonly capabilityId: CapabilityId = WP030_LOCAL_CAPABILITY_ID;
  public readonly parity: BindingParity = 'versioned-double';
  readonly #recorder: EffectRecorder;
  readonly #queued = new Map<string, string>();

  public constructor(recorder: EffectRecorder) {
    this.#recorder = recorder;
  }

  public enqueue(input: TenantScopedLoopInput, gate: GateInput): Promise<EffectSnapshot> {
    return this.#phase(input, gate, 'enqueue');
  }

  public drain(input: TenantScopedLoopInput, gate: GateInput): Promise<EffectSnapshot> {
    return this.#phase(input, gate, 'drain');
  }

  async #phase(
    input: TenantScopedLoopInput,
    gate: GateInput,
    checkpoint: 'enqueue' | 'drain',
  ): Promise<EffectSnapshot> {
    if (input.synthetic !== true) {
      throw new HarnessError('NON_SYNTHETIC', input.requestKey);
    }
    if (gate.context.tenantId !== input.tenantId) {
      throw new HarnessError('TENANT_CONTEXT_MISMATCH', input.tenantId);
    }
    this.#recorder.assertExclusiveKey(input.tenantId, `${input.tenantId}:${input.requestKey}`);
    const operationId = `${input.tenantId}:${input.requestKey}`;
    const effectId = `${operationId}:wp030`;
    const handler = defineCommandHandler({
      capabilityId: this.capabilityId,
      minimumState: 'simulated',
      handle: () => {
        if (checkpoint === 'enqueue') {
          const prior = this.#queued.get(operationId);
          if (prior !== undefined) {
            if (prior !== input.payloadHash) {
              throw new HarnessError('IDEMPOTENCY_CONFLICT', operationId);
            }
            return;
          }
          this.#queued.set(operationId, input.payloadHash);
          this.#record(input, gate, effectId, 'queuedIntent', 'enqueue');
          this.#record(input, gate, effectId, 'messageAppend', 'enqueue');
          return;
        }
        if (!this.#queued.has(operationId)) {
          throw new HarnessError('UNBOUND_REQUEST', operationId);
        }
        const grant = gate.grants.find((candidate) => candidate.tenantId === input.tenantId);
        if (grant?.state === 'shadow') {
          this.#record(input, gate, effectId, 'sealedOutput', 'drain');
          return;
        }
        this.#record(input, gate, effectId, 'bodyEntry', 'drain');
        this.#record(input, gate, effectId, 'adapterCall', 'drain');
        this.#record(input, gate, effectId, 'drainedEffect', 'drain');
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

  #record(
    input: TenantScopedLoopInput,
    gate: GateInput,
    effectId: string,
    category: RecorderCategory,
    checkpoint: 'enqueue' | 'drain',
  ): void {
    const event: RecorderEvent = {
      operationId: `${input.tenantId}:${input.requestKey}`,
      effectId,
      tenantId: input.tenantId,
      category,
      checkpoint,
      capabilityId: this.capabilityId,
      grantState: gate.grants.find((grant) => grant.tenantId === input.tenantId)?.state ?? 'none',
      grantSnapshotVersion: gate.grantSnapshotVersion,
      payload: { requestKey: input.requestKey, payloadHash: input.payloadHash },
      synthetic: true,
    };
    this.#recorder.record(event);
  }
}

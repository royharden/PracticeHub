import { createHash } from 'node:crypto';

import type {
  PaymentRailInput,
  PaymentRailPort,
  RailEffectObservation,
} from '@practicehub/payments-ledger';
import type { RailResponse, VendorSimEngine } from '@practicehub/vendor-sim-kit';

/** In-process PaymentRailPort binding for the canonical RAIL-008 simulator declaration. */
export class Rail008PaymentAdapter implements PaymentRailPort {
  public constructor(private readonly engine: VendorSimEngine) {
    if (
      !engine.rails().some((rail) => rail.railId === 'RAIL-008' && rail.authorityId === 'AUTH-006')
    ) {
      throw new Error('RAIL008_AUTH006_BINDING_REQUIRED');
    }
  }

  public createPaymentIntent(input: PaymentRailInput): Promise<RailEffectObservation> {
    return Promise.resolve(this.dispatch('create-payment-intent', input));
  }

  public refund(input: PaymentRailInput): Promise<RailEffectObservation> {
    return Promise.resolve(this.dispatch('refund', input));
  }

  public async reconcileEffect(input: {
    readonly tenantId: string;
    readonly effectRef: string;
    readonly idempotencyKey: string;
    readonly synthetic: boolean;
  }): Promise<RailEffectObservation> {
    if (input.synthetic !== true) throw new Error('SYNTHETIC_RAIL_REQUIRED');
    const effect = this.engine.store
      .listEffects()
      .find((entry) => entry.effectKey === input.effectRef);
    if (effect === undefined) throw new Error('RAIL_EFFECT_NOT_FOUND');
    if (!effect.idempotencyKey.startsWith(`${tenantFence(input.tenantId)}:`)) {
      throw new Error('RAIL_EFFECT_TENANT_MISMATCH');
    }
    return {
      effectRef: effect.effectKey,
      outcome:
        effect.state === 'landed'
          ? 'landed'
          : effect.state === 'not-landed'
            ? 'not_landed'
            : 'unknown',
      ...(effect.receiptRef === null ? {} : { receiptRef: effect.receiptRef }),
      observedAt: effect.lastSeenAt,
    };
  }

  private dispatch(
    operation: 'create-payment-intent' | 'refund',
    input: PaymentRailInput,
  ): RailEffectObservation {
    return observation(
      this.engine.dispatch({
        railId: 'RAIL-008',
        operation,
        idempotencyKey: `${tenantFence(input.tenantId)}:${createHash('sha256')
          .update(JSON.stringify([input.tenantId, input.idempotencyKey]))
          .digest('hex')}`,
        payloadRef: `paid-service/${input.tenantId}/${operation}`,
        requestedAt: '2026-04-01T12:00:00Z',
        payload: input,
        synthetic: true,
      }),
    );
  }
}

const tenantFence = (tenantId: string): string =>
  createHash('sha256').update(tenantId).digest('hex').slice(0, 16);

function observation(response: RailResponse): RailEffectObservation {
  return {
    effectRef: response.effectKey,
    outcome:
      response.effectState === 'landed'
        ? 'landed'
        : response.effectState === 'not-landed'
          ? 'not_landed'
          : 'unknown',
    ...(response.receiptRef === null ? {} : { receiptRef: response.receiptRef }),
    observedAt: '2026-04-01T12:00:00Z',
  };
}

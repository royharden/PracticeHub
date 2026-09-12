import type { PaymentRailInput } from '@practicehub/payments-ledger';
import { VendorSimEngine } from '@practicehub/vendor-sim-kit';
import { stripeSim } from '@practicehub/vendor-simulator';
import { describe, expect, it } from 'vitest';

import { Rail008PaymentAdapter } from './rail008-payment-adapter.js';

const payment = (idempotencyKey: string): PaymentRailInput => ({
  tenantId: 'northwind-synthetic',
  processorAccountRef: 'processor-synthetic',
  money: { amountMinor: 100, currency: 'USD' },
  opaqueProcessorSkuRef: 'sku-opaque',
  idempotencyKey,
  synthetic: true,
});

describe('RAIL-008 / AUTH-006 PaymentRailPort parity', () => {
  it('deduplicates a clean payment and refund to one effect per stable key', async () => {
    const engine = new VendorSimEngine({ rails: [stripeSim] });
    const adapter = new Rail008PaymentAdapter(engine);
    const first = await adapter.createPaymentIntent(payment('payment-key-1'));
    expect(await adapter.createPaymentIntent(payment('payment-key-1'))).toMatchObject({
      effectRef: first.effectRef,
      receiptRef: first.receiptRef,
    });
    await adapter.refund({
      tenantId: 'northwind-synthetic',
      processorAccountRef: 'processor-synthetic',
      money: { amountMinor: 100, currency: 'USD' },
      idempotencyKey: 'refund-key-1',
      synthetic: true,
      originalEffectRef: first.effectRef,
    });
    expect(engine.snapshot().effects).toHaveLength(2);
  });

  it.each([
    ['X-05', 'unknown'],
    ['X-06', 'landed'],
  ] as const)('contains %s without a blind second effect', async (primitiveId, outcome) => {
    const engine = new VendorSimEngine({ rails: [stripeSim] });
    engine.controller.armScenario({
      railId: 'RAIL-008',
      primitiveId,
      dataPolicy: 'synthetic-only',
    });
    const adapter = new Rail008PaymentAdapter(engine);
    const result = await adapter.createPaymentIntent(
      payment(`payment-${primitiveId.toLowerCase()}`),
    );
    expect(result.outcome).toBe(outcome);
    expect(result.receiptRef).toBeUndefined();
    expect(
      (
        await adapter.reconcileEffect({
          tenantId: 'northwind-synthetic',
          effectRef: result.effectRef,
          idempotencyKey: `reconcile-${primitiveId.toLowerCase()}`,
          synthetic: true,
        })
      ).effectRef,
    ).toBe(result.effectRef);
    expect(engine.snapshot().effects).toHaveLength(1);
  });

  it('tenant-binds outbound identity and refuses cross-tenant reconciliation', async () => {
    const engine = new VendorSimEngine({ rails: [stripeSim] });
    const adapter = new Rail008PaymentAdapter(engine);
    const northwind = await adapter.createPaymentIntent(payment('shared-key'));
    const riverbend = await adapter.createPaymentIntent({
      ...payment('shared-key'),
      tenantId: 'riverbend-synthetic',
    });
    expect(riverbend.effectRef).not.toBe(northwind.effectRef);
    expect(engine.snapshot().effects).toHaveLength(2);
    await expect(
      adapter.reconcileEffect({
        tenantId: 'riverbend-synthetic',
        effectRef: northwind.effectRef,
        idempotencyKey: 'cross-tenant-reconcile',
        synthetic: true,
      }),
    ).rejects.toThrow('RAIL_EFFECT_TENANT_MISMATCH');
  });
});

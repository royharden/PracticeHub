import { describe, expect, it } from 'vitest';

import {
  reconcileUnknownEffect,
  validatePaymentRailInput,
  type PaymentRailPort,
} from './payment-rail.js';

describe('payment rail boundary', () => {
  it('accepts the closed PHI-free shape', () => {
    expect(() =>
      validatePaymentRailInput({
        tenantId: 'northwind-synthetic',
        processorAccountRef: 'acct-synthetic',
        money: { amountMinor: 2500, currency: 'USD' },
        opaqueProcessorSkuRef: 'sku-opaque-1',
        idempotencyKey: 'rail-key-1',
        synthetic: true,
      }),
    ).not.toThrow();
  });

  it('rejects a runtime-injected free-text field before adapter invocation', () => {
    expect(() =>
      validatePaymentRailInput({
        tenantId: 'northwind-synthetic',
        processorAccountRef: 'acct-synthetic',
        money: { amountMinor: 2500, currency: 'USD' },
        idempotencyKey: 'rail-key-1',
        synthetic: true,
        serviceTitle: 'forbidden',
      } as never),
    ).toThrow(/forbidden fields/);
  });

  it('rejects a zero-value paid effect before adapter invocation', () => {
    expect(() =>
      validatePaymentRailInput({
        tenantId: 'northwind-synthetic',
        processorAccountRef: 'acct-synthetic',
        money: { amountMinor: 0, currency: 'USD' },
        idempotencyKey: 'zero-value-key',
        synthetic: true,
      }),
    ).toThrow(/positive safe integer/);
  });

  it('protective reconciliation invokes lookup only and cannot initiate a new effect', async () => {
    let reconciles = 0;
    const rail: PaymentRailPort = {
      createPaymentIntent: () => {
        throw new Error('must not create');
      },
      refund: () => {
        throw new Error('must not refund');
      },
      reconcileEffect: (input) => {
        reconciles += 1;
        return Promise.resolve({
          effectRef: input.effectRef,
          outcome: 'unknown',
          observedAt: '2026-04-01T12:00:00Z',
        });
      },
    };
    expect(
      (
        await reconcileUnknownEffect(rail, {
          tenantId: 'northwind-synthetic',
          effectRef: 'effect-1',
          idempotencyKey: 'recon-1',
          synthetic: true,
        })
      ).outcome,
    ).toBe('unknown');
    expect(reconciles).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import type { EgressRequest, VendorRegistryRow } from '@practicehub/platform-integration';

import { lintStripeCharge } from './phi-linter.js';

const tenant = 'northwind-synthetic';

function vendor(overrides: Partial<VendorRegistryRow> = {}): VendorRegistryRow {
  return {
    tenantId: tenant,
    vendorId: 'stripe-simulated',
    vendorClass: 'payments',
    isAiVendor: false,
    enforcementPoint: 'payment-intent-boundary',
    baaStatus: 'executed',
    baaEffective: '2026-01-01',
    baaExpiry: '2027-01-01',
    noTrainingOnPhi: false,
    zeroRetention: false,
    permittedCategories: ['PAY', 'ID'],
    status: 'active',
    version: 1,
    synthetic: true,
    ...overrides,
  };
}

function request(overrides: Partial<EgressRequest> = {}): EgressRequest {
  return {
    tenantId: tenant,
    vendorId: 'stripe-simulated',
    phiClass: 'PHI',
    categories: ['PAY'],
    purpose: 'payment',
    asOf: '2026-06-01',
    actorRef: 'synthetic-staff:stripe',
    occurredAt: '2026-06-01T09:00:00Z',
    ...overrides,
  };
}

const draft = {
  sku: 'sku_9f3a2c',
  metadata: { orderRef: 'ord-1' },
  payloadRef: 'payload:stripe:1',
};

describe('lintStripeCharge', () => {
  it('allows an opaque SKU after the WP-026 egress guard permits PAY', () => {
    const decision = lintStripeCharge(draft, vendor(), request());
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe('permitted');
    expect(decision.egress?.reason).toBe('permitted');
  });

  it('blocks a clinical SKU before egress', () => {
    const decision = lintStripeCharge(
      { ...draft, sku: 'sku_patient_visit' },
      vendor(),
      request(),
    );
    expect(decision).toMatchObject({ allow: false, reason: 'sku-not-opaque', egress: null });
  });

  it('blocks denylisted metadata keys (patient, email, diagnosis)', () => {
    for (const key of ['patient', 'email', 'diagnosis', 'mrn']) {
      const decision = lintStripeCharge(
        { ...draft, metadata: { [key]: 'x' } },
        vendor(),
        request(),
      );
      expect(decision).toMatchObject({ allow: false, reason: 'metadata-denied', egress: null });
    }
  });

  it('still composes the vendor-BAA guard (no registry row blocks)', () => {
    const decision = lintStripeCharge(draft, null, request());
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('egress-blocked');
    expect(decision.egress?.reason).toBe('no-registry-row');
  });

  it('blocks PAY when the vendor is not permitted for PAY', () => {
    const decision = lintStripeCharge(draft, vendor({ permittedCategories: ['ID'] }), request());
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('egress-blocked');
    expect(decision.egress?.reason).toBe('category-not-permitted');
  });
});

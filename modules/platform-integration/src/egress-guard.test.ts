import { emitAuditEvent, emptyChainState } from '@practicehub/audit-evidence';
import { describe, expect, it } from 'vitest';

import { carriesProtectedData, evaluateEgress, type EgressRequest } from './egress-guard.js';
import type { VendorRegistryRow } from './vendor-registry.js';

const tenant = 'northwind-synthetic';

function vendor(overrides: Partial<VendorRegistryRow> = {}): VendorRegistryRow {
  return {
    tenantId: tenant,
    vendorId: 'synthetic-vendor',
    vendorClass: 'cpaas',
    isAiVendor: false,
    enforcementPoint: 'message-send-boundary',
    baaStatus: 'executed',
    baaEffective: '2026-01-01',
    baaExpiry: '2027-01-01',
    noTrainingOnPhi: false,
    zeroRetention: false,
    permittedCategories: ['ID', 'CLIN'],
    status: 'active',
    version: 2,
    synthetic: true,
    ...overrides,
  };
}

function request(overrides: Partial<EgressRequest> = {}): EgressRequest {
  return {
    tenantId: tenant,
    vendorId: 'synthetic-vendor',
    phiClass: 'PHI',
    categories: ['ID', 'CLIN'],
    purpose: 'treatment',
    asOf: '2026-06-01',
    actorRef: 'synthetic-staff:egress',
    occurredAt: '2026-06-01T09:00:00Z',
    ...overrides,
  };
}

describe('evaluateEgress — the egress matrix (R6-REQ-009 a-f), fail-closed', () => {
  it('(a) PHI to an executed, in-date, permitted-category vendor is ALLOWED and logged', () => {
    const decision = evaluateEgress(vendor(), request());
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe('permitted');
    expect(decision.incidentOpened).toBe(false);
    expect(decision.auditInput.decision).toBe('allow');
  });

  it('(b) PHI to a vendor with NO registry row is BLOCKED (fail-closed) + incident', () => {
    const decision = evaluateEgress(null, request());
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('no-registry-row');
    expect(decision.incidentOpened).toBe(true);
  });

  it('(c) PHI to an AI vendor missing the no-training clause is BLOCKED', () => {
    const decision = evaluateEgress(
      vendor({ isAiVendor: true, noTrainingOnPhi: false, zeroRetention: true }),
      request(),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('ai-no-training-clause');
  });

  it('(c) PHI to an AI vendor missing the zero-retention clause is BLOCKED', () => {
    const decision = evaluateEgress(
      vendor({ isAiVendor: true, noTrainingOnPhi: true, zeroRetention: false }),
      request(),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('ai-no-zero-retention');
  });

  it('(c) PHI to an AI vendor WITH both clauses is ALLOWED', () => {
    const decision = evaluateEgress(
      vendor({ isAiVendor: true, noTrainingOnPhi: true, zeroRetention: true }),
      request(),
    );
    expect(decision.allow).toBe(true);
  });

  it('(d) PHI to an expired-BAA vendor is BLOCKED (fail-closed the moment it lapses)', () => {
    const decision = evaluateEgress(
      vendor({ baaExpiry: '2026-05-31' }),
      request({ asOf: '2026-06-01' }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('baa-expired');
    expect(decision.incidentOpened).toBe(true);
  });

  it('(e) GEN data to a vendor permitted only for CLIN is BLOCKED (categories independent)', () => {
    const decision = evaluateEgress(
      vendor({ permittedCategories: ['ID', 'CLIN'] }),
      request({ categories: ['GEN'], phiClass: 'PHI-restricted' }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('category-not-permitted');
    expect(decision.auditInput.partitionTags).toEqual(['gipa-genetic']);
  });

  it('(f) CHD data to a vendor without CHD permission is BLOCKED', () => {
    const decision = evaluateEgress(
      vendor({ permittedCategories: ['ID', 'CLIN'] }),
      request({ categories: ['CHD'], phiClass: 'PHI' }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('category-not-permitted');
    expect(decision.auditInput.partitionTags).toEqual(['chd']);
  });
});

describe('evaluateEgress — additional fail-closed paths', () => {
  it('a non-executed (required/tbd) BAA never receives PHI', () => {
    expect(evaluateEgress(vendor({ baaStatus: 'required' }), request()).reason).toBe(
      'baa-not-executed',
    );
    expect(evaluateEgress(vendor({ baaStatus: 'tbd' }), request()).reason).toBe('baa-not-executed');
  });

  it('a suspended (lapsed) vendor row fails closed', () => {
    expect(evaluateEgress(vendor({ status: 'suspended' }), request()).reason).toBe(
      'vendor-suspended',
    );
  });

  it('stale/ambiguous registry data (missing dates or inverted window) fails closed', () => {
    expect(evaluateEgress(vendor({ baaEffective: null }), request()).reason).toBe(
      'ambiguous-registry-data',
    );
    expect(
      evaluateEgress(vendor({ baaEffective: '2027-01-01', baaExpiry: '2026-01-01' }), request())
        .reason,
    ).toBe('ambiguous-registry-data');
  });

  it('a not-yet-effective BAA fails closed', () => {
    expect(
      evaluateEgress(vendor({ baaEffective: '2026-07-01' }), request({ asOf: '2026-06-01' }))
        .reason,
    ).toBe('baa-not-yet-effective');
  });

  it('a mislabeled demographic payload naming a genetic category is still guarded', () => {
    // fail-closed toward protection: the class label does not downgrade a
    // sensitive category.
    const decision = evaluateEgress(
      vendor({ permittedCategories: ['ID'] }),
      request({ phiClass: 'demographic', categories: ['GEN'] }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('category-not-permitted');
  });

  it('a genuinely non-PHI (demographic, no sensitive category) send is a no-op allow', () => {
    const decision = evaluateEgress(
      vendor({ permittedCategories: ['ID'] }),
      request({ phiClass: 'demographic', categories: ['ID'] }),
    );
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe('no-phi');
    expect(carriesProtectedData({ phiClass: 'demographic', categories: ['ID'] })).toBe(false);
  });
});

describe('evaluateEgress — the decision is PHI-free tamper-evident audit', () => {
  const cases: readonly {
    readonly name: string;
    readonly req: EgressRequest;
    readonly row: VendorRegistryRow | null;
  }[] = [
    { name: 'allow', req: request(), row: vendor() },
    { name: 'block-no-row', req: request(), row: null },
    {
      name: 'block-genetic',
      req: request({ categories: ['GEN'], phiClass: 'PHI-restricted' }),
      row: vendor(),
    },
  ];
  for (const { name, req, row } of cases) {
    it(`${name}: the disclosure audit input emits and chains through the real emitter`, () => {
      const decision = evaluateEgress(row, req);
      const emitted = emitAuditEvent(emptyChainState, {
        ...decision.auditInput,
        auditId: `fx-egress-audit-${name}`,
      });
      expect(emitted.record.stream).toBe('disclosure');
      expect(emitted.record.entryHash).toMatch(/^[0-9a-f]{64}$/);
      expect(emitted.record.recipientRef).toBe('vendor:synthetic-vendor');
      // The raw payload never appears — only refs, class, categories, reason.
      expect(JSON.stringify(emitted.record)).not.toMatch(/patient|diagnosis|semaglutide/i);
    });
  }
});

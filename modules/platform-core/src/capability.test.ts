import { describe, expect, it } from 'vitest';

import {
  CapabilityDeniedError,
  isLegalCapabilityTransition,
  requireCapability,
  type CapabilityGrant,
} from './capability.js';

const grants: readonly CapabilityGrant[] = [
  {
    capabilityId: 'platform.bootstrap',
    tenantId: 'northwind-synthetic',
    scope: {},
    state: 'active',
    evidenceRefs: ['synthetic-gate'],
    rollbackRef: 'disable-platform-bootstrap',
  },
  {
    capabilityId: 'platform.bootstrap',
    tenantId: 'riverbend-synthetic',
    scope: {},
    state: 'disabled',
    evidenceRefs: ['synthetic-negative'],
    rollbackRef: 'already-disabled',
  },
];

describe('capability registry scaffold', () => {
  it('permits the matching tenant and records an authority decision', () => {
    const decision = requireCapability(
      grants,
      { tenantId: 'northwind-synthetic', scope: {} },
      'platform.bootstrap',
    );
    expect(decision.allowed).toBe(true);
    expect(decision.tenantId).toBe('northwind-synthetic');
  });

  it('fails closed for Riverbend in the opposite capability state', () => {
    expect(() =>
      requireCapability(
        grants,
        { tenantId: 'riverbend-synthetic', scope: {} },
        'platform.bootstrap',
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('rejects cross-tenant grant reuse', () => {
    expect(() =>
      requireCapability(grants, { tenantId: 'tenant-not-seeded', scope: {} }, 'platform.bootstrap'),
    ).toThrow(CapabilityDeniedError);
  });

  it('represents only adjacent state transitions', () => {
    expect(isLegalCapabilityTransition('simulated', 'shadow')).toBe(true);
    expect(isLegalCapabilityTransition('simulated', 'active')).toBe(false);
  });
});

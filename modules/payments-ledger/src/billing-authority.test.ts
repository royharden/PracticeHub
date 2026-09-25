import type { CapabilityGrant, CapabilityId, CapabilityState } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { assertBillingAuthoritySimulated, BillingAuthorityError } from './billing-authority.js';

const grant = (capabilityId: CapabilityId, state: CapabilityState): CapabilityGrant => ({
  capabilityId,
  tenantId: 'northwind-synthetic',
  scope: {},
  state,
  sinceEventId: null,
  evidenceRefs: [],
  rollbackRef: 'rollback-synthetic',
  synthetic: true,
});

describe('billing authority below membership.entitlement-ledger', () => {
  it('allows a simulated billing grant when the entitlement ledger is simulated', () => {
    const decision = assertBillingAuthoritySimulated(
      [
        grant('membership.entitlement-ledger', 'simulated'),
        grant('finance.billing-authority', 'simulated'),
      ],
      'northwind-synthetic',
    );
    expect(decision.allowed).toBe(true);
    expect(decision.minimumState).toBe('simulated');
  });

  it('denies simulated billing when the entitlement ledger is below simulated', () => {
    let caught: unknown;
    try {
      assertBillingAuthoritySimulated(
        [
          grant('membership.entitlement-ledger', 'scaffolded'),
          grant('finance.billing-authority', 'simulated'),
        ],
        'northwind-synthetic',
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BillingAuthorityError);
    expect((caught as BillingAuthorityError).code).toBe('DENIED');
  });
});

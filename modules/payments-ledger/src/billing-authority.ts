import {
  capabilityRegistryV1,
  CapabilityDeniedError,
  listCapabilityEdgeViolations,
  requireCapability,
  type AuthorityDecision,
  type CapabilityGrant,
} from '@practicehub/platform-core';

export class BillingAuthorityError extends Error {
  public constructor(
    public readonly code: 'DENIED',
    public readonly detail: string,
  ) {
    super(code);
    this.name = 'BillingAuthorityError';
  }
}

/**
 * Simulated billing check. IC-3 denies finance.billing-authority when
 * membership.entitlement-ledger is below simulated, including a grant that
 * was recorded before the prerequisite fell.
 */
export function assertBillingAuthoritySimulated(
  grants: readonly CapabilityGrant[],
  tenantId: string,
): AuthorityDecision {
  const violation = listCapabilityEdgeViolations(capabilityRegistryV1, grants).find(
    (item) => item.constraintId === 'IC-3' && item.tenantId === tenantId,
  );
  if (violation !== undefined) {
    throw new BillingAuthorityError('DENIED', violation.message);
  }
  try {
    return requireCapability(
      capabilityRegistryV1,
      grants,
      { tenantId, scope: {} },
      'finance.billing-authority',
      { minimumState: 'simulated' },
    );
  } catch (error) {
    if (error instanceof CapabilityDeniedError) {
      throw new BillingAuthorityError('DENIED', error.decision.reason);
    }
    throw error;
  }
}

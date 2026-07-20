export const capabilityStates = [
  'disabled',
  'scaffolded',
  'simulated',
  'shadow',
  'pilot',
  'active',
  'read-only',
  'retiring',
] as const;

export type CapabilityState = (typeof capabilityStates)[number];

export const initialCapabilityDimensions = [
  'legal_entity',
  'location',
  'cohort',
  'payer',
  'channel',
  'provider',
  'service',
  'transaction',
  'number',
  'brand',
  'wave',
  'era',
  'prescriber',
  'lab_network',
  'feature',
] as const;

export type CapabilityDimension = (typeof initialCapabilityDimensions)[number];
export type CapabilityScope = Readonly<Partial<Record<CapabilityDimension, string>>>;

export interface CapabilityGrant {
  readonly capabilityId: `${string}.${string}`;
  readonly tenantId: string;
  readonly scope: CapabilityScope;
  readonly state: CapabilityState;
  readonly evidenceRefs: readonly string[];
  readonly rollbackRef: string;
}

export interface CapabilityContext {
  readonly tenantId: string;
  readonly scope: CapabilityScope;
}

export interface AuthorityDecision {
  readonly capabilityId: CapabilityGrant['capabilityId'];
  readonly tenantId: string;
  readonly grantState: CapabilityState;
  readonly grantScope: CapabilityScope;
  readonly allowed: boolean;
  readonly reason: string;
}

const authorityStates = new Set<CapabilityState>(['pilot', 'active']);
const transitions: Readonly<Record<CapabilityState, readonly CapabilityState[]>> = {
  disabled: ['scaffolded'],
  scaffolded: ['disabled', 'simulated'],
  simulated: ['scaffolded', 'shadow'],
  shadow: ['simulated', 'pilot'],
  pilot: ['shadow', 'active'],
  active: ['pilot', 'read-only'],
  'read-only': ['active', 'retiring'],
  retiring: ['disabled', 'read-only'],
};

export class CapabilityDeniedError extends Error {
  public constructor(readonly decision: AuthorityDecision) {
    super(decision.reason);
    this.name = 'CapabilityDeniedError';
  }
}

export function isLegalCapabilityTransition(from: CapabilityState, to: CapabilityState): boolean {
  return transitions[from].includes(to);
}

function scopeMatches(grant: CapabilityScope, request: CapabilityScope): boolean {
  return Object.entries(grant).every(
    ([dimension, value]) => request[dimension as CapabilityDimension] === value,
  );
}

export function requireCapability(
  grants: readonly CapabilityGrant[],
  context: CapabilityContext,
  capabilityId: CapabilityGrant['capabilityId'],
): AuthorityDecision {
  const grant = grants
    .filter(
      (candidate) =>
        candidate.tenantId === context.tenantId &&
        candidate.capabilityId === capabilityId &&
        scopeMatches(candidate.scope, context.scope),
    )
    .sort((left, right) => Object.keys(right.scope).length - Object.keys(left.scope).length)[0];

  const allowed = grant !== undefined && authorityStates.has(grant.state);
  const decision: AuthorityDecision = {
    capabilityId,
    tenantId: context.tenantId,
    grantState: grant?.state ?? 'disabled',
    grantScope: grant?.scope ?? {},
    allowed,
    reason: allowed ? 'matching authority grant' : 'no matching pilot or active grant',
  };

  if (!allowed) {
    throw new CapabilityDeniedError(decision);
  }
  return decision;
}

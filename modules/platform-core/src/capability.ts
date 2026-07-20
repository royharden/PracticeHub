/**
 * Capability-state registry (WP-012). Contract: docs/contracts/capability-registry.md
 * (FROZEN). Architecture: ADR-011, adjudication R-5 (ADR-ADJ-001).
 *
 * The registry is the product's rollout mechanism (D1): every module walks
 * `disabled → scaffolded → simulated → shadow → pilot → active → read-only →
 * retiring`, scoped per declared dimensions, with owner + evidence + rollback
 * recorded per transition. Transitions are event-sourced; grants are the
 * projection. Authority-bearing writes consult `requireCapability` and record
 * the returned AuthorityDecision. Everything here is pure over caller-supplied
 * stores; the database posture (RLS, append-only events, adjacency CHECKs)
 * lives in modules/platform-core/migrations/0003-capability.sql.
 */

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

/**
 * Initial dimension set (ADR-011 Decision 1). Adding a dimension is a registry
 * data change (contract revision), never a schema change: scopes are maps.
 */
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
export type CapabilityId = `${string}.${string}`;

/** IC-6 placeholder: resolved from the transition request's targetCapabilityId. */
export const targetModuleCapabilityToken = 'target-module.capability';

export interface CapabilityDefinition {
  readonly capabilityId: CapabilityId;
  /** Accountable owner role for transitions of this capability. */
  readonly ownerRole: string;
  /** Dimensions a grant of this capability MAY bind. */
  readonly dimensions: readonly CapabilityDimension[];
  /**
   * Dimensions every grant MUST bind. A capability whose proof is
   * path-specific (REQ-PLAT-012: per payer x provider x transaction) declares
   * them here, making broad masquerade grants unrepresentable.
   */
  readonly requiredDimensions?: readonly CapabilityDimension[];
  /** Specificity tie-break order; defaults to the declared dimension order. */
  readonly precedence?: readonly CapabilityDimension[];
  readonly description: string;
}

/** Phase-inversion edge (docs/architecture/capability-edge-preconditions.csv, FROZEN). */
export interface CapabilityEdge {
  readonly constraintId: string;
  readonly prerequisiteCapabilityId: CapabilityId | typeof targetModuleCapabilityToken;
  readonly minimumPrerequisiteState: CapabilityState;
  readonly dependentCapabilityId: CapabilityId;
  readonly maxDependentStateWithoutPrerequisite: CapabilityState;
  readonly requiredNegativeProof: string;
}

/**
 * External-wait ceiling (ADR-ADJ-001 R-5): a capability whose activation is
 * gated by an external wait carries a max pre-wait state; transitions above it
 * require a release-evidence reference. Rows are added by the packages that
 * own the affected capability.
 */
export interface CapabilityCeiling {
  readonly capabilityId: CapabilityId;
  readonly maxState: CapabilityState;
  readonly releaseEvidencePrefix: string;
  readonly ref: string;
}

/**
 * Transition approval policy. `draft` pending the section-11 approval-matrix
 * graduation (defect logged in the WP-012 ledger row); the enforced floor is
 * conservative and owner-independent until that matrix lands.
 */
export interface CapabilityApprovalPolicy {
  readonly version: number;
  readonly status: 'draft' | 'adjudicated';
  readonly pendingRef?: string;
  /** Approvals required on any transition into an authority-bearing state. */
  readonly authorityApprovalMinimum: number;
  /** Evidence-ref prefix that satisfies the pilot->active rehearsal receipt. */
  readonly rehearsedRollbackEvidencePrefix: string;
}

export interface CapabilityRegistry {
  readonly version: number;
  readonly definitions: readonly CapabilityDefinition[];
  readonly edges: readonly CapabilityEdge[];
  readonly ceilings: readonly CapabilityCeiling[];
  readonly approvalPolicy: CapabilityApprovalPolicy;
}

export interface CapabilityApproval {
  readonly approverRef: string;
  readonly role: string;
}

export interface CapabilityGrant {
  readonly capabilityId: CapabilityId;
  readonly tenantId: string;
  readonly scope: CapabilityScope;
  readonly state: CapabilityState;
  /** Null only for a declared initial state that no transition produced. */
  readonly sinceEventId: string | null;
  readonly evidenceRefs: readonly string[];
  readonly rollbackRef: string;
  readonly synthetic: true;
}

export interface CapabilityTransitionEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly capabilityId: CapabilityId;
  readonly scope: CapabilityScope;
  readonly fromState: CapabilityState;
  readonly toState: CapabilityState;
  readonly initiatorRef: string;
  readonly approvals: readonly CapabilityApproval[];
  readonly evidenceRefs: readonly string[];
  readonly rollbackRef: string;
  readonly reviewRef?: string;
  /** IC-6 binding: the target module capability a wave import moves under. */
  readonly targetCapabilityId?: CapabilityId;
  readonly reason?: string;
  readonly synthetic: true;
}

export interface CapabilityTransitionRequest {
  readonly tenantId: string;
  readonly capabilityId: CapabilityId;
  readonly scope: CapabilityScope;
  readonly fromState: CapabilityState;
  readonly toState: CapabilityState;
  readonly initiatorRef: string;
  readonly approvals: readonly CapabilityApproval[];
  readonly evidenceRefs: readonly string[];
  readonly rollbackRef?: string;
  readonly reviewRef?: string;
  readonly targetCapabilityId?: CapabilityId;
  readonly reason?: string;
}

export interface CapabilityContext {
  readonly tenantId: string;
  readonly scope: CapabilityScope;
}

export type CapabilityCheckpoint = 'enqueue' | 'drain';

export interface RequireCapabilityOptions {
  /**
   * Lowest grant state that satisfies the check. Defaults to `pilot`: an
   * authority-bearing write needs live authority. Handlers whose side effects
   * stay inside the synthetic/simulator boundary pass `simulated`.
   */
  readonly minimumState?: CapabilityState;
  /**
   * Where the check runs. Checks run at BOTH enqueue and drain time; drain is
   * authoritative — queued work re-checks its grant before any side effect so
   * kill-switch/rollback transitions drain safely (ADR-011 Decision 2).
   */
  readonly checkpoint?: CapabilityCheckpoint;
  /** Registry store version (capabilityRegistryVersion) echoed for cache keys. */
  readonly registryVersion?: number;
  readonly purpose?: string;
}

export interface AuthorityDecision {
  readonly capabilityId: CapabilityId;
  readonly tenantId: string;
  readonly grantState: CapabilityState;
  readonly grantScope: CapabilityScope;
  readonly grantScopeKey: string | null;
  readonly sinceEventId: string | null;
  readonly allowed: boolean;
  readonly reason: string;
  readonly minimumState: CapabilityState;
  readonly checkpoint: CapabilityCheckpoint;
  readonly registryVersion?: number;
  readonly purpose?: string;
}

export interface CapabilityTransitionDenial {
  readonly code: string;
  readonly message: string;
}

export interface CapabilityTransitionEvaluation {
  readonly allowed: boolean;
  readonly denials: readonly CapabilityTransitionDenial[];
  /** Outstanding approval requirements — the console's pending-approvals feed. */
  readonly missingApprovals: readonly string[];
  readonly violatedEdges: readonly string[];
}

export class CapabilityRegistryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CapabilityRegistryError';
  }
}

export class CapabilityDeniedError extends Error {
  public constructor(readonly decision: AuthorityDecision) {
    super(decision.reason);
    this.name = 'CapabilityDeniedError';
  }
}

export class CapabilityTransitionDeniedError extends Error {
  public constructor(readonly evaluation: CapabilityTransitionEvaluation) {
    super(
      `capability transition denied: ${evaluation.denials
        .map((denial) => `${denial.code} (${denial.message})`)
        .join('; ')}`,
    );
    this.name = 'CapabilityTransitionDeniedError';
  }
}

/** Adjacent-only state machine (ADR-011 Decision 1): illegal jumps are unrepresentable. */
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

export const capabilityStateRank: Readonly<Record<CapabilityState, number>> = {
  disabled: 0,
  scaffolded: 1,
  simulated: 2,
  shadow: 3,
  pilot: 4,
  active: 5,
  'read-only': 6,
  retiring: 7,
};

/** Live-authority states: entering one is an authority-bearing transition. */
export const authorityCapabilityStates: readonly CapabilityState[] = ['pilot', 'active'];

/** Write-blocked states (ADR-011 Decision 4): tail reads only, never side effects. */
export const writeBlockedCapabilityStates: readonly CapabilityState[] = ['read-only', 'retiring'];

/**
 * Write-authority ordering: how much side-effect authority a state carries.
 * Distinct from the walk order (`capabilityStateRank`) because the
 * decommission tail (read-only/retiring) sits AFTER active in the walk while
 * carrying NO write authority. Approval gating, ceilings, and edge
 * preconditions compare THIS ordering, so rollback and decommission
 * transitions are never blocked by gates meant for authority increases.
 */
export const capabilityWriteAuthorityLevel: Readonly<Record<CapabilityState, number>> = {
  disabled: 0,
  scaffolded: 1,
  simulated: 2,
  shadow: 3,
  pilot: 4,
  active: 5,
  'read-only': 0,
  retiring: 0,
};

export function isLegalCapabilityTransition(from: CapabilityState, to: CapabilityState): boolean {
  return transitions[from].includes(to);
}

export function legalCapabilityTransitions(): readonly (readonly [
  CapabilityState,
  CapabilityState,
])[] {
  return capabilityStates.flatMap((from) => transitions[from].map((to) => [from, to] as const));
}

const capabilityIdPattern = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
const dimensionValuePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const actorRefPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const evidenceRefPattern = /^[a-z0-9][a-z0-9:./-]{0,127}$/;

/** Canonical scope serialization — the database projection key. */
export function canonicalScopeKey(scope: CapabilityScope): string {
  const entries = Object.entries(scope).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return '(root)';
  }
  return entries
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([dimension, value]) => `${dimension}=${value}`)
    .join('/');
}

/** Definition lookup — fails closed on undeclared or malformed capability ids. */
export function getCapabilityDefinition(
  registry: CapabilityRegistry,
  capabilityId: CapabilityId,
  label: string,
): CapabilityDefinition {
  if (!capabilityIdPattern.test(capabilityId)) {
    throw new CapabilityRegistryError(
      `${label}: capability id ${JSON.stringify(capabilityId)} must match module.capability`,
    );
  }
  const definition = registry.definitions.find(
    (candidate) => candidate.capabilityId === capabilityId,
  );
  if (definition === undefined) {
    throw new CapabilityRegistryError(
      `${label}: capability ${capabilityId} is not declared in the definition registry (deny-by-default)`,
    );
  }
  return definition;
}

/**
 * Grant/scope validation — fails closed. Undeclared capabilities, undeclared
 * dimensions, malformed values, and missing required dimensions (path-specific
 * proof capabilities) are all unrepresentable as valid grants.
 */
export function assertScopeForCapability(
  registry: CapabilityRegistry,
  capabilityId: CapabilityId,
  scope: CapabilityScope,
  label: string,
): CapabilityDefinition {
  const definition = getCapabilityDefinition(registry, capabilityId, label);
  for (const [dimension, value] of Object.entries(scope)) {
    if (!(definition.dimensions as readonly string[]).includes(dimension)) {
      throw new CapabilityRegistryError(
        `${label}: capability ${capabilityId} does not accept dimension ${JSON.stringify(dimension)}`,
      );
    }
    if (typeof value !== 'string' || !dimensionValuePattern.test(value)) {
      throw new CapabilityRegistryError(
        `${label}: dimension ${dimension} value ${JSON.stringify(value)} must match ${dimensionValuePattern.source}`,
      );
    }
  }
  for (const required of definition.requiredDimensions ?? []) {
    if (scope[required] === undefined) {
      throw new CapabilityRegistryError(
        `${label}: capability ${capabilityId} requires dimension ${required} on every grant ` +
          '(path-specific proof; a broader grant would masquerade as coverage)',
      );
    }
  }
  return definition;
}

function grantApplies(grant: CapabilityGrant, context: CapabilityContext): boolean {
  if (grant.tenantId !== context.tenantId) {
    return false;
  }
  return Object.entries(grant.scope).every(
    ([dimension, value]) => context.scope[dimension as CapabilityDimension] === value,
  );
}

/**
 * Most-specific-grant resolution (ADR-011 Decision 2): specificity = number of
 * matching declared dimensions; ties break by the capability's declared
 * dimension precedence list (a grant binding an earlier-precedence dimension
 * wins). Grants are validated against the definition — an invalid grant is an
 * error, never a silent allow or skip.
 */
export function resolveCapabilityGrant(
  registry: CapabilityRegistry,
  grants: readonly CapabilityGrant[],
  context: CapabilityContext,
  capabilityId: CapabilityId,
): CapabilityGrant | undefined {
  const definition = getCapabilityDefinition(registry, capabilityId, 'resolve');
  const precedence = definition.precedence ?? definition.dimensions;
  const candidates = grants.filter((grant) => grant.capabilityId === capabilityId);
  for (const grant of candidates) {
    assertScopeForCapability(registry, grant.capabilityId, grant.scope, 'grant');
  }
  return candidates
    .filter((grant) => grantApplies(grant, context))
    .sort((left, right) => {
      const bySpecificity = Object.keys(right.scope).length - Object.keys(left.scope).length;
      if (bySpecificity !== 0) {
        return bySpecificity;
      }
      for (const dimension of precedence) {
        const leftBinds = left.scope[dimension] !== undefined ? 1 : 0;
        const rightBinds = right.scope[dimension] !== undefined ? 1 : 0;
        if (leftBinds !== rightBinds) {
          return rightBinds - leftBinds;
        }
      }
      return canonicalScopeKey(left.scope) < canonicalScopeKey(right.scope) ? -1 : 1;
    })[0];
}

const requireMinimumStates: readonly CapabilityState[] = [
  'scaffolded',
  'simulated',
  'shadow',
  'pilot',
  'active',
];

/** True when a grant in `state` satisfies a side-effect check floored at `minimum`. */
export function capabilityStateSatisfies(
  state: CapabilityState,
  minimum: CapabilityState,
): boolean {
  if ((writeBlockedCapabilityStates as readonly string[]).includes(state)) {
    return false;
  }
  return capabilityStateRank[state] >= capabilityStateRank[minimum];
}

/**
 * The one runtime helper (ADR-011 Decision 2): deny-by-default resolution of
 * the most specific grant. Side-effecting handlers MUST consult it (the
 * handler-coverage lint enforces presence); the returned AuthorityDecision is
 * the record an authority-bearing write attaches to its audit trail. Denials
 * throw CapabilityDeniedError — consent-style fail-closed.
 */
export function requireCapability(
  registry: CapabilityRegistry,
  grants: readonly CapabilityGrant[],
  context: CapabilityContext,
  capabilityId: CapabilityId,
  options: RequireCapabilityOptions = {},
): AuthorityDecision {
  const minimumState = options.minimumState ?? 'pilot';
  if (!requireMinimumStates.includes(minimumState)) {
    throw new CapabilityRegistryError(
      `requireCapability minimumState ${JSON.stringify(minimumState)} must be one of ` +
        requireMinimumStates.join('/'),
    );
  }
  const grant = resolveCapabilityGrant(registry, grants, context, capabilityId);
  const allowed = grant !== undefined && capabilityStateSatisfies(grant.state, minimumState);
  const decision: AuthorityDecision = {
    capabilityId,
    tenantId: context.tenantId,
    grantState: grant?.state ?? 'disabled',
    grantScope: grant?.scope ?? {},
    grantScopeKey: grant ? canonicalScopeKey(grant.scope) : null,
    sinceEventId: grant?.sinceEventId ?? null,
    allowed,
    reason: allowed
      ? `grant ${canonicalScopeKey(grant.scope)} at ${grant.state} satisfies ${minimumState}`
      : grant === undefined
        ? `no grant for ${capabilityId} matches the request scope (deny-by-default)`
        : `grant ${canonicalScopeKey(grant.scope)} at ${grant.state} does not satisfy ${minimumState}`,
    minimumState,
    checkpoint: options.checkpoint ?? 'drain',
    ...(options.registryVersion !== undefined ? { registryVersion: options.registryVersion } : {}),
    ...(options.purpose !== undefined ? { purpose: options.purpose } : {}),
  };
  if (!allowed) {
    throw new CapabilityDeniedError(decision);
  }
  return decision;
}

function currentStateAtScope(
  grants: readonly CapabilityGrant[],
  request: CapabilityTransitionRequest,
): { state: CapabilityState; grant: CapabilityGrant | undefined } {
  const scopeKey = canonicalScopeKey(request.scope);
  const grant = grants.find(
    (candidate) =>
      candidate.tenantId === request.tenantId &&
      candidate.capabilityId === request.capabilityId &&
      canonicalScopeKey(candidate.scope) === scopeKey,
  );
  return { state: grant?.state ?? 'disabled', grant };
}

/**
 * Full transition gate. Checks, in order: capability + scope validity,
 * adjacency (illegal jumps unrepresentable), optimistic from-state match,
 * evidence (every rank-increasing transition carries at least one gate
 * receipt), approvals (authority-entering transitions carry separation-of-duty
 * approvals; pilot->active carries the rehearsed-rollback receipt), external
 * ceilings, and the IC edge preconditions. Rollback-direction transitions are
 * never blocked on approvals or evidence (ADR-011 Decision 4: instant
 * per-scope rollback).
 */
export function evaluateCapabilityTransition(
  registry: CapabilityRegistry,
  grants: readonly CapabilityGrant[],
  request: CapabilityTransitionRequest,
): CapabilityTransitionEvaluation {
  const denials: CapabilityTransitionDenial[] = [];
  const missingApprovals: string[] = [];
  const violatedEdges: string[] = [];

  try {
    assertScopeForCapability(registry, request.capabilityId, request.scope, 'transition');
  } catch (error) {
    return {
      allowed: false,
      denials: [{ code: 'invalid-request', message: (error as Error).message }],
      missingApprovals,
      violatedEdges,
    };
  }
  if (!actorRefPattern.test(request.initiatorRef)) {
    denials.push({
      code: 'invalid-initiator',
      message: `initiatorRef must match ${actorRefPattern.source}`,
    });
  }
  for (const evidenceRef of request.evidenceRefs) {
    if (!evidenceRefPattern.test(evidenceRef)) {
      denials.push({
        code: 'invalid-evidence-ref',
        message: `evidence ref ${JSON.stringify(evidenceRef)} must match ${evidenceRefPattern.source}`,
      });
    }
  }
  for (const approval of request.approvals) {
    if (!actorRefPattern.test(approval.approverRef)) {
      denials.push({
        code: 'invalid-approver',
        message: `approverRef must match ${actorRefPattern.source}`,
      });
    }
  }

  if (!isLegalCapabilityTransition(request.fromState, request.toState)) {
    denials.push({
      code: 'illegal-transition',
      message:
        `${request.fromState} -> ${request.toState} is not an adjacent transition; ` +
        `legal targets from ${request.fromState}: ${transitions[request.fromState].join(', ')}`,
    });
  }

  const { state: currentState } = currentStateAtScope(grants, request);
  if (currentState !== request.fromState) {
    denials.push({
      code: 'stale-from-state',
      message:
        `scope ${canonicalScopeKey(request.scope)} is at ${currentState}, ` +
        `not ${request.fromState}; re-read the registry before transitioning`,
    });
  }

  const rankIncrease =
    capabilityStateRank[request.toState] > capabilityStateRank[request.fromState];
  const entersAuthority =
    (authorityCapabilityStates as readonly string[]).includes(request.toState) &&
    capabilityWriteAuthorityLevel[request.toState] >
      capabilityWriteAuthorityLevel[request.fromState];
  const policy = registry.approvalPolicy;

  if (rankIncrease || entersAuthority) {
    if (request.evidenceRefs.length === 0) {
      denials.push({
        code: 'missing-evidence',
        message: 'evidence-gated transition requires at least one gate-receipt reference',
      });
      missingApprovals.push('evidence: at least one gate receipt');
    }
    if (!request.rollbackRef) {
      denials.push({
        code: 'missing-rollback-ref',
        message: 'evidence-gated transition requires a rollback procedure reference',
      });
    }
  }
  if (entersAuthority) {
    const independentApprovals = request.approvals.filter(
      (approval) => approval.approverRef !== request.initiatorRef,
    );
    if (request.approvals.some((approval) => approval.approverRef === request.initiatorRef)) {
      denials.push({
        code: 'initiator-cannot-self-approve',
        message: 'separation of duty: the initiator cannot approve their own transition',
      });
    }
    if (independentApprovals.length < policy.authorityApprovalMinimum) {
      denials.push({
        code: 'missing-approval',
        message:
          `transition to ${request.toState} requires ${policy.authorityApprovalMinimum} ` +
          `approval(s) independent of the initiator (approval policy v${policy.version}` +
          `${policy.status === 'draft' ? ', draft pending ' + (policy.pendingRef ?? 'adjudication') : ''})`,
      });
      missingApprovals.push(
        `${policy.authorityApprovalMinimum - independentApprovals.length} independent approval(s)`,
      );
    }
  }
  if (request.fromState === 'pilot' && request.toState === 'active') {
    const rehearsed = request.evidenceRefs.some((ref) =>
      ref.startsWith(policy.rehearsedRollbackEvidencePrefix),
    );
    if (!rehearsed) {
      denials.push({
        code: 'missing-rollback-rehearsal',
        message:
          'pilot -> active requires a rehearsed-rollback receipt ' +
          `(evidence ref starting ${JSON.stringify(policy.rehearsedRollbackEvidencePrefix)})`,
      });
      missingApprovals.push('rehearsed-rollback receipt');
    }
  }

  for (const ceiling of registry.ceilings) {
    if (ceiling.capabilityId !== request.capabilityId) {
      continue;
    }
    if (
      capabilityWriteAuthorityLevel[request.toState] <=
      capabilityWriteAuthorityLevel[ceiling.maxState]
    ) {
      continue;
    }
    const released = request.evidenceRefs.some((ref) =>
      ref.startsWith(ceiling.releaseEvidencePrefix),
    );
    if (!released) {
      denials.push({
        code: `ceiling:${ceiling.ref}`,
        message:
          `${ceiling.ref} caps ${request.capabilityId} at ${ceiling.maxState} until release ` +
          `evidence (${ceiling.releaseEvidencePrefix}...) is recorded`,
      });
    }
  }

  for (const edge of registry.edges) {
    if (edge.dependentCapabilityId !== request.capabilityId) {
      continue;
    }
    if (
      capabilityWriteAuthorityLevel[request.toState] <=
      capabilityWriteAuthorityLevel[edge.maxDependentStateWithoutPrerequisite]
    ) {
      continue;
    }
    let prerequisiteId: CapabilityId | undefined;
    if (edge.prerequisiteCapabilityId === targetModuleCapabilityToken) {
      prerequisiteId = request.targetCapabilityId;
      if (prerequisiteId === undefined) {
        denials.push({
          code: edge.constraintId,
          message:
            `${edge.constraintId}: transition requires targetCapabilityId naming the target ` +
            'module capability (fail-closed without it)',
        });
        violatedEdges.push(edge.constraintId);
        continue;
      }
    } else {
      prerequisiteId = edge.prerequisiteCapabilityId;
    }
    let satisfied: boolean;
    try {
      const prerequisite = resolveCapabilityGrant(
        registry,
        grants,
        { tenantId: request.tenantId, scope: request.scope },
        prerequisiteId,
      );
      satisfied =
        prerequisite !== undefined &&
        capabilityStateSatisfies(prerequisite.state, edge.minimumPrerequisiteState);
    } catch {
      satisfied = false;
    }
    if (!satisfied) {
      denials.push({
        code: edge.constraintId,
        message:
          `${edge.constraintId}: ${request.capabilityId} cannot pass ` +
          `${edge.maxDependentStateWithoutPrerequisite} while ${prerequisiteId} is below ` +
          `${edge.minimumPrerequisiteState} (${edge.requiredNegativeProof})`,
      });
      violatedEdges.push(edge.constraintId);
    }
  }

  return { allowed: denials.length === 0, denials, missingApprovals, violatedEdges };
}

/**
 * Gate + event constructor: the only way to mint a transition event. Throws
 * CapabilityTransitionDeniedError carrying the full evaluation on any denial.
 */
export function applyCapabilityTransition(
  registry: CapabilityRegistry,
  grants: readonly CapabilityGrant[],
  request: CapabilityTransitionRequest,
  eventId: string,
): CapabilityTransitionEvent {
  const evaluation = evaluateCapabilityTransition(registry, grants, request);
  if (!evaluation.allowed) {
    throw new CapabilityTransitionDeniedError(evaluation);
  }
  if (!actorRefPattern.test(eventId)) {
    throw new CapabilityRegistryError(`event id must match ${actorRefPattern.source}`);
  }
  return {
    eventId,
    tenantId: request.tenantId,
    capabilityId: request.capabilityId,
    scope: request.scope,
    fromState: request.fromState,
    toState: request.toState,
    initiatorRef: request.initiatorRef,
    approvals: request.approvals,
    evidenceRefs: request.evidenceRefs,
    rollbackRef: request.rollbackRef ?? 'instant-rollback',
    ...(request.reviewRef !== undefined ? { reviewRef: request.reviewRef } : {}),
    ...(request.targetCapabilityId !== undefined
      ? { targetCapabilityId: request.targetCapabilityId }
      : {}),
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
    synthetic: true,
  };
}

/** One projection step: fold a transition event into the grant set. */
export function applyEventToGrants(
  grants: readonly CapabilityGrant[],
  event: CapabilityTransitionEvent,
): readonly CapabilityGrant[] {
  const scopeKey = canonicalScopeKey(event.scope);
  const existing = grants.find(
    (grant) =>
      grant.tenantId === event.tenantId &&
      grant.capabilityId === event.capabilityId &&
      canonicalScopeKey(grant.scope) === scopeKey,
  );
  const currentState = existing?.state ?? 'disabled';
  if (
    currentState !== event.fromState ||
    !isLegalCapabilityTransition(event.fromState, event.toState)
  ) {
    throw new CapabilityRegistryError(
      `event ${event.eventId} does not chain: scope ${scopeKey} is at ${currentState}, ` +
        `event moves ${event.fromState} -> ${event.toState}`,
    );
  }
  const next: CapabilityGrant = {
    capabilityId: event.capabilityId,
    tenantId: event.tenantId,
    scope: event.scope,
    state: event.toState,
    sinceEventId: event.eventId,
    evidenceRefs: event.evidenceRefs,
    rollbackRef: event.rollbackRef,
    synthetic: true,
  };
  return [...grants.filter((grant) => grant !== existing), next];
}

/**
 * Rebuild the grant projection from declared initial grants + the ordered
 * event log. A chain break (non-adjacent event, from-state mismatch) throws:
 * registry integrity is proven, not assumed. The registry itself is the
 * reversibility mechanism — rollback replays the log to an earlier point.
 */
export function foldCapabilityEvents(
  registry: CapabilityRegistry,
  initialGrants: readonly CapabilityGrant[],
  events: readonly CapabilityTransitionEvent[],
): readonly CapabilityGrant[] {
  for (const grant of initialGrants) {
    assertScopeForCapability(registry, grant.capabilityId, grant.scope, 'initial grant');
  }
  return events.reduce<readonly CapabilityGrant[]>(
    (grants, event) => applyEventToGrants(grants, event),
    initialGrants,
  );
}

/** Cache key for require() memoization; invalidate on every appended event. */
export function capabilityRegistryVersion(events: readonly CapabilityTransitionEvent[]): number {
  return events.length;
}

export interface GrantMatrixRow {
  readonly tenantId: string;
  readonly capabilityId: CapabilityId;
  readonly scopeKey: string;
  readonly state: CapabilityState;
  readonly evidenceRefs: readonly string[];
  readonly sinceEventId: string | null;
}

export interface GrantMatrixFilter {
  readonly tenantId?: string;
  readonly capabilityId?: CapabilityId;
}

/**
 * Console API (ADR-011 Decision 5; UI lands with WP-077): the full grant
 * matrix, ordered and filterable. Every path (payer/transaction/etc. scope) is
 * an independent row with its own state and evidence — one path's evidence
 * never renders as another's (REQ-PLAT-012).
 */
export function listGrantMatrix(
  registry: CapabilityRegistry,
  grants: readonly CapabilityGrant[],
  filter: GrantMatrixFilter = {},
): readonly GrantMatrixRow[] {
  for (const grant of grants) {
    assertScopeForCapability(registry, grant.capabilityId, grant.scope, 'grant');
  }
  return grants
    .filter(
      (grant) =>
        (filter.tenantId === undefined || grant.tenantId === filter.tenantId) &&
        (filter.capabilityId === undefined || grant.capabilityId === filter.capabilityId),
    )
    .map((grant) => ({
      tenantId: grant.tenantId,
      capabilityId: grant.capabilityId,
      scopeKey: canonicalScopeKey(grant.scope),
      state: grant.state,
      evidenceRefs: grant.evidenceRefs,
      sinceEventId: grant.sinceEventId,
    }))
    .sort((left, right) =>
      `${left.tenantId}|${left.capabilityId}|${left.scopeKey}`.localeCompare(
        `${right.tenantId}|${right.capabilityId}|${right.scopeKey}`,
      ),
    );
}

export interface TransitionHistoryFilter {
  readonly tenantId?: string;
  readonly capabilityId?: CapabilityId;
  readonly scopeKey?: string;
}

/** Console API: ordered transition history (input order = log order). */
export function transitionHistory(
  events: readonly CapabilityTransitionEvent[],
  filter: TransitionHistoryFilter = {},
): readonly CapabilityTransitionEvent[] {
  return events.filter(
    (event) =>
      (filter.tenantId === undefined || event.tenantId === filter.tenantId) &&
      (filter.capabilityId === undefined || event.capabilityId === filter.capabilityId) &&
      (filter.scopeKey === undefined || canonicalScopeKey(event.scope) === filter.scopeKey),
  );
}

export interface CapabilityEdgeViolation {
  readonly constraintId: string;
  readonly tenantId: string;
  readonly capabilityId: CapabilityId;
  readonly scopeKey: string;
  readonly message: string;
}

/**
 * Standing consistency check: a prerequisite revoked or rolled back AFTER a
 * dependent climbed past its ceiling leaves the dependent in violation — this
 * surfaces it (console health feed; a rail's health-state change must block
 * dependents, REQ-PLAT-012 AC-3). Parameterized (IC-6-style) edges resolve
 * their prerequisite from the dependent grant's minting event; a grant whose
 * event no longer resolves fails closed into the violation list.
 */
export function listCapabilityEdgeViolations(
  registry: CapabilityRegistry,
  grants: readonly CapabilityGrant[],
  events: readonly CapabilityTransitionEvent[] = [],
): readonly CapabilityEdgeViolation[] {
  const violations: CapabilityEdgeViolation[] = [];
  for (const edge of registry.edges) {
    for (const grant of grants) {
      if (grant.capabilityId !== edge.dependentCapabilityId) {
        continue;
      }
      if (
        capabilityWriteAuthorityLevel[grant.state] <=
        capabilityWriteAuthorityLevel[edge.maxDependentStateWithoutPrerequisite]
      ) {
        continue;
      }
      let prerequisiteId: CapabilityId | undefined;
      if (edge.prerequisiteCapabilityId === targetModuleCapabilityToken) {
        prerequisiteId = events.find(
          (event) => event.eventId === grant.sinceEventId,
        )?.targetCapabilityId;
      } else {
        prerequisiteId = edge.prerequisiteCapabilityId;
      }
      let satisfied = false;
      if (prerequisiteId !== undefined) {
        try {
          const prerequisite = resolveCapabilityGrant(
            registry,
            grants,
            { tenantId: grant.tenantId, scope: grant.scope },
            prerequisiteId,
          );
          satisfied =
            prerequisite !== undefined &&
            capabilityStateSatisfies(prerequisite.state, edge.minimumPrerequisiteState);
        } catch {
          satisfied = false;
        }
      }
      if (!satisfied) {
        violations.push({
          constraintId: edge.constraintId,
          tenantId: grant.tenantId,
          capabilityId: grant.capabilityId,
          scopeKey: canonicalScopeKey(grant.scope),
          message:
            `${edge.constraintId}: ${grant.capabilityId} sits at ${grant.state} while ` +
            `${prerequisiteId ?? edge.prerequisiteCapabilityId} is unavailable or below ` +
            `${edge.minimumPrerequisiteState} (${edge.requiredNegativeProof})`,
        });
      }
    }
  }
  return violations;
}

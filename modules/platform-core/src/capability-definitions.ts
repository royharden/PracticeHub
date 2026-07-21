/**
 * Capability registry data of record (WP-012). Contract:
 * docs/contracts/capability-registry.md (FROZEN).
 *
 * - `capabilityDefinitionsV1`: the declared capability vocabulary. Ids are
 *   frozen; each owning package finalizes ITS capability's dimension
 *   declarations by a versioned data change here plus its own tests.
 * - `capabilityEdgesV1`: exact mirror of the frozen phase-inversion register
 *   `docs/architecture/capability-edge-preconditions.csv`; the planning
 *   validator (`pnpm verify:planning`) fails on any divergence between the two.
 * - `capabilityApprovalPolicyV1`: conservative floor, `draft` pending the
 *   section-11 approval-matrix graduation (defect logged in the WP-012 ledger
 *   row) — separation of duty and evidence gating hold regardless.
 * - `syntheticCapabilitySeedV1`: the local synthetic grant/event seed; the
 *   committed seed file embeds `renderCapabilitySeedSection` output between
 *   `-- capability:generated:begin/end` markers with a drift test, and the DB
 *   suite folds the seeded events back against the seeded grants.
 */

import {
  foldCapabilityEvents,
  canonicalScopeKey,
  type CapabilityApprovalPolicy,
  type CapabilityCeiling,
  type CapabilityDefinition,
  type CapabilityEdge,
  type CapabilityGrant,
  type CapabilityRegistry,
  type CapabilityTransitionEvent,
} from './capability.js';

export const capabilityDefinitionsV1: readonly CapabilityDefinition[] = [
  {
    capabilityId: 'platform.capability-registry',
    ownerRole: 'architecture',
    dimensions: [],
    description: 'The registry itself: applying capability transitions is a governed side effect.',
  },
  {
    capabilityId: 'platform.bootstrap',
    ownerRole: 'architecture',
    dimensions: [],
    description:
      'Platform bootstrap surface; the standing opposite-state tenant proof rides on it.',
  },
  {
    capabilityId: 'rcm.rail-path',
    ownerRole: 'rcm-lead',
    dimensions: ['payer', 'provider', 'transaction', 'service'],
    requiredDimensions: ['payer', 'provider', 'transaction'],
    precedence: ['payer', 'transaction', 'provider', 'service'],
    description:
      'Payer-transaction rail capability (REQ-PLAT-012): every payer x provider x transaction ' +
      'path is independently represented; a broad grant cannot masquerade as path proof.',
  },
  {
    capabilityId: 'consent.operational',
    ownerRole: 'compliance',
    dimensions: ['channel', 'number'],
    description: 'Operational-consent authority (M03); IC-1 prerequisite.',
  },
  {
    capabilityId: 'migration.podium-port',
    ownerRole: 'vendor-mgmt',
    dimensions: ['number', 'wave'],
    description: 'Number-port migration surface (M27/M11); IC-1 dependent.',
  },
  {
    capabilityId: 'privacy.gipa-partition',
    ownerRole: 'security',
    dimensions: ['legal_entity'],
    description: 'Genetic-data partition enforcement (GIPA); IC-2 prerequisite.',
  },
  {
    capabilityId: 'membership.employer-surfaces',
    ownerRole: 'compliance',
    dimensions: ['legal_entity', 'cohort'],
    description: 'Employer-facing membership surfaces; IC-2 dependent.',
  },
  {
    capabilityId: 'membership.entitlement-ledger',
    ownerRole: 'sponsor',
    dimensions: [],
    description: 'App-owned entitlement ledger authority; IC-3 prerequisite.',
  },
  {
    capabilityId: 'finance.billing-authority',
    ownerRole: 'rcm-lead',
    dimensions: ['payer'],
    description: 'Billing/statement issuing authority; IC-3 dependent.',
  },
  {
    capabilityId: 'migration.workbench',
    ownerRole: 'data-migration',
    dimensions: [],
    description: 'Migration workbench validation surface; IC-4/IC-6 prerequisite side.',
  },
  {
    capabilityId: 'migration.acquisition-rehearsal',
    ownerRole: 'data-migration',
    dimensions: ['wave'],
    description: 'Synthetic full-acquisition rehearsal; IC-4 dependent.',
  },
  {
    capabilityId: 'governance.authority-matrix',
    ownerRole: 'architecture',
    dimensions: [],
    description: 'Versioned command/field/lifecycle authority matrix (WP-036); IC-5 prerequisite.',
  },
  {
    capabilityId: 'governance.authority-bearing-write',
    ownerRole: 'architecture',
    dimensions: ['era', 'wave'],
    description: 'Authority-row transition surface; IC-5 dependent.',
  },
  {
    capabilityId: 'migration.wave-import',
    ownerRole: 'data-migration',
    dimensions: ['wave'],
    description: 'Wave-scoped data import; IC-6 dependent (prerequisite is the target module).',
  },
  {
    capabilityId: 'identity.person-model',
    ownerRole: 'security',
    dimensions: [],
    description:
      'Person/roles/endpoints/source-id crosswalk model (M02, WP-013); the IC-6 target-module ' +
      'grant identity-bound wave imports check.',
  },
  {
    capabilityId: 'identity.authn',
    ownerRole: 'security',
    dimensions: [],
    description:
      'Platform-owned authentication (M02, WP-014): sessions, MFA, portal magic-link/OTP, ' +
      'lockout/ATO machinery. Session issuance commands floor at simulated.',
  },
  {
    capabilityId: 'identity.merge-governance',
    ownerRole: 'security',
    dimensions: [],
    description:
      'Merge governance (M02, WP-016): merge cases, reversible merge/unmerge with lineage, ' +
      'cache invalidation. Merge/unmerge commands floor at simulated.',
  },
  {
    capabilityId: 'platform.audit-store',
    ownerRole: 'security',
    dimensions: [],
    description:
      'Audit-evidence store (M04, WP-020): hash-chained append-only streams, retention ' +
      'schedules, legal holds. Governance commands (destruction, hold release) floor at ' +
      'simulated; audit.emit itself is never capability-gated.',
  },
  {
    capabilityId: 'identity.access-policy',
    ownerRole: 'security',
    dimensions: [],
    description:
      'Policy decision point (M02, WP-015): role templates, proxy/guardian authority, ' +
      'GIPA partition enforcement, deceased chart lock. Authority-increasing commands ' +
      'floor at simulated; protective revocations are never gate-blocked.',
  },
  {
    capabilityId: 'platform.event-spine',
    ownerRole: 'architecture',
    dimensions: [],
    description:
      'Platform event spine (M05, WP-021): transactional outbox, per-consumer inbox ' +
      'dedup, replay/reconciliation. Replay commands floor at simulated; an enqueue ' +
      "rides the producing command's own capability, and the drain re-checks each " +
      "event's consumer capability at checkpoint drain. audit.emit over the outbox is " +
      'never gated.',
  },
];

/** Exact mirror of docs/architecture/capability-edge-preconditions.csv (FROZEN). */
export const capabilityEdgesV1: readonly CapabilityEdge[] = [
  {
    constraintId: 'IC-1',
    prerequisiteCapabilityId: 'consent.operational',
    minimumPrerequisiteState: 'simulated',
    dependentCapabilityId: 'migration.podium-port',
    maxDependentStateWithoutPrerequisite: 'pilot',
    requiredNegativeProof:
      'port transmission denied when operational consent is unavailable or revoked',
  },
  {
    constraintId: 'IC-2',
    prerequisiteCapabilityId: 'privacy.gipa-partition',
    minimumPrerequisiteState: 'simulated',
    dependentCapabilityId: 'membership.employer-surfaces',
    maxDependentStateWithoutPrerequisite: 'scaffolded',
    requiredNegativeProof: 'employer surface denied when the genetic partition grant is absent',
  },
  {
    constraintId: 'IC-3',
    prerequisiteCapabilityId: 'membership.entitlement-ledger',
    minimumPrerequisiteState: 'simulated',
    dependentCapabilityId: 'finance.billing-authority',
    maxDependentStateWithoutPrerequisite: 'scaffolded',
    requiredNegativeProof: 'billing and statements denied when entitlement authority is absent',
  },
  {
    constraintId: 'IC-4',
    prerequisiteCapabilityId: 'migration.workbench',
    minimumPrerequisiteState: 'simulated',
    dependentCapabilityId: 'migration.acquisition-rehearsal',
    maxDependentStateWithoutPrerequisite: 'scaffolded',
    requiredNegativeProof: 'acquisition rehearsal denied without workbench validation evidence',
  },
  {
    constraintId: 'IC-5',
    prerequisiteCapabilityId: 'governance.authority-matrix',
    minimumPrerequisiteState: 'scaffolded',
    dependentCapabilityId: 'governance.authority-bearing-write',
    maxDependentStateWithoutPrerequisite: 'shadow',
    requiredNegativeProof: 'authority row transition denied without a matching capability grant',
  },
  {
    constraintId: 'IC-6',
    prerequisiteCapabilityId: 'target-module.capability',
    minimumPrerequisiteState: 'scaffolded',
    dependentCapabilityId: 'migration.wave-import',
    maxDependentStateWithoutPrerequisite: 'scaffolded',
    requiredNegativeProof: 'wave import denied when the target module capability grant is absent',
  },
];

/**
 * External-wait ceilings register: empty at WP-012. The package that owns an
 * affected capability adds its ceiling row (planning/external-waits.csv holds
 * the private register; the ceiling here is the executable form).
 */
export const capabilityCeilingsV1: readonly CapabilityCeiling[] = [];

export const capabilityApprovalPolicyV1: CapabilityApprovalPolicy = {
  version: 1,
  status: 'draft',
  pendingRef: 'section-11-approval-matrix-graduation',
  authorityApprovalMinimum: 1,
  rehearsedRollbackEvidencePrefix: 'rollback-rehearsal:',
};

export const capabilityRegistryV1: CapabilityRegistry = {
  version: 1,
  definitions: capabilityDefinitionsV1,
  edges: capabilityEdgesV1,
  ceilings: capabilityCeilingsV1,
  approvalPolicy: capabilityApprovalPolicyV1,
};

export interface CapabilitySeed {
  /** Declared initial states no transition produced (opposite-state tenant proof). */
  readonly initialGrants: readonly CapabilityGrant[];
  /** Ordered transition log; the seeded grant projection is its fold. */
  readonly events: readonly CapabilityTransitionEvent[];
}

const northwind = 'northwind-synthetic';
const riverbend = 'riverbend-synthetic';
const initiator = 'synthetic-platform-bootstrap';
const approver = { approverRef: 'synthetic-architecture-owner', role: 'architecture' } as const;
const railScope837 = {
  payer: 'synthetic-payer-aurora',
  provider: 'synthetic-dr-lee',
  transaction: 'x12-837',
} as const;
const railScope270 = {
  payer: 'synthetic-payer-aurora',
  provider: 'synthetic-dr-lee',
  transaction: 'x12-270-271',
} as const;

function chainEvent(
  eventId: string,
  capabilityId: CapabilityTransitionEvent['capabilityId'],
  scope: CapabilityTransitionEvent['scope'],
  fromState: CapabilityTransitionEvent['fromState'],
  toState: CapabilityTransitionEvent['toState'],
  evidenceRef: string,
): CapabilityTransitionEvent {
  return {
    eventId,
    tenantId: northwind,
    capabilityId,
    scope,
    fromState,
    toState,
    initiatorRef: initiator,
    approvals: [approver],
    evidenceRefs: [evidenceRef],
    rollbackRef: 'registry-event-replay',
    reason: 'synthetic bootstrap chain',
    synthetic: true,
  };
}

/**
 * Local synthetic seed: tenant 1 carries operative chains (the registry and
 * bootstrap at `simulated`, plus two independently-stated rail paths for the
 * REQ-PLAT-012 proof); tenant 2 Riverbend stays in the opposite state
 * (`disabled`, declared, no transitions) as the standing cross-tenant proof.
 */
export const syntheticCapabilitySeedV1: CapabilitySeed = {
  initialGrants: [
    {
      capabilityId: 'platform.capability-registry',
      tenantId: riverbend,
      scope: {},
      state: 'disabled',
      sinceEventId: null,
      evidenceRefs: ['synthetic-negative-control'],
      rollbackRef: 'already-disabled',
      synthetic: true,
    },
    {
      capabilityId: 'platform.bootstrap',
      tenantId: riverbend,
      scope: {},
      state: 'disabled',
      sinceEventId: null,
      evidenceRefs: ['synthetic-negative-control'],
      rollbackRef: 'already-disabled',
      synthetic: true,
    },
    {
      capabilityId: 'identity.person-model',
      tenantId: riverbend,
      scope: {},
      state: 'disabled',
      sinceEventId: null,
      evidenceRefs: ['synthetic-negative-control'],
      rollbackRef: 'already-disabled',
      synthetic: true,
    },
    {
      capabilityId: 'identity.authn',
      tenantId: riverbend,
      scope: {},
      state: 'disabled',
      sinceEventId: null,
      evidenceRefs: ['synthetic-negative-control'],
      rollbackRef: 'already-disabled',
      synthetic: true,
    },
    {
      capabilityId: 'identity.merge-governance',
      tenantId: riverbend,
      scope: {},
      state: 'disabled',
      sinceEventId: null,
      evidenceRefs: ['synthetic-negative-control'],
      rollbackRef: 'already-disabled',
      synthetic: true,
    },
    {
      capabilityId: 'platform.audit-store',
      tenantId: riverbend,
      scope: {},
      state: 'disabled',
      sinceEventId: null,
      evidenceRefs: ['synthetic-negative-control'],
      rollbackRef: 'already-disabled',
      synthetic: true,
    },
    {
      capabilityId: 'identity.access-policy',
      tenantId: riverbend,
      scope: {},
      state: 'disabled',
      sinceEventId: null,
      evidenceRefs: ['synthetic-negative-control'],
      rollbackRef: 'already-disabled',
      synthetic: true,
    },
    {
      capabilityId: 'privacy.gipa-partition',
      tenantId: riverbend,
      scope: {},
      state: 'disabled',
      sinceEventId: null,
      evidenceRefs: ['synthetic-negative-control'],
      rollbackRef: 'already-disabled',
      synthetic: true,
    },
    {
      capabilityId: 'consent.operational',
      tenantId: riverbend,
      scope: {},
      state: 'disabled',
      sinceEventId: null,
      evidenceRefs: ['synthetic-negative-control'],
      rollbackRef: 'already-disabled',
      synthetic: true,
    },
    {
      capabilityId: 'platform.event-spine',
      tenantId: riverbend,
      scope: {},
      state: 'disabled',
      sinceEventId: null,
      evidenceRefs: ['synthetic-negative-control'],
      rollbackRef: 'already-disabled',
      synthetic: true,
    },
  ],
  events: [
    chainEvent(
      'synthetic-cap-evt-0001',
      'platform.capability-registry',
      {},
      'disabled',
      'scaffolded',
      'synthetic-gate:wp-012-registry-scaffold',
    ),
    chainEvent(
      'synthetic-cap-evt-0002',
      'platform.capability-registry',
      {},
      'scaffolded',
      'simulated',
      'synthetic-gate:wp-012-registry-simulated',
    ),
    chainEvent(
      'synthetic-cap-evt-0003',
      'platform.bootstrap',
      {},
      'disabled',
      'scaffolded',
      'synthetic-gate:plan-000-bootstrap-scaffold',
    ),
    chainEvent(
      'synthetic-cap-evt-0004',
      'platform.bootstrap',
      {},
      'scaffolded',
      'simulated',
      'synthetic-gate:plan-000-bootstrap-simulated',
    ),
    chainEvent(
      'synthetic-cap-evt-0005',
      'rcm.rail-path',
      railScope837,
      'disabled',
      'scaffolded',
      'synthetic-gate:rail-837-scaffold',
    ),
    chainEvent(
      'synthetic-cap-evt-0006',
      'rcm.rail-path',
      railScope837,
      'scaffolded',
      'simulated',
      'synthetic-gate:rail-837-sim-conformance',
    ),
    chainEvent(
      'synthetic-cap-evt-0007',
      'rcm.rail-path',
      railScope270,
      'disabled',
      'scaffolded',
      'synthetic-gate:rail-270-271-scaffold',
    ),
    // WP-013: the identity model lands at its package ceiling — `scaffolded`.
    // The activation walk to `simulated` belongs to the package that takes
    // M02 into the reference loops; the register-identity command (floored at
    // `simulated`) therefore DENIES against this seed, by design.
    chainEvent(
      'synthetic-cap-evt-0008',
      'identity.person-model',
      {},
      'disabled',
      'scaffolded',
      'synthetic-gate:wp-013-identity-scaffold',
    ),
    // WP-014: authn lands at its package ceiling — `scaffolded`. The
    // issue-session command (floored at `simulated`) therefore DENIES against
    // this seed, by design; Riverbend stays the opposite-state proof.
    chainEvent(
      'synthetic-cap-evt-0009',
      'identity.authn',
      {},
      'disabled',
      'scaffolded',
      'synthetic-gate:wp-014-authn-scaffold',
    ),
    // WP-016: merge governance lands at its package ceiling — `scaffolded`.
    // The merge/unmerge commands (floored at `simulated`) therefore DENY
    // against this seed, by design; Riverbend stays the opposite-state proof.
    chainEvent(
      'synthetic-cap-evt-0010',
      'identity.merge-governance',
      {},
      'disabled',
      'scaffolded',
      'synthetic-gate:wp-016-merge-scaffold',
    ),
    // WP-020: the audit store lands at its package ceiling — `scaffolded`.
    // The governance commands (floored at `simulated`) therefore DENY against
    // this seed, by design; audit.emit is never gated. Riverbend stays the
    // opposite-state proof.
    chainEvent(
      'synthetic-cap-evt-0011',
      'platform.audit-store',
      {},
      'disabled',
      'scaffolded',
      'synthetic-gate:wp-020-audit-scaffold',
    ),
    // WP-015: the PDP lands at its package ceiling — `scaffolded`. The
    // authority-increasing commands (floored at `simulated`) therefore DENY
    // against this seed, by design; Riverbend stays the opposite-state proof.
    chainEvent(
      'synthetic-cap-evt-0012',
      'identity.access-policy',
      {},
      'disabled',
      'scaffolded',
      'synthetic-gate:wp-015-pdp-scaffold',
    ),
    // WP-015: the GIPA partition enforcement substance ships with the PDP,
    // so its capability (declared by WP-012 as the IC-2 prerequisite) lands
    // at `scaffolded` too. IC-2 requires `simulated`, so employer surfaces
    // stay capped at `scaffolded` until the loop package walks it up with
    // partition-fuzzing evidence.
    chainEvent(
      'synthetic-cap-evt-0013',
      'privacy.gipa-partition',
      {},
      'disabled',
      'scaffolded',
      'synthetic-gate:wp-015-gipa-partition-scaffold',
    ),
    // WP-018: the consent ledger lands at its package ceiling — `scaffolded`.
    // The recordConsentGrant command (floored at `simulated`) therefore DENIES
    // against this seed, by design; protective revoke/expire/block and canSend
    // are never gated. Riverbend stays the opposite-state proof. This is the
    // IC-1 prerequisite (podium number porting stays capped until it walks up).
    chainEvent(
      'synthetic-cap-evt-0014',
      'consent.operational',
      {},
      'disabled',
      'scaffolded',
      'synthetic-gate:wp-018-consent-scaffold',
    ),
    // WP-021: the event spine lands at its package ceiling — `scaffolded`. The
    // replay-outbox command (floored at `simulated`) therefore DENIES against
    // this seed, by design; enqueue rides a producing command's own capability,
    // the drain re-checks each event's consumer capability, and audit.emit over
    // the outbox is never gated. Riverbend stays the opposite-state proof.
    chainEvent(
      'synthetic-cap-evt-0015',
      'platform.event-spine',
      {},
      'disabled',
      'scaffolded',
      'synthetic-gate:wp-021-event-spine-scaffold',
    ),
  ],
};

export const capabilitySeedBeginMarker = '-- capability:generated:begin';
export const capabilitySeedEndMarker = '-- capability:generated:end';

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqlJson = (value: unknown): string => `${sqlLiteral(JSON.stringify(value))}::jsonb`;
const sqlOptional = (value: string | undefined): string =>
  value === undefined ? 'NULL' : sqlLiteral(value);

/**
 * Render the synthetic seed as idempotent SQL. Events insert with
 * ON CONFLICT DO NOTHING (the log is append-only; re-seeding never rewrites
 * history); grants are the fold of the event log over the declared initial
 * grants — one data source, drift-tested in the unit suite and re-proven
 * against the database by the DB suite's projection-sync test.
 */
export function renderCapabilitySeedSection(
  registry: CapabilityRegistry,
  seed: CapabilitySeed,
): string {
  const eventRows = seed.events.map(
    (event) =>
      `  (${sqlLiteral(event.eventId)}, ${sqlLiteral(event.tenantId)}, ` +
      `${sqlLiteral(event.capabilityId)}, ${sqlJson(event.scope)}, ` +
      `${sqlLiteral(canonicalScopeKey(event.scope))}, ${sqlLiteral(event.fromState)}, ` +
      `${sqlLiteral(event.toState)}, ${sqlLiteral(event.initiatorRef)}, ` +
      `${sqlJson(event.approvals)}, ${sqlJson(event.evidenceRefs)}, ` +
      `${sqlLiteral(event.rollbackRef)}, ${sqlOptional(event.reviewRef)}, ` +
      `${sqlOptional(event.targetCapabilityId)}, ${sqlOptional(event.reason)}, true)`,
  );
  const grants = [...seed.initialGrants, ...foldCapabilityEvents(registry, [], seed.events)];
  const grantRows = [...grants]
    .sort((left, right) =>
      `${left.tenantId}|${left.capabilityId}|${canonicalScopeKey(left.scope)}`.localeCompare(
        `${right.tenantId}|${right.capabilityId}|${canonicalScopeKey(right.scope)}`,
      ),
    )
    .map(
      (grant) =>
        `  (${sqlLiteral(grant.tenantId)}, ${sqlLiteral(grant.capabilityId)}, ` +
        `${sqlJson(grant.scope)}, ${sqlLiteral(canonicalScopeKey(grant.scope))}, ` +
        `${sqlLiteral(grant.state)}, ${sqlOptional(grant.sinceEventId ?? undefined)}, ` +
        `${sqlJson(grant.evidenceRefs)}, ${sqlLiteral(grant.rollbackRef)}, true)`,
    );
  return [
    capabilitySeedBeginMarker,
    '-- Generated by @practicehub/platform-core renderCapabilitySeedSection from',
    '-- syntheticCapabilitySeedV1. Regenerate on any seed change; the drift test',
    '-- and the DB projection-sync test fail on divergence.',
    'INSERT INTO platform_core.capability_event',
    '  (event_id, tenant_id, capability_id, scope, scope_key, from_state, to_state,',
    '   initiator_ref, approvals, evidence_refs, rollback_ref, review_ref,',
    '   target_capability_id, reason, synthetic)',
    'VALUES',
    eventRows.join(',\n'),
    'ON CONFLICT (event_id) DO NOTHING;',
    '',
    'INSERT INTO platform_core.capability_grant',
    '  (tenant_id, capability_id, scope, scope_key, state, since_event_id,',
    '   evidence_refs, rollback_ref, synthetic)',
    'VALUES',
    grantRows.join(',\n'),
    'ON CONFLICT (tenant_id, capability_id, scope_key) DO UPDATE',
    'SET scope = EXCLUDED.scope,',
    '    state = EXCLUDED.state,',
    '    since_event_id = EXCLUDED.since_event_id,',
    '    evidence_refs = EXCLUDED.evidence_refs,',
    '    rollback_ref = EXCLUDED.rollback_ref,',
    '    synthetic = EXCLUDED.synthetic;',
    capabilitySeedEndMarker,
  ].join('\n');
}

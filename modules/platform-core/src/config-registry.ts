import type { LegalEntityId, LocationId, TenancyContext, TenantId } from '@practicehub/contracts';

import { assertTenancyId, TenancyInvariantError } from './tenancy.js';

/** Frozen namespace list — extending it is a contract revision (tenancy-types.md). */
export const configNamespaces = [
  'branding',
  'sending-identity',
  'portal-domain',
  'disclosure',
  'template',
  'policy',
] as const;
export type ConfigNamespace = (typeof configNamespaces)[number];

/** Config is never a PHI store: values are classed `none` or `demographic` only. */
export const configPhiClasses = ['none', 'demographic'] as const;
export type ConfigPhiClass = (typeof configPhiClasses)[number];

export interface ConfigEntry {
  readonly tenantId: TenantId;
  readonly legalEntityId?: LegalEntityId;
  readonly locationId?: LocationId;
  readonly namespace: ConfigNamespace;
  readonly key: string;
  readonly value: unknown;
  readonly phiClass: ConfigPhiClass;
  readonly counselOwned: boolean;
  readonly changeControlRef?: string;
  readonly revision: number;
  /** Actor attribution for the write (REQ-ADM-027 AC-3); required, fails closed. */
  readonly changedBy: string;
  /** Stamped by the database (`changed_at DEFAULT now()`); present on read-back. */
  readonly changedAt?: string;
}

export class ConfigRegistryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigRegistryError';
  }
}

const keyPattern = /^[a-z0-9][a-z0-9/:=*.-]{0,127}$/;
const actorRefPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Validate an entry before it is written. Fails closed on: an unknown
 * namespace, a PHI class above the config ceiling, a counsel-owned entry
 * without a change-control reference (R6-SR-110), a location scope without its
 * legal entity, a non-positive revision, or a missing change actor reference
 * (REQ-ADM-027 AC-3 attribution).
 */
export function assertConfigEntryWritable(entry: ConfigEntry): void {
  assertTenancyId(entry.tenantId, 'tenantId');
  if (!(configNamespaces as readonly string[]).includes(entry.namespace)) {
    throw new ConfigRegistryError(`unknown config namespace ${JSON.stringify(entry.namespace)}`);
  }
  if (!(configPhiClasses as readonly string[]).includes(entry.phiClass)) {
    throw new ConfigRegistryError(
      `config value class ${JSON.stringify(entry.phiClass)} exceeds the config ceiling ` +
        `(${configPhiClasses.join('/')}); config is never a PHI store`,
    );
  }
  if (!keyPattern.test(entry.key)) {
    throw new ConfigRegistryError(`config key ${JSON.stringify(entry.key)} is not a valid key`);
  }
  if (entry.locationId !== undefined && entry.legalEntityId === undefined) {
    throw new ConfigRegistryError(
      `config entry ${entry.namespace}/${entry.key} scopes to a location without its legal entity`,
    );
  }
  if (entry.counselOwned && !entry.changeControlRef) {
    throw new ConfigRegistryError(
      `counsel-owned config entry ${entry.namespace}/${entry.key} requires a ` +
        'change-control reference (R6-SR-110 fails closed)',
    );
  }
  if (!Number.isInteger(entry.revision) || entry.revision < 1) {
    throw new ConfigRegistryError(
      `config entry ${entry.namespace}/${entry.key} requires a positive integer revision`,
    );
  }
  if (typeof entry.changedBy !== 'string' || !actorRefPattern.test(entry.changedBy)) {
    throw new ConfigRegistryError(
      `config entry ${entry.namespace}/${entry.key} requires a change actor reference ` +
        '(changed-by; REQ-ADM-027 AC-3 attribution fails closed)',
    );
  }
}

function scopeSpecificity(entry: ConfigEntry): number {
  if (entry.locationId !== undefined) {
    return 2;
  }
  if (entry.legalEntityId !== undefined) {
    return 1;
  }
  return 0;
}

function scopeMatches(entry: ConfigEntry, context: TenancyContext): boolean {
  if (entry.tenantId !== context.tenantId) {
    return false;
  }
  if (entry.legalEntityId !== undefined && entry.legalEntityId !== context.legalEntityId) {
    return false;
  }
  if (entry.locationId !== undefined && entry.locationId !== context.locationId) {
    return false;
  }
  return true;
}

/**
 * Tenant-bound resolution: location scope wins over legal-entity scope wins
 * over tenant scope; within a scope the highest revision wins (entries are
 * superseded, never overwritten). Entries from another tenant are never
 * observable — the brand-leak negative in the cross-tenant suite proves it.
 */
export function resolveConfig(
  entries: readonly ConfigEntry[],
  context: TenancyContext,
  namespace: ConfigNamespace,
  key: string,
): ConfigEntry | undefined {
  return entries
    .filter(
      (entry) => entry.namespace === namespace && entry.key === key && scopeMatches(entry, context),
    )
    .sort(
      (left, right) =>
        scopeSpecificity(right) - scopeSpecificity(left) || right.revision - left.revision,
    )[0];
}

/**
 * Machine-readable acceptance-policy states (REQ-ADM-027 AC-1): the config
 * value carries one of these, never a bare boolean — `waitlist` and
 * `existing-patients-only` are first-class states, not free text.
 */
export const acceptancePolicyStates = [
  'open',
  'not-accepted',
  'panel-closed',
  'waitlist',
  'existing-patients-only',
] as const;
export type AcceptancePolicyState = (typeof acceptancePolicyStates)[number];

/** The four decision statuses the lookup returns (REQ-ADM-047 AC-1). */
export const acceptanceDecisionStatuses = [
  'accepted',
  'not-accepted',
  'panel-closed',
  'needs-verification',
] as const;
export type AcceptanceDecisionStatus = (typeof acceptanceDecisionStatuses)[number];

/**
 * Config-state → decision-status mapping for a NEW-patient lookup. `waitlist`
 * and `existing-patients-only` surface as `panel-closed` (non-permissive for
 * new patients); the matched config state rides on the decision so consumers
 * can route next steps (join waitlist, established-patient path) without
 * parsing free text.
 */
export const acceptanceDecisionStatusByState: Record<
  AcceptancePolicyState,
  AcceptanceDecisionStatus
> = {
  open: 'accepted',
  'not-accepted': 'not-accepted',
  'panel-closed': 'panel-closed',
  waitlist: 'panel-closed',
  'existing-patients-only': 'panel-closed',
};

export interface AcceptancePolicyValue {
  readonly policy: AcceptancePolicyState;
  readonly reason: string;
}

export interface AcceptancePolicyDecision {
  /** The state carrier (REQ-ADM-047 AC-1); `reason` is detail, never the state. */
  readonly status: AcceptanceDecisionStatus;
  /** Matched config state; null when no entry matched (needs-verification). */
  readonly policy: AcceptancePolicyState | null;
  /** Derived bookability: true only when `status` is `accepted`. */
  readonly accepting: boolean;
  readonly reason: string;
  readonly matchedKey: string | null;
}

export const acceptancePolicyKeyPrefix = 'accepting-new-patients';

export function acceptancePolicyKey(payerId: string, providerId: string): string {
  for (const [label, value] of [
    ['payerId', payerId],
    ['providerId', providerId],
  ] as const) {
    if (value !== '*') {
      assertTenancyId(value, label);
    }
  }
  return `${acceptancePolicyKeyPrefix}:payer=${payerId}:provider=${providerId}`;
}

function isAcceptancePolicyValue(value: unknown): value is AcceptancePolicyValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    'policy' in value &&
    typeof value.policy === 'string' &&
    (acceptancePolicyStates as readonly string[]).includes(value.policy) &&
    'reason' in value &&
    typeof value.reason === 'string'
  );
}

/**
 * Per-location × payer × provider "accepting new patients" lookup
 * (REQ-ADM-027 config, REQ-ADM-047 lookup). The most specific key wins
 * (payer+provider, then payer wildcard-provider, then wildcard-payer+provider,
 * then the location default). The `payerId` segment is an opaque payer-or-plan
 * id: a payer whose acceptance differs by plan is configured per plan-scoped
 * id and carries no bare payer-level entry, so plans are never collapsed under
 * a payer-level answer (REQ-ADM-047 exception 2; tenancy-types.md).
 *
 * Fails closed: a context without a location is an error; a combination with
 * no matching entry resolves to `needs-verification` — non-permissive for
 * booking, never a silent accept, and never a plain deny that would route the
 * patient away instead of into verification (REQ-ADM-047 exception 1). The
 * needs-verification → follow-up-task obligation is FWD-ADM-047-TASK on the
 * consuming package (tenancy-types.md §Forward obligations).
 */
export function lookupAcceptingNewPatients(
  entries: readonly ConfigEntry[],
  context: TenancyContext,
  payerId: string,
  providerId: string,
): AcceptancePolicyDecision {
  if (context.locationId === undefined) {
    throw new TenancyInvariantError(
      'accepting-new-patients lookup requires a location in the tenancy context',
    );
  }
  const candidateKeys = [
    acceptancePolicyKey(payerId, providerId),
    acceptancePolicyKey(payerId, '*'),
    acceptancePolicyKey('*', providerId),
    acceptancePolicyKey('*', '*'),
  ];
  for (const key of candidateKeys) {
    const entry = resolveConfig(entries, context, 'policy', key);
    if (entry === undefined) {
      continue;
    }
    if (!isAcceptancePolicyValue(entry.value)) {
      throw new ConfigRegistryError(
        `acceptance policy ${key} holds a malformed value; expected { policy, reason } ` +
          `with policy in ${acceptancePolicyStates.join('/')}`,
      );
    }
    const status = acceptanceDecisionStatusByState[entry.value.policy];
    return {
      status,
      policy: entry.value.policy,
      accepting: status === 'accepted',
      reason: entry.value.reason,
      matchedKey: key,
    };
  }
  return {
    status: 'needs-verification',
    policy: null,
    accepting: false,
    reason: 'no-policy-configured',
    matchedKey: null,
  };
}

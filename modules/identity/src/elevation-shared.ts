/**
 * Shared primitives for the WP-017 elevation surface (break-glass +
 * offboarding + credential-anomaly + access recertification). Contract:
 * docs/contracts/elevation-api.md (FROZEN).
 *
 * Audit inputs are defined structurally-compatible with the WP-020
 * `AuditEmitInput` WITHOUT importing `@practicehub/audit-evidence` in
 * production code (the pdp.ts / sla.ts precedent — the store is a test-time
 * devDependency; the fixture harness casts these to `AuditEmitInput` and emits
 * them through the REAL store so an invalid input cannot pass). The WorkItem
 * descriptor is structurally-compatible with the WP-022 `WorkItemOpen`
 * (origin narrowed to `authority-review`) so the test suite can drive the real
 * SLA/escalation engine over it — the live persistence into `events.work_item`
 * rides the reference loops (a cross-module write forbidden here by DB role).
 */

/** Whole-second UTC instants only — the WP-020 audit ref-grammar for `occurredAt`. */
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** WP-020 reference grammar: lower-case ids/refs, no spaces, so prose (and PHI) is refused by shape. */
const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class ElevationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ElevationError';
  }
}

export function assertInstant(value: string, label: string): void {
  if (!isoInstantPattern.test(value)) {
    throw new ElevationError(
      `${label} must be a whole-second UTC instant (…Z); received ${JSON.stringify(value)}`,
    );
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new ElevationError(`${label} is not a valid instant: ${JSON.stringify(value)}`);
  }
}

export function assertRef(value: string, label: string): void {
  if (!refPattern.test(value)) {
    throw new ElevationError(
      `${label} must match the audit ref grammar (lower-case, no spaces); ` +
        `received ${JSON.stringify(value)}`,
    );
  }
}

export function assertId(value: string, label: string): void {
  if (!idPattern.test(value)) {
    throw new ElevationError(
      `${label} must match ${idPattern.source}; received ${JSON.stringify(value)}`,
    );
  }
}

/** ISO instant `base` shifted by `minutes` (UTC, whole-second). */
export function addMinutes(baseIso: string, minutes: number): string {
  assertInstant(baseIso, 'instant');
  if (!Number.isInteger(minutes)) {
    throw new ElevationError(`minutes must be an integer; received ${JSON.stringify(minutes)}`);
  }
  const ms = Date.parse(baseIso) + minutes * 60_000;
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/** `left < right` for two whole-second UTC instants (both validated). */
export function instantBefore(left: string, right: string): boolean {
  assertInstant(left, 'instant');
  assertInstant(right, 'instant');
  return Date.parse(left) < Date.parse(right);
}

/**
 * A WorkItem OPEN descriptor (WP-022 `WorkItemOpen`, origin narrowed to
 * `authority-review`). Break-glass reviews, access-recertification attestation
 * queues, and anomaly investigations all route into the WP-022 tasking engine
 * as this origin; the descriptor is assignable to `WorkItemOpen` so the tests
 * drive the real engine. Live creation over the outbox spine rides the
 * reference loops (FWD-BREAKGLASS-030-REVIEW / FWD-PDP-022-WORKITEMS).
 */
export interface AuthorityReviewWorkItem {
  readonly workItemId: string;
  readonly origin: 'authority-review';
  readonly subjectRef: string;
  readonly purpose: string;
  readonly risk: 'routine' | 'elevated' | 'urgent' | 'critical';
  readonly serviceTier: string;
  readonly slaPolicyId: string | null;
  readonly policyVersion: number | null;
  readonly responseDueAt: string | null;
  readonly poolId: string | null;
  readonly openedAt: string;
}

/**
 * Config-change audit input (WP-020 `config-change` stream): governance/
 * workflow acts on the access-governance state (offboarding execution, anomaly
 * investigation, recertification attestation). Structurally-compatible with
 * `AuditEmitInput`; `detail.config_ref` is grammar-clean by construction.
 */
export interface ElevationConfigAuditInput {
  readonly auditId: string;
  readonly tenantId: string;
  readonly stream: 'config-change';
  readonly action: string;
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly subjectRef?: string;
  readonly detail: { readonly config_ref: string };
  readonly synthetic: true;
}

/** Build a validated config-change audit input (fail-closed on a bad ref/instant). */
export function configChangeAuditInput(input: {
  readonly auditId: string;
  readonly tenantId: string;
  readonly action: string;
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly configRef: string;
  readonly subjectRef?: string;
}): ElevationConfigAuditInput {
  assertId(input.auditId, 'auditId');
  assertRef(input.actorRef, 'actorRef');
  assertRef(input.configRef, 'config_ref');
  assertInstant(input.occurredAt, 'occurredAt');
  if (input.subjectRef !== undefined) {
    assertRef(input.subjectRef, 'subjectRef');
  }
  return {
    auditId: input.auditId,
    tenantId: input.tenantId,
    stream: 'config-change',
    action: input.action,
    actorRef: input.actorRef,
    occurredAt: input.occurredAt,
    ...(input.subjectRef !== undefined ? { subjectRef: input.subjectRef } : {}),
    detail: { config_ref: input.configRef },
    synthetic: true,
  };
}

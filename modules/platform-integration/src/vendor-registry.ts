/**
 * Vendor registry domain (WP-026, M07). Contract:
 * docs/contracts/adapter-registry-api.md (FROZEN). Architecture: ADR-014
 * (adapter framework), compliance R6-REQ-008 (BAA inventory registry) +
 * docs/compliance/baa-inventory.md.
 *
 * The registry is the data the runtime vendor-BAA egress guard reads
 * (egress-guard.ts). Every vendor in the PHI path carries a row; the row is a
 * fold of an append-only lifecycle log so BAA scope, dates, training/retention
 * clauses, and permitted PHI categories are versioned over time (REQ-PLAT-001).
 * A registry update takes effect for the guard WITHOUT a deployment — the guard
 * reads the live projection (REQ-PLAT-001 AC-6).
 *
 * Everything here is pure over caller-supplied state: the fold threads an
 * explicit event log, so tests are deterministic and the database rows are
 * exactly reproducible.
 */

/** PHI categories the guard evaluates INDEPENDENTLY — GIPA/NV-SB370/BIPA govern
 * genetic, consumer-health, and biometric data separately (baa-inventory §2). */
export const phiCategories = ['ID', 'CLIN', 'GEN', 'CHD', 'BIO', 'med', 'PAY'] as const;
export type PhiCategory = (typeof phiCategories)[number];

/** Categories whose presence means PHI (or state-regulated sensitive data) is
 * on the wire — the guard always evaluates these, whatever the PhiClass says. */
export const sensitivePhiCategories: readonly PhiCategory[] = ['CLIN', 'GEN', 'CHD', 'BIO', 'med'];

export const baaStatuses = ['required', 'executed', 'tbd'] as const;
export type BaaStatus = (typeof baaStatuses)[number];

/** Vendor functional role in the PHI path (baa-inventory scaffold table). */
export const vendorClasses = [
  'ehr',
  'crm',
  'payments',
  'cpaas',
  'voice-ai-platform',
  'voice-ai-llm',
  'voice-ai-stt',
  'voice-ai-tts',
  'telephony-carrier',
  'fax',
  'email',
  'e-signature',
  'labs',
  'erx',
  'clearinghouse',
  'analytics',
  'ai-general',
  'cloud-infra',
  'wearables',
  'genetics',
  'imaging',
] as const;
export type VendorClass = (typeof vendorClasses)[number];

export const vendorEventKinds = [
  'registered',
  'baa-executed',
  'baa-renewed',
  'category-expanded',
  'baa-lapsed',
  'suspended',
  'reinstated',
] as const;
export type VendorEventKind = (typeof vendorEventKinds)[number];

export type VendorStatus = 'active' | 'suspended';

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export class VendorRegistryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'VendorRegistryError';
  }
}

/**
 * One lifecycle event. `version` is the vendor-row version AFTER this event —
 * the fold replays events in version order. Only `category-expanded` and
 * `baa-executed`/`baa-renewed` are permission-increasing and carry
 * `approvedBy` (REQ-PLAT-001 exception: a category expansion requires
 * compliance sign-off before the guard honors it).
 */
export interface VendorRegistryEvent {
  readonly tenantId: string;
  readonly vendorId: string;
  readonly version: number;
  readonly kind: VendorEventKind;
  readonly vendorClass?: VendorClass;
  readonly isAiVendor?: boolean;
  readonly enforcementPoint?: string;
  readonly baaStatus?: BaaStatus;
  readonly baaEffective?: string;
  readonly baaExpiry?: string;
  readonly noTrainingOnPhi?: boolean;
  readonly zeroRetention?: boolean;
  readonly permittedCategories?: readonly PhiCategory[];
  readonly evidenceRef?: string;
  /** Required on permission-increasing events (compliance sign-off). */
  readonly approvedBy?: string;
  readonly occurredAt: string;
  readonly synthetic: true;
}

/** The folded current registry row the egress guard reads. */
export interface VendorRegistryRow {
  readonly tenantId: string;
  readonly vendorId: string;
  readonly vendorClass: VendorClass;
  readonly isAiVendor: boolean;
  readonly enforcementPoint: string;
  readonly baaStatus: BaaStatus;
  readonly baaEffective: string | null;
  readonly baaExpiry: string | null;
  readonly noTrainingOnPhi: boolean;
  readonly zeroRetention: boolean;
  readonly permittedCategories: readonly PhiCategory[];
  readonly status: VendorStatus;
  readonly version: number;
  readonly synthetic: true;
}

const permissionIncreasingKinds: readonly VendorEventKind[] = [
  'registered',
  'baa-executed',
  'baa-renewed',
  'category-expanded',
];

function assertId(value: string, label: string): void {
  if (!idPattern.test(value)) {
    throw new VendorRegistryError(`${label} must match ${idPattern.source}; received ${value}`);
  }
}

function assertOptionalDate(value: string | undefined, label: string): void {
  if (value !== undefined && !datePattern.test(value)) {
    throw new VendorRegistryError(`${label} must be an ISO date (YYYY-MM-DD); received ${value}`);
  }
}

export function validateVendorEvent(event: VendorRegistryEvent): void {
  assertId(event.tenantId, 'tenantId');
  assertId(event.vendorId, 'vendorId');
  if (!Number.isInteger(event.version) || event.version < 1) {
    throw new VendorRegistryError(`version must be a positive integer; received ${event.version}`);
  }
  if (!(vendorEventKinds as readonly string[]).includes(event.kind)) {
    throw new VendorRegistryError(`unknown vendor event kind ${JSON.stringify(event.kind)}`);
  }
  if (
    event.vendorClass !== undefined &&
    !(vendorClasses as readonly string[]).includes(event.vendorClass)
  ) {
    throw new VendorRegistryError(`unknown vendor class ${JSON.stringify(event.vendorClass)}`);
  }
  if (
    event.baaStatus !== undefined &&
    !(baaStatuses as readonly string[]).includes(event.baaStatus)
  ) {
    throw new VendorRegistryError(`unknown baa status ${JSON.stringify(event.baaStatus)}`);
  }
  assertOptionalDate(event.baaEffective, 'baaEffective');
  assertOptionalDate(event.baaExpiry, 'baaExpiry');
  for (const category of event.permittedCategories ?? []) {
    if (!(phiCategories as readonly string[]).includes(category)) {
      throw new VendorRegistryError(`unknown PHI category ${JSON.stringify(category)}`);
    }
  }
  if (event.evidenceRef !== undefined && !refPattern.test(event.evidenceRef)) {
    throw new VendorRegistryError(
      `evidenceRef must match the ref grammar; received ${event.evidenceRef}`,
    );
  }
  if (event.approvedBy !== undefined && !refPattern.test(event.approvedBy)) {
    throw new VendorRegistryError(
      `approvedBy must match the ref grammar; received ${event.approvedBy}`,
    );
  }
  // A permission-increasing event must name who approved it — the guard never
  // honors an expanded permission that no accountable owner signed off
  // (REQ-PLAT-001 exception 4).
  if (permissionIncreasingKinds.includes(event.kind) && event.approvedBy === undefined) {
    throw new VendorRegistryError(
      `${event.kind} is permission-increasing and requires approvedBy (compliance sign-off)`,
    );
  }
  if (event.kind === 'registered') {
    if (
      event.vendorClass === undefined ||
      event.isAiVendor === undefined ||
      event.enforcementPoint === undefined
    ) {
      throw new VendorRegistryError(
        'a registered event must declare vendorClass, isAiVendor, and enforcementPoint',
      );
    }
  }
}

function applyVendorEvent(
  current: VendorRegistryRow | undefined,
  event: VendorRegistryEvent,
): VendorRegistryRow {
  validateVendorEvent(event);
  if (event.kind === 'registered') {
    if (current !== undefined) {
      throw new VendorRegistryError(`vendor ${event.vendorId} is already registered`);
    }
    return {
      tenantId: event.tenantId,
      vendorId: event.vendorId,
      vendorClass: event.vendorClass as VendorClass,
      isAiVendor: event.isAiVendor as boolean,
      enforcementPoint: event.enforcementPoint as string,
      baaStatus: event.baaStatus ?? 'required',
      baaEffective: event.baaEffective ?? null,
      baaExpiry: event.baaExpiry ?? null,
      noTrainingOnPhi: event.noTrainingOnPhi ?? false,
      zeroRetention: event.zeroRetention ?? false,
      permittedCategories: [...new Set(event.permittedCategories ?? [])],
      status: 'active',
      version: event.version,
      synthetic: true,
    };
  }
  if (current === undefined) {
    throw new VendorRegistryError(
      `vendor ${event.vendorId} has no registered event before ${event.kind}`,
    );
  }
  const base = { ...current, version: event.version };
  switch (event.kind) {
    case 'baa-executed':
      return {
        ...base,
        baaStatus: 'executed',
        baaEffective: event.baaEffective ?? base.baaEffective,
        baaExpiry: event.baaExpiry ?? base.baaExpiry,
        noTrainingOnPhi: event.noTrainingOnPhi ?? base.noTrainingOnPhi,
        zeroRetention: event.zeroRetention ?? base.zeroRetention,
      };
    case 'baa-renewed':
      return {
        ...base,
        baaStatus: 'executed',
        status: 'active',
        baaEffective: event.baaEffective ?? base.baaEffective,
        baaExpiry: event.baaExpiry ?? base.baaExpiry,
      };
    case 'category-expanded':
      return {
        ...base,
        permittedCategories: [
          ...new Set([...base.permittedCategories, ...(event.permittedCategories ?? [])]),
        ],
        ...(event.noTrainingOnPhi !== undefined ? { noTrainingOnPhi: event.noTrainingOnPhi } : {}),
        ...(event.zeroRetention !== undefined ? { zeroRetention: event.zeroRetention } : {}),
      };
    case 'baa-lapsed':
      // The registry IMMEDIATELY reflects the lapse (REQ-PLAT-001 exception 2):
      // the row is suspended so the guard fails closed on the next PHI egress,
      // and the lapse is never a silent expiry.
      return { ...base, status: 'suspended' };
    case 'suspended':
      return { ...base, status: 'suspended' };
    case 'reinstated':
      return { ...base, status: 'active' };
    default:
      throw new VendorRegistryError(`unhandled vendor event kind ${JSON.stringify(event.kind)}`);
  }
}

/**
 * Fold an append-only lifecycle log into current registry rows keyed by
 * (tenant, vendor). Events are applied in version order per vendor; a gap or a
 * duplicate version is refused (the log is the single source of truth).
 */
export function foldVendorRegistry(
  events: readonly VendorRegistryEvent[],
): ReadonlyMap<string, VendorRegistryRow> {
  const byVendor = new Map<string, VendorRegistryEvent[]>();
  for (const event of events) {
    const key = `${event.tenantId}|${event.vendorId}`;
    const list = byVendor.get(key);
    if (list === undefined) {
      byVendor.set(key, [event]);
    } else {
      list.push(event);
    }
  }
  const rows = new Map<string, VendorRegistryRow>();
  for (const [key, list] of byVendor) {
    const ordered = [...list].sort((left, right) => left.version - right.version);
    let row: VendorRegistryRow | undefined;
    let expectedVersion = 1;
    for (const event of ordered) {
      if (event.version !== expectedVersion) {
        throw new VendorRegistryError(
          `vendor ${event.vendorId} version gap: expected ${expectedVersion}, got ${event.version}`,
        );
      }
      row = applyVendorEvent(row, event);
      expectedVersion += 1;
    }
    if (row !== undefined) {
      rows.set(key, row);
    }
  }
  return rows;
}

/** Look up a vendor's current registry row (or null — the fail-closed absent case). */
export function vendorRow(
  registry: ReadonlyMap<string, VendorRegistryRow>,
  tenantId: string,
  vendorId: string,
): VendorRegistryRow | null {
  return registry.get(`${tenantId}|${vendorId}`) ?? null;
}

export interface RegistryCompletenessResult {
  readonly complete: boolean;
  /** PHI-path vendor ids lacking an executed, in-date, un-suspended BAA row. */
  readonly incomplete: readonly string[];
}

/**
 * Go-live completeness gate (REQ-PLAT-001 AC-7 / REQ-PLAT-005 AC-4): every
 * PHI-path integration must have an executed (not TBD), in-date, un-suspended
 * BAA row before that path can be enabled. `asOf` is the check date.
 */
export function registryCompleteness(
  registry: ReadonlyMap<string, VendorRegistryRow>,
  phiPathVendorIds: readonly string[],
  tenantId: string,
  asOf: string,
): RegistryCompletenessResult {
  const incomplete: string[] = [];
  for (const vendorId of phiPathVendorIds) {
    const row = registry.get(`${tenantId}|${vendorId}`);
    const ready =
      row !== undefined &&
      row.status === 'active' &&
      row.baaStatus === 'executed' &&
      row.baaEffective !== null &&
      row.baaExpiry !== null &&
      row.baaEffective <= asOf &&
      row.baaExpiry >= asOf;
    if (!ready) {
      incomplete.push(vendorId);
    }
  }
  return { complete: incomplete.length === 0, incomplete };
}

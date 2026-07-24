/**
 * The runtime vendor-BAA PHI-egress guard (WP-026, M07) — the single
 * fail-closed choke point every PHI-carrying outbound transmission passes
 * before it leaves the platform boundary. Compliance: R6-REQ-009 (egress matrix a-f),
 * R6-REQ-103 (AI vendors need no-training + zero-retention), REQ-PLAT-005,
 * REQ-PLAT-029. Contract: docs/contracts/adapter-registry-api.md (FROZEN).
 *
 * Fail-closed by construction: an absent registry row, a non-executed or
 * expired BAA, ambiguous registry data, a category the vendor is not permitted
 * for, and (for AI vendors) a missing no-training/zero-retention clause all
 * BLOCK. Only a valid, in-date, executed, un-suspended, category-permitted row
 * ALLOWS. Every decision — allow AND block — carries a PHI-FREE `disclosure`
 * audit input (vendor, category, reason; never the raw payload), so the block
 * itself becomes tamper-evident audit (R6-REQ-001 wiring). There is no code
 * path that permits a PHI egress the registry does not cover — an override is
 * structurally absent (REQ-PLAT-029 exception 3).
 */

import type { PhiClass } from '@practicehub/contracts';

import {
  sensitivePhiCategories,
  type PhiCategory,
  type VendorRegistryRow,
} from './vendor-registry.js';

export const egressBlockReasons = [
  'no-registry-row',
  'vendor-suspended',
  'baa-not-executed',
  'baa-expired',
  'baa-not-yet-effective',
  'ambiguous-registry-data',
  'category-not-permitted',
  'ai-no-training-clause',
  'ai-no-zero-retention',
] as const;
export type EgressBlockReason = (typeof egressBlockReasons)[number];

export type EgressReason = EgressBlockReason | 'permitted' | 'no-phi';

/** PHI classes that always carry protected data (the guard evaluates the row). */
const protectedPhiClasses: readonly PhiClass[] = ['PHI', 'PHI-restricted', 'secret'];

/** Partition-tag mapping: the categories GIPA/NV-SB370/BIPA govern separately. */
const partitionTagForCategory: Partial<Record<PhiCategory, 'gipa-genetic' | 'chd' | 'biometric'>> =
  {
    GEN: 'gipa-genetic',
    CHD: 'chd',
    BIO: 'biometric',
  };

/**
 * Structurally an @practicehub/audit-evidence AuditEmitInput (disclosure
 * stream). Kept local so the egress domain does not depend on audit-evidence at
 * runtime (consent-domain precedent); the fixture suite proves every decision
 * emits and chains through the real emitter.
 */
export interface EgressAuditInput {
  readonly tenantId: string;
  readonly stream: 'disclosure';
  readonly action: string;
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly decision: 'allow' | 'deny';
  readonly recipientRef: string;
  readonly purpose: string;
  readonly partitionTags?: readonly ('gipa-genetic' | 'chd' | 'biometric')[];
  readonly detail: Readonly<Record<string, string>>;
  readonly synthetic: true;
}

export interface EgressRequest {
  readonly tenantId: string;
  readonly vendorId: string;
  /** The classification of the payload being sent (drives whether the guard
   * evaluates; RSK-09, EventEnvelope.dataClassification). */
  readonly phiClass: PhiClass;
  /** The PHI categories present in the payload (evaluated independently). */
  readonly categories: readonly PhiCategory[];
  /** Egress purpose — an audit reason ref (lower-case). */
  readonly purpose: string;
  readonly asOf: string;
  readonly actorRef: string;
  readonly occurredAt: string;
}

export interface EgressDecision {
  readonly allow: boolean;
  readonly reason: EgressReason;
  /** True when a blocked PHI egress opens a compliance incident (REQ-PLAT-029). */
  readonly incidentOpened: boolean;
  readonly auditInput: EgressAuditInput;
}

/**
 * Whether a request carries protected data. PHI/PHI-restricted/secret always
 * do; so does any sensitive category (CLIN/GEN/CHD/BIO/med) whatever the class
 * label says — a mislabeled `demographic` payload that names a genetic category
 * is still guarded (fail-closed toward protection).
 */
export function carriesProtectedData(
  request: Pick<EgressRequest, 'phiClass' | 'categories'>,
): boolean {
  if (protectedPhiClasses.includes(request.phiClass)) {
    return true;
  }
  return request.categories.some((category) => sensitivePhiCategories.includes(category));
}

function partitionTagsFor(
  categories: readonly PhiCategory[],
): readonly ('gipa-genetic' | 'chd' | 'biometric')[] {
  const tags = new Set<'gipa-genetic' | 'chd' | 'biometric'>();
  for (const category of categories) {
    const tag = partitionTagForCategory[category];
    if (tag !== undefined) {
      tags.add(tag);
    }
  }
  return [...tags].sort();
}

function auditFor(request: EgressRequest, allow: boolean, reason: EgressReason): EgressAuditInput {
  const tags = partitionTagsFor(request.categories);
  return {
    tenantId: request.tenantId,
    stream: 'disclosure',
    action: allow ? 'vendor-egress-allowed' : 'vendor-egress-blocked',
    actorRef: request.actorRef,
    occurredAt: request.occurredAt,
    decision: allow ? 'allow' : 'deny',
    recipientRef: `vendor:${request.vendorId}`,
    purpose: request.purpose,
    ...(tags.length > 0 ? { partitionTags: tags } : {}),
    detail: {
      // Detail values are lower-case refs (the audit ref grammar forbids upper
      // case / prose): the class label and category codes are lower-cased.
      vendor_id: request.vendorId,
      phi_class: request.phiClass.toLowerCase(),
      categories:
        request.categories
          .map((category) => category.toLowerCase())
          .sort()
          .join('-') || 'none',
      reason,
    },
    synthetic: true,
  };
}

/**
 * evaluateEgress — the FROZEN fail-closed resolution order. The first failing
 * check decides the block reason; only a clean pass through every check allows.
 * `row` is the LIVE registry projection (a registry update takes effect here
 * with no deployment) or null when the vendor has no row (fail-closed absent).
 *
 * The egress matrix (R6-REQ-009 / baa-inventory §Verification):
 *   (a) PHI -> executed, in-date, permitted-category vendor -> ALLOW + log;
 *   (b) PHI -> vendor with no row -> BLOCK (no-registry-row) + log + incident;
 *   (c) PHI -> AI vendor missing no-training/zero-retention -> BLOCK;
 *   (d) PHI -> expired-BAA vendor -> BLOCK (fail-closed);
 *   (e) GEN -> vendor permitted only for CLIN -> BLOCK (category independent);
 *   (f) CHD -> vendor without CHD permission -> BLOCK.
 */
export function evaluateEgress(
  row: VendorRegistryRow | null,
  request: EgressRequest,
): EgressDecision {
  const allow = (reason: EgressReason): EgressDecision => ({
    allow: true,
    reason,
    incidentOpened: false,
    auditInput: auditFor(request, true, reason),
  });
  const block = (reason: EgressBlockReason): EgressDecision => ({
    allow: false,
    reason,
    // A blocked PHI egress to an uncovered vendor opens a compliance incident
    // and starts a remediation clock (REQ-PLAT-029; live clock wiring rides
    // FWD-INTEGRATION-019-CLOCK).
    incidentOpened: true,
    auditInput: auditFor(request, false, reason),
  });

  // Nothing protected on the wire — the guard is a no-op (never blocks a
  // non-PHI send), but the decision is still recorded for the activity feed.
  if (!carriesProtectedData(request)) {
    return allow('no-phi');
  }

  // (b) Absent row — fail closed.
  if (row === null) {
    return block('no-registry-row');
  }
  // The lapse/suspension posture is reflected in the row (REQ-PLAT-001 ex 2).
  if (row.status === 'suspended') {
    return block('vendor-suspended');
  }
  // (d)-adjacent: a non-executed BAA (required/tbd) never receives PHI.
  if (row.baaStatus !== 'executed') {
    return block('baa-not-executed');
  }
  // Stale/incorrect registry data fails closed rather than trusting the row
  // (REQ-PLAT-005 exception 3): an executed BAA with no dates, or an inverted
  // window, is ambiguous.
  if (row.baaEffective === null || row.baaExpiry === null || row.baaEffective > row.baaExpiry) {
    return block('ambiguous-registry-data');
  }
  // (d) Expired BAA — fail closed the moment it lapses (REQ-PLAT-029 AC-1).
  if (row.baaExpiry < request.asOf) {
    return block('baa-expired');
  }
  if (row.baaEffective > request.asOf) {
    return block('baa-not-yet-effective');
  }
  // (e)/(f) Category permissions evaluated INDEPENDENTLY — a CLIN-only vendor
  // is blocked from GEN/CHD/BIO/med even with a valid BAA.
  for (const category of request.categories) {
    if (!row.permittedCategories.includes(category)) {
      return block('category-not-permitted');
    }
  }
  // (c) AI vendors carrying PHI need BOTH clauses (R6-REQ-103); a previously
  // permitted AI vendor later found lacking a clause is blocked here.
  if (row.isAiVendor) {
    if (!row.noTrainingOnPhi) {
      return block('ai-no-training-clause');
    }
    if (!row.zeroRetention) {
      return block('ai-no-zero-retention');
    }
  }
  // (a) All checks pass — allow, recorded to the activity feed.
  return allow('permitted');
}

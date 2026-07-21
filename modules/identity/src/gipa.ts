/**
 * GIPA genetic partition (WP-015; REQ-ID-019 — the IC-2 substance).
 * Contract: docs/contracts/pdp-api.md (FROZEN) decision 7.
 *
 * Structural, not procedural: the employer surface query type has no field
 * that can NAME genetic data; records exports exclude genetic by default and
 * re-check a specific, dated, written, unexpired authorization at SEND time;
 * unclassifiable migrated data quarantines before any downstream release.
 * The floor jurisdiction pack unions `gipa-written-authorization` /
 * `genetic-partition` / `employer-carve-out` into EVERY resolution, so the
 * partition posture is jurisdiction-independent by data.
 */

import type { LegalEntityId, PersonId } from '@practicehub/contracts';

import { PdpInvariantError, type AccessPartitionTag } from './access-vocabulary.js';
import { assertIdentityId } from './identity.js';

/* ------------------------------------------------------------------ *
 * Classification at ingestion (AC-1 / AC-4 / EX-1)                    *
 * ------------------------------------------------------------------ */

export const geneticElementKinds = [
  'genetic-test-result',
  'family-history',
  'carrier-status',
  'pharmacogenomic-marker',
] as const;
export type GeneticElementKind = (typeof geneticElementKinds)[number];

/** Every ingestion path the coverage audit must confirm (AC-4). */
export const geneticIngestionPaths = [
  'manual-entry',
  'migration-workbench',
  'lab-interface',
  'pa-payload',
] as const;
export type GeneticIngestionPath = (typeof geneticIngestionPaths)[number];

export type ClassificationOutcome =
  | {
      readonly tagged: true;
      readonly tag: 'gipa-genetic';
      readonly reviewStatus:
        'auto-confirmed' | 'manually-confirmed' | 'needs-classification-review';
      /** needs-review data NEVER releases downstream until reviewed (EX-1). */
      readonly blockedFromRelease: boolean;
    }
  | { readonly tagged: false };

export function classifyDataElement(element: {
  readonly kind: string;
  readonly path: GeneticIngestionPath;
  /** False for legacy migrated data that cannot be reliably classified. */
  readonly reliablyClassifiable: boolean;
  readonly manuallyConfirmed?: boolean;
}): ClassificationOutcome {
  if (!(geneticIngestionPaths as readonly string[]).includes(element.path)) {
    throw new PdpInvariantError(`unknown ingestion path ${JSON.stringify(element.path)}`);
  }
  const matchesGenetic = (geneticElementKinds as readonly string[]).includes(element.kind);
  if (!matchesGenetic && element.reliablyClassifiable) {
    return { tagged: false };
  }
  if (!element.reliablyClassifiable) {
    // Never defaults to "not genetic": unreliable classification quarantines
    // for manual compliance review before ANY downstream surface (EX-1).
    return {
      tagged: true,
      tag: 'gipa-genetic',
      reviewStatus: 'needs-classification-review',
      blockedFromRelease: true,
    };
  }
  return {
    tagged: true,
    tag: 'gipa-genetic',
    reviewStatus: element.manuallyConfirmed === true ? 'manually-confirmed' : 'auto-confirmed',
    blockedFromRelease: false,
  };
}

/** The compliance coverage audit (AC-4): every path, not just one. */
export function auditGeneticCoverage(coveredPaths: readonly GeneticIngestionPath[]): {
  readonly complete: boolean;
  readonly missingPaths: readonly GeneticIngestionPath[];
} {
  const missing = geneticIngestionPaths.filter((path) => !coveredPaths.includes(path));
  return { complete: missing.length === 0, missingPaths: missing };
}

/* ------------------------------------------------------------------ *
 * GIPA authorization + records export (AC-3 / EX-2 / EX-4)            *
 * ------------------------------------------------------------------ */

export interface GipaAuthorization {
  readonly authorizationId: string;
  readonly tenantId: string;
  readonly subjectPersonId: PersonId;
  /** What the written authorization specifically covers. */
  readonly scopeRef: string;
  readonly grantedOn: string;
  readonly expiresOn: string;
  readonly writtenEvidenceRef: string;
  readonly status: 'active' | 'revoked';
  readonly synthetic: boolean;
}

export function assertGipaAuthorizationWellFormed(authorization: GipaAuthorization): void {
  assertIdentityId(authorization.tenantId, 'tenantId');
  assertIdentityId(authorization.authorizationId, 'authorizationId');
  if (!authorization.writtenEvidenceRef) {
    throw new PdpInvariantError(
      `GIPA authorization ${authorization.authorizationId} must reference its WRITTEN artifact`,
    );
  }
  if (!authorization.grantedOn || !authorization.expiresOn) {
    throw new PdpInvariantError(
      `GIPA authorization ${authorization.authorizationId} is specific and DATED by ` +
        'construction — granted and expiry dates are required',
    );
  }
}

/** Valid = active, granted on/before, unexpired AT THE EVALUATED INSTANT. */
export function findValidGipaAuthorization(
  authorizations: readonly GipaAuthorization[],
  subjectPersonId: PersonId,
  asOfDate: string,
): GipaAuthorization | undefined {
  return authorizations.find(
    (authorization) =>
      authorization.subjectPersonId === subjectPersonId &&
      authorization.status === 'active' &&
      authorization.grantedOn <= asOfDate &&
      asOfDate < authorization.expiresOn,
  );
}

export interface ExportItem {
  readonly artifactRef: string;
  readonly partitionTags: readonly AccessPartitionTag[];
}

export interface RecordsExportAssembly {
  readonly included: readonly ExportItem[];
  readonly excludedGenetic: readonly ExportItem[];
  readonly geneticIncludedUnder?: {
    readonly authorizationRef: string;
    readonly writtenEvidenceRef: string;
  };
  /** Re-checked at SEND time — never the request time (EX-2). */
  readonly authorizationCheckedAt: 'send-time';
  /** An expired authorization blocks NEW disclosure; prior stands (EX-4). */
  readonly priorDisclosuresUnwound: false;
}

export function assembleRecordsExport(request: {
  readonly items: readonly ExportItem[];
  readonly subjectPersonId: PersonId;
  readonly authorizations: readonly GipaAuthorization[];
  readonly sendDate: string;
}): RecordsExportAssembly {
  const genetic = request.items.filter((item) => item.partitionTags.includes('gipa-genetic'));
  const nonGenetic = request.items.filter((item) => !item.partitionTags.includes('gipa-genetic'));
  const authorization = findValidGipaAuthorization(
    request.authorizations,
    request.subjectPersonId,
    request.sendDate,
  );
  if (authorization === undefined) {
    return {
      included: nonGenetic,
      excludedGenetic: genetic,
      authorizationCheckedAt: 'send-time',
      priorDisclosuresUnwound: false,
    };
  }
  return {
    included: [...nonGenetic, ...genetic],
    excludedGenetic: [],
    geneticIncludedUnder: {
      authorizationRef: authorization.authorizationId,
      writtenEvidenceRef: authorization.writtenEvidenceRef,
    },
    authorizationCheckedAt: 'send-time',
    priorDisclosuresUnwound: false,
  };
}

/* ------------------------------------------------------------------ *
 * Employer surface — structural exclusion (AC-2 / AC-6 / EX-3)        *
 * ------------------------------------------------------------------ */

/**
 * The ONLY metrics an employer-facing surface can request. There is no
 * member of this vocabulary — and no field on the query shape — through
 * which genetic (or any clinical) data can be named: the exclusion is
 * enforced at the data-access layer, not by UI hiding.
 */
export const employerSurfaceMetrics = [
  'roster-headcount',
  'active-membership-count',
  'invoice-total',
  'tier-breakdown',
] as const;
export type EmployerSurfaceMetric = (typeof employerSurfaceMetrics)[number];

export interface EmployerSurfaceQuery {
  readonly tenantId: string;
  readonly legalEntityId: LegalEntityId;
  readonly metric: EmployerSurfaceMetric;
}

export interface EmployerRosterStats {
  readonly rosterHeadcount: number;
  readonly activeMembershipCount: number;
  readonly invoiceTotalCents: number;
  readonly tierBreakdown: Readonly<Record<string, number>>;
}

export function renderEmployerSurface(
  query: EmployerSurfaceQuery,
  stats: EmployerRosterStats,
): number | Readonly<Record<string, number>> {
  switch (query.metric) {
    case 'roster-headcount':
      return stats.rosterHeadcount;
    case 'active-membership-count':
      return stats.activeMembershipCount;
    case 'invoice-total':
      return stats.invoiceTotalCents;
    case 'tier-breakdown':
      return stats.tierBreakdown;
    default: {
      const exhaustive: never = query.metric;
      throw new PdpInvariantError(
        `employer surface refuses unknown metric ${JSON.stringify(exhaustive)} — ` +
          'the metric vocabulary is closed (REQ-ID-019 AC-2/AC-6)',
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Break-glass severity (AC-8)                                         *
 * ------------------------------------------------------------------ */

/**
 * Genetic-touching break-glass events carry a DISTINCT severity category so
 * they never blend into general break-glass volume. The review-queue surface
 * is WP-017 (FWD-PDP-017-BREAKGLASS).
 */
export function breakGlassSeverityFor(
  partitionTags: readonly AccessPartitionTag[],
): 'elevated-genetic' | 'standard' {
  return partitionTags.includes('gipa-genetic') ? 'elevated-genetic' : 'standard';
}

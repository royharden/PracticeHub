/**
 * Affirmed vs legal names (WP-013, REQ-ID-015): distinct facts on one person.
 * The affirmed name is the patient-facing default; legal matching identifiers
 * surface only in the transaction fields that require them. A name difference
 * never creates a second person, never merges records, and is never fraud.
 */

import type { PersonId, TenantId } from '@practicehub/contracts';

import { IdentityInvariantError } from './identity.js';

export type NameKind = 'affirmed' | 'legal';

export const nameContexts = [
  'care',
  'portal',
  'payer',
  'pharmacy',
  'laboratory',
  'legal-document',
] as const;
export type NameContext = (typeof nameContexts)[number];

/** Contexts whose external matching requires the legal identifier (REQ-ID-015 AC-3). */
export const legalMatchingContexts: readonly NameContext[] = [
  'payer',
  'pharmacy',
  'laboratory',
  'legal-document',
];

export interface PersonName {
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly kind: NameKind;
  readonly givenName: string;
  readonly familyName: string;
  readonly effectiveDate?: string;
  readonly source: string;
  /** Contexts the patient marked unsafe for the affirmed name (REQ-ID-015 AC-2). */
  readonly unsafeContexts: readonly NameContext[];
  readonly synthetic: boolean;
}

export interface RenderedName {
  readonly givenName: string;
  readonly familyName: string;
  readonly kindUsed: NameKind;
  /** True when the context's external transaction must carry the legal identifier in its matching field. */
  readonly legalIdentifierRequired: boolean;
}

function pick(names: readonly PersonName[], kind: NameKind): PersonName | undefined {
  return names.find((name) => name.kind === kind);
}

/**
 * REQ-ID-015 AC-2/AC-3: patient-facing contexts render the affirmed name by
 * default and fall back to the legal name only where the patient marked the
 * affirmed name unsafe; legal-matching contexts use the legal identifier in
 * the matching field while the crosswalk keeps ONE person. A person with no
 * name record for the required kind is a data error, not a silent fallback.
 */
export function nameForContext(names: readonly PersonName[], context: NameContext): RenderedName {
  const affirmed = pick(names, 'affirmed');
  const legal = pick(names, 'legal');
  const legalMatching = legalMatchingContexts.includes(context);
  if (legalMatching) {
    if (!legal) {
      throw new IdentityInvariantError(
        `context ${context} requires a legal matching identifier and none is recorded`,
      );
    }
    return {
      givenName: legal.givenName,
      familyName: legal.familyName,
      kindUsed: 'legal',
      legalIdentifierRequired: true,
    };
  }
  const affirmedUnsafe = affirmed?.unsafeContexts.includes(context) ?? false;
  const chosen = affirmed && !affirmedUnsafe ? affirmed : (legal ?? affirmed);
  if (!chosen) {
    throw new IdentityInvariantError('person has no name record to render');
  }
  return {
    givenName: chosen.givenName,
    familyName: chosen.familyName,
    kindUsed: chosen.kind,
    legalIdentifierRequired: false,
  };
}

export type ExternalNameRejectionResolution = {
  readonly outcome: 'reconciliation-required';
  readonly affirmedNameRetained: true;
  readonly system: string;
  readonly rejectionRef: string;
};

/**
 * REQ-ID-015 exception 2: a lab, pharmacy, or payer rejection routes to
 * identity reconciliation; the affirmed name stays in patient-facing care.
 */
export function routeExternalNameRejection(
  system: string,
  rejectionRef: string,
): ExternalNameRejectionResolution {
  if (!system || !rejectionRef) {
    throw new IdentityInvariantError(
      'an external name rejection must name its system and reference',
    );
  }
  return { outcome: 'reconciliation-required', affirmedNameRetained: true, system, rejectionRef };
}

/**
 * REQ-ID-015 AC-4: after a name update, unresolved external-system mismatches
 * stay visible until every authoritative system acknowledges.
 */
export function outstandingNameAcknowledgments(
  requiredSystems: readonly string[],
  acknowledgedSystems: readonly string[],
): readonly string[] {
  const acknowledged = new Set(acknowledgedSystems);
  return requiredSystems.filter((system) => !acknowledged.has(system)).sort();
}

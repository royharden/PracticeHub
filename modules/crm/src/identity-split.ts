import { CrmError, openIdentitySplit, openLead, type IdentitySplit, type Lead } from './crm.js';
import type { IdentityReadPort, Wp016MergeCasePort } from './ports.js';

/**
 * `resolved-linked`: the merge case kept both records and linked them as related
 * persons, so the split ends without a merge (hardening H-25 R3).
 */
export type IdentitySplitStatus =
  'open' | 'resolved-distinct' | 'resolved-merged' | 'resolved-linked';

export interface GovernedIdentitySplit extends IdentitySplit {
  readonly status: IdentitySplitStatus;
  readonly mergeCaseId: string | null;
  readonly resolvedBy: string | null;
}

function assertPersonInTenant(
  identity: IdentityReadPort,
  tenantId: string,
  personId: string,
): void {
  if (identity.read(tenantId, personId) === undefined) {
    throw new CrmError('CRM_TENANT', `person ${personId} is not an identity in tenant ${tenantId}`);
  }
}

/** Opens a split only when both person links are identities of the split's tenant. */
export function openGovernedIdentitySplit(
  input: {
    readonly splitId: string;
    readonly tenantId: string;
    readonly leftPersonId: string;
    readonly rightPersonId: string;
  },
  identity: IdentityReadPort,
): GovernedIdentitySplit {
  const split = openIdentitySplit(input);
  assertPersonInTenant(identity, split.tenantId, split.leftPersonId);
  assertPersonInTenant(identity, split.tenantId, split.rightPersonId);
  return { ...split, status: 'open', mergeCaseId: null, resolvedBy: null };
}

/** Opens a lead only for a person that is an identity of the lead's tenant. */
export function openLeadForIdentity(
  input: { readonly leadId: string; readonly tenantId: string; readonly personId: string },
  identity: IdentityReadPort,
): Lead {
  assertPersonInTenant(identity, input.tenantId, input.personId);
  return openLead(input);
}

/** Links an open split to the WP-016 merge case that will govern its outcome. */
export function linkSplitToMergeCase(
  split: GovernedIdentitySplit,
  caseId: string,
  cases: Wp016MergeCasePort,
): GovernedIdentitySplit {
  if (split.status !== 'open' || split.mergeCaseId !== null) {
    throw new CrmError('CRM_SPLIT', `split ${split.splitId} is already linked or resolved`);
  }
  const found = cases.get(split.tenantId, caseId);
  if (found === undefined || found.tenantId !== split.tenantId) {
    throw new CrmError('CRM_SPLIT', `merge case ${caseId} is not in tenant ${split.tenantId}`);
  }
  if (
    !found.personIds.includes(split.leftPersonId) ||
    !found.personIds.includes(split.rightPersonId)
  ) {
    throw new CrmError('CRM_SPLIT', `merge case ${caseId} does not cover both split persons`);
  }
  return { ...split, mergeCaseId: caseId };
}

/**
 * Resolves a split only from its linked merge case's own resolution: the case
 * decides, CRM follows. An unlinked split or an unresolved case refuses.
 */
export function resolveIdentitySplit(
  split: GovernedIdentitySplit,
  cases: Wp016MergeCasePort,
  resolvedBy: string,
): GovernedIdentitySplit {
  if (split.status !== 'open') {
    throw new CrmError('CRM_SPLIT', `split ${split.splitId} is already ${split.status}`);
  }
  if (split.mergeCaseId === null) {
    throw new CrmError(
      'CRM_SILENT_MERGE',
      `split ${split.splitId} has no merge case; it cannot resolve silently`,
    );
  }
  if (!resolvedBy.trim()) {
    throw new CrmError('CRM_SPLIT', 'split resolution must be attributed');
  }
  const found = cases.get(split.tenantId, split.mergeCaseId);
  // A dismissed case decided no merge: the persons stay distinct (H-25 R3).
  if (found?.status === 'resolved-distinct' || found?.status === 'dismissed') {
    return { ...split, status: 'resolved-distinct', resolvedBy };
  }
  if (found?.status === 'resolved-linked') {
    return { ...split, status: 'resolved-linked', resolvedBy };
  }
  if (found?.status === 'resolved-merged') {
    return { ...split, status: 'resolved-merged', resolvedBy };
  }
  throw new CrmError(
    'CRM_SPLIT',
    `merge case ${split.mergeCaseId} is ${found?.status ?? 'missing'}; the split stays open`,
  );
}

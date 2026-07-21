/**
 * Closed access-control vocabularies (WP-015). Contract:
 * docs/contracts/pdp-api.md (FROZEN) — extending any vocabulary here is a
 * contract revision, never a silent edit.
 *
 * The purpose-of-use vocabulary IS the audit-emit reason vocabulary
 * (docs/contracts/audit-emit.md): a PDP decision's purpose lands verbatim as
 * the `access` stream `reason`, so a purpose outside the audit vocabulary is
 * unrepresentable. The partition-tag vocabulary mirrors the same contract.
 */

export class PdpInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PdpInvariantError';
  }
}

/** Data segments the PDP decides over (pdp-api.md decision 2). */
export const dataSegments = [
  'demographics',
  'scheduling',
  'messaging',
  'statements',
  'payment-methods',
  'clinical-notes',
  'results',
  'medications',
  'documents',
  'genetic',
  'confidential-adolescent',
] as const;
export type DataSegment = (typeof dataSegments)[number];

export const pdpActions = ['view', 'edit', 'export'] as const;
export type PdpAction = (typeof pdpActions)[number];

/** EXACTLY the audit-emit reason vocabulary (frozen there; mirrored here). */
export const purposesOfUse = [
  'treatment',
  'payment',
  'operations',
  'patient-request',
  'break-glass-emergency',
  'investigation',
  'legal-obligation',
  'system-maintenance',
] as const;
export type PurposeOfUse = (typeof purposesOfUse)[number];

/** EXACTLY the audit-emit partition-tag vocabulary. */
export const accessPartitionTags = ['gipa-genetic', 'chd', 'biometric', 'part2'] as const;
export type AccessPartitionTag = (typeof accessPartitionTags)[number];

/** Canonical staff role keys (REQ-ID-018 AC-6). */
export const canonicalRoleKeys = [
  'front-desk',
  'ma-nurse',
  'physician-app',
  'biller-coder',
  'practice-manager',
  'it-security-admin',
  'compliance-privacy-officer',
  'employer-sponsor-admin',
] as const;
export type CanonicalRoleKey = (typeof canonicalRoleKeys)[number];

export function assertDataSegment(value: string, label: string): asserts value is DataSegment {
  if (!(dataSegments as readonly string[]).includes(value)) {
    throw new PdpInvariantError(`${label} must be a declared data segment; received ${value}`);
  }
}

export function assertPdpAction(value: string, label: string): asserts value is PdpAction {
  if (!(pdpActions as readonly string[]).includes(value)) {
    throw new PdpInvariantError(`${label} must be a declared PDP action; received ${value}`);
  }
}

export function assertPurposeOfUse(value: string, label: string): asserts value is PurposeOfUse {
  if (!(purposesOfUse as readonly string[]).includes(value)) {
    throw new PdpInvariantError(
      `${label} must come from the closed purpose-of-use vocabulary; received ${value}`,
    );
  }
}

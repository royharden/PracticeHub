/**
 * Content-license gate (WP-026, M07). Compliance: R6-REQ-080 (CPT license gate),
 * R6-REQ-081 (drug-compendium license gate). Contract:
 * docs/contracts/adapter-registry-api.md (FROZEN); authority-rail join AUTH-023
 * (licensed content is a READ authority — absence or stale rights blocks
 * dependent commands, creates no external transport effect).
 *
 * Licensed reference content (CPT code descriptions, a drug compendium, NCCI
 * edit files) may only be consulted while a valid, in-date license is on record.
 * A missing, pending, expired, or checksum-mismatched license fails closed and
 * DISABLES the dependent command (the FL day-one eRx compendium and the RCM CPT
 * surfaces read through this gate). The real license content stays dark behind
 * EW-CONTENT-01/02/04; WP-026 delivers the gate mechanism at `scaffolded`.
 */

export const contentFamilies = ['cpt', 'drug-compendium', 'ncci', 'other'] as const;
export type ContentFamily = (typeof contentFamilies)[number];

export const contentLicenseStatuses = ['active', 'pending', 'lapsed'] as const;
export type ContentLicenseStatus = (typeof contentLicenseStatuses)[number];

export const licenseGateReasons = [
  'no-license-on-record',
  'license-pending',
  'license-lapsed',
  'license-expired',
  'license-not-yet-effective',
  'checksum-mismatch',
] as const;
export type LicenseGateReason = (typeof licenseGateReasons)[number];

export interface ContentLicenseRow {
  readonly tenantId: string;
  readonly licenseId: string;
  readonly contentFamily: ContentFamily;
  readonly status: ContentLicenseStatus;
  readonly effective: string | null;
  readonly expiry: string | null;
  readonly rightsRef: string;
  /** Checksum of the licensed edition on record — a pinned decision's edition. */
  readonly checksum: string;
  readonly synthetic: true;
}

export interface LicenseGateInput {
  readonly contentFamily: ContentFamily;
  readonly asOf: string;
  /** The edition checksum the dependent command expects (a pinned historical
   * decision retains its edition — authority-rail AUTH-023 late_outcome_rule). */
  readonly expectedChecksum?: string;
}

export interface LicenseGateDecision {
  readonly permitted: boolean;
  readonly reason: LicenseGateReason | 'permitted';
}

/**
 * Resolve whether a dependent command may consult the given licensed content
 * family. Fail-closed: absence, pending, lapse, expiry, a not-yet-effective
 * window, or a checksum mismatch all DENY. Only an active, in-date license
 * whose checksum matches (when the caller pins one) permits.
 */
export function licenseGate(
  license: ContentLicenseRow | null,
  input: LicenseGateInput,
): LicenseGateDecision {
  const deny = (reason: LicenseGateReason): LicenseGateDecision => ({ permitted: false, reason });
  if (license === null) {
    return deny('no-license-on-record');
  }
  if (license.status === 'pending') {
    return deny('license-pending');
  }
  if (license.status === 'lapsed') {
    return deny('license-lapsed');
  }
  if (license.effective === null || license.expiry === null) {
    return deny('no-license-on-record');
  }
  if (license.effective > input.asOf) {
    return deny('license-not-yet-effective');
  }
  if (license.expiry < input.asOf) {
    return deny('license-expired');
  }
  if (input.expectedChecksum !== undefined && input.expectedChecksum !== license.checksum) {
    return deny('checksum-mismatch');
  }
  return { permitted: true, reason: 'permitted' };
}

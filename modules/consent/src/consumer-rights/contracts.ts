/**
 * WP-097 consumer rights and relationship endings (M03;M02;M17;M14).
 * R6-SR-020/021/022 (NV SB 370 consumer health data), R6-REQ-075 and
 * R6-SR-070/071 (auto-renewal), REQ-CLIN-001 (clinician termination),
 * REQ-PORT-001, REQ-MEM-066, REQ-MEM-034. Synthetic data only.
 *
 * Every day count and distance below is configuration that counsel confirms;
 * none is a legal conclusion. Each rule table carries a version so a decision
 * can name the ruleset it applied.
 */

export class ConsumerRightsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConsumerRightsError';
    this.code = code;
  }
}

export const DAY_MS = 86_400_000;

export function plusDays(at: string, days: number): string {
  return new Date(Date.parse(at) + days * DAY_MS).toISOString();
}

export function daysFrom(from: string, to: string): number {
  return Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/** Identity is owned elsewhere (WP-013); this module only reads a verification answer. */
export type VerificationOutcome = 'verified' | 'ambiguous' | 'failed';

export interface IdentityVerificationPort {
  readonly packageId: 'WP-013';
  verify(tenantId: string, personRef: string, evidenceRef: string): VerificationOutcome;
}

/** Membership (WP-052) read view: only what relationship endings and renewal need. */
export interface MembershipView {
  readonly packageId: 'WP-052';
  readonly tenantId: string;
  readonly membershipId: string;
  readonly personRef: string;
  readonly status: 'active' | 'paused' | 'cancelled';
  readonly renewalDate: string;
  readonly termMonths: number;
  readonly priceMinor: number;
  readonly stateOfRecord: string;
  /** Set when the member recently moved and the state of record is not yet confirmed. */
  readonly priorStateOfRecord: string | null;
  readonly vintageRef: string;
}

export interface MembershipReadPort {
  readonly packageId: 'WP-052';
  membershipFor(tenantId: string, personRef: string): MembershipView | null;
}

/** Open clinical work for one patient, read from encounters (M14). */
export type OpenClinicalKind =
  | 'high-risk-medication'
  | 'pending-result'
  | 'order'
  | 'referral'
  | 'scheduled-care'
  | 'open-message';

export interface OpenClinicalItem {
  readonly itemRef: string;
  readonly kind: OpenClinicalKind;
  readonly description: string;
  /** A critical result or continuity-risk medication blocks closure until it is terminal. */
  readonly critical: boolean;
}

export interface EncountersReadPort {
  readonly packageId: 'M14-encounters';
  openItems(tenantId: string, patientRef: string): readonly OpenClinicalItem[];
}

/**
 * WP-093 coordination of benefits: payer sequencing under Medicare Secondary Payer (MSP) rules,
 * secondary and tertiary claims built from posted primary remits, and Medicare crossover tracking
 * (RT-01 closure; R6-REQ-030 claim order per MSP determination). Synthetic data only.
 */

export const WP093_PACKAGE_ID = 'WP-093' as const;

/** Days a Medicare-forwarded (crossover) claim may wait for the secondary's response. */
export const CROSSOVER_WINDOW_DAYS = 30;

export type PayerKind =
  | 'medicare'
  | 'medicare-advantage'
  | 'employer-ghp'
  | 'retiree-ghp'
  /** A group commercial plan (employer-sponsored); treated as a GHP under MSP. */
  | 'commercial'
  /** An individual (non-group) commercial plan; never a GHP, so it follows Medicare. */
  | 'individual-commercial'
  | 'tricare'
  | 'medigap'
  | 'medicaid'
  | 'workers-comp'
  | 'no-fault'
  | 'liability';

export interface Coverage {
  readonly coverageId: string;
  readonly tenantId: string;
  readonly patientId: string;
  readonly payerId: string;
  readonly kind: PayerKind;
  /** The payer receives Medicare's automatic crossover (COBA) and must not also get a manual claim. */
  readonly crossoverEligible: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export type CobFlag =
  | 'mis-ordered'
  | 'unknown-payer'
  | 'secondary-before-primary-adjudicated'
  | 'crossover-pending'
  | 'msp-determination-missing'
  | 'msp-determination-stale'
  | 'multiple-medicare-coverages'
  | 'msp-liability-conflict'
  | 'duplicate-payer'
  | 'medigap-without-medicare'
  | 'no-payable-coverage'
  | 'episode-closed';

export interface CobFinding {
  readonly flag: CobFlag;
  readonly detail: string;
}

export interface SequencedPayer {
  readonly position: number;
  readonly coverageId: string;
  readonly payerId: string;
  readonly kind: PayerKind;
  readonly crossoverEligible: boolean;
}

export interface CobOrder {
  readonly payers: readonly SequencedPayer[];
  /** Findings that block every submission until the order is re-derived. */
  readonly blocking: readonly CobFinding[];
  readonly basis: string;
}

export interface EpisodeInput {
  readonly episodeId: string;
  readonly tenantId: string;
  readonly patientId: string;
  readonly encounterId: string;
  readonly serviceDate: string;
  readonly billedMinor: number;
  /** Services related to an accident or work injury put that liability payer first. */
  readonly accidentRelated: boolean;
  readonly coverages: readonly Coverage[];
}

/** What a later payer receives about each earlier payer (837 loops 2320/2430 in shape). */
export interface PriorPayerAdjudication {
  readonly position: number;
  readonly payerId: string;
  readonly remitId: string;
  readonly paidMinor: number;
  readonly adjustments: readonly RemitAdjustment[];
}

export interface RemitAdjustment {
  readonly group: 'CO' | 'PR' | 'OA' | 'PI';
  readonly reason: string;
  readonly amountMinor: number;
}

export interface CobClaimSubmission {
  readonly episodeId: string;
  readonly tenantId: string;
  readonly position: number;
  readonly payerId: string;
  readonly controlNumber: string;
  /** The amount this payer is asked to consider: billed for primary, remaining balance after. */
  readonly amountMinor: number;
  readonly priorPayers: readonly PriorPayerAdjudication[];
  readonly submittedAt: string;
}

export interface SubmissionRequest {
  readonly payerId: string;
  readonly controlNumber: string;
  readonly at: string;
}

export interface CobEvent {
  readonly tenantId: string;
  readonly episodeId: string;
  readonly at: string;
  readonly kind:
    | 'opened'
    | 'resequenced'
    | 'submitted'
    | 'adjudicated'
    | 'crossover-forwarded'
    | 'crossover-not-forwarded'
    | 'crossover-missing'
    | 'duplicate-remit'
    | 'submission-refused'
    | 'completed'
    | 'exception';
  readonly detail: string;
}

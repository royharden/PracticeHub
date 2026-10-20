/**
 * WP-074 referral API (M24, REQ-REF). The shapes here are the frozen referral
 * API surface described in `contracts/referral-api.md`. Every value is
 * synthetic; nothing in this module reaches a real fax line, portal or the
 * public NPPES registry.
 */

export const WP074_PACKAGE_ID = 'WP-074';
/** Clinical contracts (consult notes) are owned by WP-060; a placeholder stands in until it links. */
export const WP060_PACKAGE_ID = 'WP-060';
/** Documents blob API is owned by WP-024; a placeholder stands in until it links. */
export const WP024_PACKAGE_ID = 'WP-024';

export class ReferralError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReferralError';
    this.code = code;
  }
}

export type Urgency = 'routine' | 'urgent';

/**
 * Loop stages in order (REQ-REF-013 AC6, REQ-REF-015 AC6). `closed` is
 * reachable only through a closure path that satisfies the closure invariants.
 */
export const LOOP_STAGES = [
  'created',
  'sent',
  'acknowledged',
  'scheduled',
  'seen',
  'results-returned',
  'reviewed',
  'closed',
] as const;
export type LoopStage = (typeof LOOP_STAGES)[number];

/** Holds that pause the loop without closing it. */
export type HoldReason =
  | 'consent-required'
  | 'mn-written-consent-required'
  | 'send-failed'
  | 'patient-follow-up'
  | 'missing-information'
  | 'patient-state-unknown';

/** Every way a loop may close; each has its own evidence rule in `loop.ts`. */
export type ClosureReason =
  | 'results-reviewed'
  | 'declined-by-destination'
  | 'no-results-after-outer-bound'
  | 'patient-non-engagement';

export type Channel = 'fax' | 'esp';

export interface StageEvent {
  readonly stage: LoopStage;
  readonly at: string;
  readonly actor: string;
  readonly evidenceRef: string | null;
}

export interface HoldEvent {
  readonly reason: HoldReason;
  readonly at: string;
  readonly released: string | null;
  readonly detail: string;
}

export interface OutreachAttempt {
  readonly at: string;
  readonly method: 'call' | 'fax' | 'portal';
  readonly note: string;
}

export interface ReferrerNotice {
  readonly at: string;
  readonly referrerNpi: string;
  readonly stage: LoopStage | 'hold' | 'closed';
  readonly channel: Channel;
  readonly detail: string;
}

export interface ConsentEvidence {
  /** Consent-ledger reference for this specific disclosure. */
  readonly consentRef: string;
  /** The consent must belong to the referral's tenant and patient; otherwise it is no consent. */
  readonly tenantId: string;
  readonly patientRef: string;
  readonly recipientNpi: string;
  readonly expiresAt: string;
  /** Written consent evidence required when the patient's record is Minnesota (MHRA-MN). */
  readonly writtenMn: boolean;
}

export interface DisclosureLogEntry {
  readonly at: string;
  readonly recipientNpi: string;
  readonly consentRef: string;
  readonly channel: Channel;
  readonly transmissionId: string;
  readonly artifactRefs: readonly string[];
}

export interface ConsultReview {
  readonly reviewerId: string;
  readonly at: string;
  readonly consultNoteRef: string;
}

/** An inbound partner event from the fax or ESP rail, or a coordinator's manual entry. */
export type PartnerEventKind =
  'acknowledged' | 'scheduled' | 'seen' | 'consult-note' | 'declined' | 'no-show';

export interface PartnerEvent {
  readonly kind: PartnerEventKind;
  readonly referralId: string;
  readonly patientRef: string;
  readonly at: string;
  readonly channel: Channel | 'manual';
  readonly evidenceRef: string;
  readonly detail: string;
  /** Present only on `consult-note`. */
  readonly consultNoteRef: string | null;
}

export type TransmissionStatus = 'delivered' | 'busy' | 'invalid-address';

/** Transport evidence only: delivery never proves the partner accepted care (REQ-REF-010 EX1). */
export interface TransmissionReceipt {
  readonly transmissionId: string;
  readonly channel: Channel;
  readonly status: TransmissionStatus;
  readonly at: string;
  readonly synthetic: true;
}

export interface OutboundRequest {
  readonly referralId: string;
  readonly address: string;
  readonly artifactRefs: readonly string[];
  readonly at: string;
}

export interface OutboundChannelPort {
  readonly channel: Channel;
  send(request: OutboundRequest): TransmissionReceipt;
}

export interface ReferralCase {
  readonly referralId: string;
  readonly tenantId: string;
  readonly patientRef: string;
  readonly patientState: string;
  readonly referringNpi: string;
  readonly destinationNpi: string;
  readonly directoryVersion: string;
  readonly reason: string;
  readonly urgency: Urgency;
  readonly location: string;
  readonly expectedReturnDays: number;
  /** The patient asked that this referrer receive no updates (REQ-REF-005 EX5). */
  readonly referrerUpdatesOptOut: boolean;
  readonly stage: LoopStage;
  readonly stages: readonly StageEvent[];
  readonly holds: readonly HoldEvent[];
  readonly outreach: readonly OutreachAttempt[];
  readonly notices: readonly ReferrerNotice[];
  readonly disclosures: readonly DisclosureLogEntry[];
  readonly consultNoteRef: string | null;
  readonly review: ConsultReview | null;
  readonly assignedReviewerId: string;
  readonly closure: { readonly reason: ClosureReason; readonly at: string } | null;
  readonly escalations: readonly {
    readonly at: string;
    readonly to: string;
    readonly why: string;
  }[];
}

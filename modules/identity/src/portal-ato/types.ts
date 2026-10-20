/**
 * Portal-side ATO chain and e-sign outage consent fallback (WP-099, M02;M10;M06;M03).
 * Requirements: REQ-ID-029 (drill chain over the WP-014 ato.ts machinery,
 * FWD-AUTH-099-ATO-DRILLS), REQ-PORT-020 (paper fallback at check-in), REQ-PLAT-033
 * (digitization, quarantine, outage SLA), REQ-PORT-018 EX1 (no self-signing a consent the
 * patient cannot read). ato.ts and the consent ledger are read-only here; everything this
 * package needs from documents, consent and encounters arrives through the ports below.
 */

import type { PersonId, TenantId } from '@practicehub/contracts';

import type {
  AccountLockdown,
  AtoNotificationDirective,
  AtoNotificationFollowUp,
  AtoRiskLevel,
  AtoSignal,
  CohortProtectionDirective,
} from '../ato.js';
import type { AuthSession } from '../authn.js';
import type { EndpointAssociation } from '../endpoints.js';
import type { IdentityProofingMethod } from '../idproof-port.js';

export class PortalAtoError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PortalAtoError';
  }
}

export class ConsentFallbackError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConsentFallbackError';
  }
}

/* ---------------------------------------------------------------- *
 * Portal ATO chain                                                  *
 * ---------------------------------------------------------------- */

/** One portal login attempt. `sourceRef` and `locationRef` are coarse refs, never raw addresses. */
export interface PortalLoginAttempt {
  readonly attemptId: string;
  readonly personId: PersonId;
  readonly sourceRef: string;
  readonly locationRef: string;
  readonly deviceId: string;
  readonly outcome: 'failed' | 'succeeded';
  readonly observedAt: string;
  readonly synthetic: true;
}

export interface StuffingWaveThresholds {
  /** Distinct accounts one source must hit inside the window to count as a wave. */
  readonly distinctAccountsPerSource: number;
  readonly windowMinutes: number;
}

export interface StuffingWave {
  readonly sourceRef: string;
  readonly targetedPersonIds: readonly PersonId[];
  /** Accounts the wave source logged into successfully: treated as compromised. */
  readonly compromisedPersonIds: readonly PersonId[];
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export type NotificationOutcome =
  | { readonly status: 'sent'; readonly directive: AtoNotificationDirective }
  | {
      readonly status: 'fail-closed';
      readonly route: 'supervised-manual';
      readonly reason: string;
      /** The owned supervised-manual follow-up from ato.ts's committed lockdown (H-07). */
      readonly followUp?: AtoNotificationFollowUp;
    };

export interface AccountAtoOutcome {
  readonly personId: PersonId;
  readonly signals: readonly AtoSignal[];
  readonly risk: AtoRiskLevel;
  readonly lockdown: AccountLockdown;
  readonly notification: NotificationOutcome;
}

export interface PortalAtoChainInput {
  readonly tenantId: TenantId;
  readonly lockdownIdPrefix: string;
  readonly attempts: readonly PortalLoginAttempt[];
  readonly sessions: readonly AuthSession[];
  readonly associations: readonly EndpointAssociation[];
  /** Contact endpoints changed inside the incident window, per person (REQ-ID-029 EX1). */
  readonly recentlyChangedEndpointIds: Readonly<Record<string, readonly string[]>>;
  readonly failedLoginSignalThreshold: number;
  readonly cohortProtectionInvokedBy: string;
  readonly synthetic: true;
}

export interface PortalAtoChainResult {
  readonly waves: readonly StuffingWave[];
  readonly accounts: readonly AccountAtoOutcome[];
  readonly cohortProtection: CohortProtectionDirective | null;
  readonly sessions: readonly AuthSession[];
}

export type RestorationAttempt =
  | { readonly kind: 'step-up'; readonly evidenceRef: string; readonly releasedBy: string }
  | {
      readonly kind: 're-identity-proofing';
      readonly method: IdentityProofingMethod;
      readonly releasedBy: string;
    }
  | {
      readonly kind: 'supervised-manual';
      readonly verifierId: string;
      readonly evidenceRef: string;
    };

export type RestorationOutcome =
  | { readonly status: 'released'; readonly lockdown: AccountLockdown }
  | {
      readonly status: 'still-locked';
      readonly lockdown: AccountLockdown;
      readonly reason: string;
      readonly offered: 'retry' | 'supervised-manual';
    };

export interface DrillCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface DrillReport {
  readonly drillId: string;
  readonly passed: boolean;
  readonly checks: readonly DrillCheck[];
  readonly synthetic: true;
}

/* ---------------------------------------------------------------- *
 * E-sign outage consent fallback                                    *
 * ---------------------------------------------------------------- */

export type ConsentJurisdiction = 'NV' | 'FL' | 'IL' | 'MN' | 'virtual';

export interface VisitConsentRule {
  readonly formId: string;
  /** Legally required before the visit may proceed (REQ-PORT-020 AC2). */
  readonly blocking: boolean;
}

export interface ConsentFormVersion {
  readonly formId: string;
  /** The approved version label printed on the form. */
  readonly version: string;
  /** The documents-module version sent to the e-sign rail. */
  readonly documentId: string;
  readonly versionNo: number;
  readonly contentHash: string;
  /** Languages with a vetted translation (REQ-PORT-018 EX1). */
  readonly vettedLanguages: readonly string[];
}

export interface CheckIn {
  readonly checkInId: string;
  readonly tenantId: TenantId;
  readonly patientRef: string;
  readonly encounterRef: string;
  readonly jurisdiction: ConsentJurisdiction;
  readonly visitType: string;
  readonly preferredLanguage: string;
  readonly synthetic: true;
}

export type FormPath = 'electronic' | 'paper' | 'interpreter-assisted' | 'version-unavailable';

export interface PlannedConsentForm {
  readonly formId: string;
  readonly blocking: boolean;
  /** The current approved version, or null when none exists (REQ-PORT-020 EX1). */
  readonly version: string | null;
  readonly path: FormPath;
}

export interface PaperFallbackKit {
  readonly kitId: string;
  readonly checkInId: string;
  readonly outageId: string;
  /** Current approved versions only (REQ-PORT-020 AC1/AC4). */
  readonly forms: readonly { readonly formId: string; readonly version: string }[];
  readonly checklist: readonly { readonly formId: string; readonly blocking: boolean }[];
}

export type FormCaptureState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'signed-electronic'; readonly evidenceRef: string; readonly version: string }
  | {
      readonly kind: 'captured-paper';
      readonly captureId: string;
      readonly version: string;
      readonly capturedBy: string;
      readonly capturedAt: string;
    }
  | { readonly kind: 'refused'; readonly recordedBy: string }
  | { readonly kind: 'stale-version-blocked'; readonly presentedVersion: string };

export interface CheckInConsentState {
  readonly checkIn: CheckIn;
  readonly outageId: string | null;
  readonly forms: readonly PlannedConsentForm[];
  readonly captures: Readonly<Record<string, FormCaptureState>>;
  readonly kit: PaperFallbackKit | null;
}

export type VisitDecision =
  | {
      readonly decision: 'proceed';
      /** Visible gap: captured on paper, not yet digitized (REQ-PORT-020 AC3). */
      readonly capturedOnPaperPendingDigitization: readonly string[];
      readonly deferredNonBlocking: readonly string[];
    }
  | {
      readonly decision: 'hold';
      readonly missingBlocking: readonly string[];
      readonly reasons: readonly string[];
    };

/* ---------------------------------------------------------------- *
 * Post-outage digitization (REQ-PLAT-033)                           *
 * ---------------------------------------------------------------- */

export interface PendingPaperConsent {
  readonly captureId: string;
  readonly checkInId: string;
  readonly outageId: string;
  readonly patientRef: string;
  readonly encounterRef: string;
  readonly formId: string;
  readonly version: string;
  readonly capturedAt: string;
  readonly capturedBy: string;
}

export interface PaperConsentScan {
  readonly scanId: string;
  readonly patientRef: string | null;
  readonly encounterRef: string | null;
  readonly formId: string;
  readonly version: string;
  readonly synthetic: true;
}

/** Paper-versus-electronic provenance on the ledger entry (REQ-PLAT-033 AC2). */
export interface PaperConsentLedgerEntry {
  readonly captureId: string;
  readonly scanId: string;
  readonly patientRef: string;
  readonly encounterRef: string;
  readonly formId: string;
  readonly version: string;
  readonly provenance: {
    readonly medium: 'paper';
    readonly capturedDuringOutage: string;
    readonly capturedAt: string;
    readonly capturedBy: string;
    readonly digitizedAt: string;
    readonly digitizedBy: string;
  };
  readonly synthetic: true;
}

export type DigitizationOutcome =
  | { readonly status: 'linked'; readonly entry: PaperConsentLedgerEntry }
  | { readonly status: 'already-linked'; readonly captureId: string }
  | {
      readonly status: 'quarantined';
      readonly scanId: string;
      readonly reason: 'no-match' | 'ambiguous-match' | 'version-mismatch';
    }
  | {
      readonly status: 'compliance-review';
      readonly scanId: string;
      readonly captureId: string;
      readonly reason: 'conflicts-with-later-electronic';
    };

export interface EsignOutageRecord {
  readonly outageId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly affectedPatientRefs: readonly string[];
  readonly heldCheckInIds: readonly string[];
}

export interface EsignSla {
  readonly maxOutageMinutes: number;
  readonly maxOutagesPerReview: number;
}

export interface EsignOutageReport {
  readonly outageId: string;
  readonly durationMinutes: number;
  readonly affectedPatients: number;
  readonly heldVisits: number;
  readonly slaBreached: boolean;
  readonly escalation: 'vendor-accountability-review' | null;
  readonly reasons: readonly string[];
}

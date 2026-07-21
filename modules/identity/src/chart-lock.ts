/**
 * Deceased flag + chart lock (WP-015; REQ-ID-021 — the LOCK half).
 * Contract: docs/contracts/pdp-api.md (FROZEN) decision 8.
 *
 * The deceased fact is an append-only event stream over a WP-013-shaped
 * person: `set` and `corrected` events, never a toggle — a correction
 * requires documented evidence (EX-1). While set, the PDP denies new
 * order/scheduling/messaging writes; only compliance-privacy-officer or
 * practice-manager unlock, for a DOCUMENTED estate/legal purpose (AC-2).
 * The outreach-halt half (every channel, vendor-side queues included) is
 * WP-044 — the suppression directive SHAPE ships here (FWD-PDP-044-
 * SUPPRESSION) so the flag-set act names its consumer obligations.
 */

import type { PersonId } from '@practicehub/contracts';

import { PdpInvariantError, type CanonicalRoleKey, type DataSegment } from './access-vocabulary.js';
import { assertIdentityId } from './identity.js';

export interface PersonFlagEvent {
  readonly tenantId: string;
  readonly flagId: string;
  readonly personId: PersonId;
  readonly kind: 'deceased';
  readonly action: 'set' | 'corrected';
  /** Source of the death confirmation on set (AC-3: who/when/source). */
  readonly sourceRef?: string;
  /** A correction is DOCUMENTED, never a toggle-back (EX-1). */
  readonly correctionEvidenceRef?: string;
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly synthetic: boolean;
}

export function assertPersonFlagEventWellFormed(event: PersonFlagEvent): void {
  assertIdentityId(event.tenantId, 'tenantId');
  assertIdentityId(event.flagId, 'flagId');
  if (event.kind !== 'deceased') {
    throw new PdpInvariantError(`unknown person-flag kind ${JSON.stringify(event.kind)}`);
  }
  if (event.action === 'set' && !event.sourceRef) {
    throw new PdpInvariantError(
      `flag ${event.flagId}: setting the deceased flag records its confirmation source`,
    );
  }
  if (event.action === 'corrected' && !event.correctionEvidenceRef) {
    throw new PdpInvariantError(
      `flag ${event.flagId}: unflagging requires a documented correction, not a ` +
        'simple toggle-back (REQ-ID-021 exception 1)',
    );
  }
  if (!event.actorRef) {
    throw new PdpInvariantError(`flag ${event.flagId} requires an attributed actor`);
  }
}

export interface DeceasedFlagState {
  readonly deceased: boolean;
  readonly setBy?: string;
  readonly sourceRef?: string;
  readonly correctedBy?: string;
}

/** Latest event wins; every event in the stream must be well-formed. */
export function deceasedFlagState(
  events: readonly PersonFlagEvent[],
  personId: PersonId,
): DeceasedFlagState {
  let state: DeceasedFlagState = { deceased: false };
  for (const event of events) {
    assertPersonFlagEventWellFormed(event);
    if (event.personId !== personId) {
      continue;
    }
    state =
      event.action === 'set'
        ? {
            deceased: true,
            setBy: event.actorRef,
            ...(event.sourceRef !== undefined ? { sourceRef: event.sourceRef } : {}),
          }
        : { deceased: false, correctedBy: event.actorRef };
  }
  return state;
}

/** Channels the suppression directive must reach (AC-1; execution WP-044). */
export const suppressedOutreachChannels = [
  'sms',
  'email',
  'voice-call',
  'campaign',
  'recall-reminder',
  'ai-drafted-message',
] as const;

export interface DeceasedSuppressionDirective {
  readonly kind: 'deceased-suppression';
  readonly personId: PersonId;
  readonly cancelQueuedAcrossChannels: readonly (typeof suppressedOutreachChannels)[number][];
  /** Propagation must reach VENDOR-side queues, not just our own (EX-2). */
  readonly vendorSidePropagationRequired: true;
  readonly gracePeriodSends: 0;
}

export interface ChartLockDirective {
  readonly kind: 'chart-lock';
  readonly personId: PersonId;
  readonly readOnly: true;
  readonly unlockRestrictedTo: readonly CanonicalRoleKey[];
}

/** Segments whose EDIT locks while the flag is set (new orders/sched/msg). */
export const lockedSegmentsOnDeceased: readonly DataSegment[] = [
  'scheduling',
  'messaging',
  'medications',
  'clinical-notes',
];

export const chartUnlockRoles: readonly CanonicalRoleKey[] = [
  'compliance-privacy-officer',
  'practice-manager',
];

export function setDeceasedFlag(request: {
  readonly tenantId: string;
  readonly flagId: string;
  readonly personId: PersonId;
  readonly sourceRef: string;
  readonly actorRef: string;
  readonly occurredAt: string;
}): {
  readonly event: PersonFlagEvent;
  readonly suppressionDirective: DeceasedSuppressionDirective;
  readonly lockDirective: ChartLockDirective;
} {
  const event: PersonFlagEvent = {
    tenantId: request.tenantId,
    flagId: request.flagId,
    personId: request.personId,
    kind: 'deceased',
    action: 'set',
    sourceRef: request.sourceRef,
    actorRef: request.actorRef,
    occurredAt: request.occurredAt,
    synthetic: true,
  };
  assertPersonFlagEventWellFormed(event);
  return {
    event,
    suppressionDirective: {
      kind: 'deceased-suppression',
      personId: request.personId,
      cancelQueuedAcrossChannels: suppressedOutreachChannels,
      vendorSidePropagationRequired: true,
      gracePeriodSends: 0,
    },
    lockDirective: {
      kind: 'chart-lock',
      personId: request.personId,
      readOnly: true,
      unlockRestrictedTo: chartUnlockRoles,
    },
  };
}

/**
 * Correct a mistaken deceased report (EX-1): documented evidence required;
 * the prior state restores; the interim silence is recorded as CORRECT
 * protective behavior, never a service failure.
 */
export function correctDeceasedFlag(
  events: readonly PersonFlagEvent[],
  correction: {
    readonly tenantId: string;
    readonly flagId: string;
    readonly personId: PersonId;
    readonly correctionEvidenceRef: string;
    readonly actorRef: string;
    readonly occurredAt: string;
  },
): {
  readonly event: PersonFlagEvent;
  readonly restoreDirective: {
    readonly priorStateRestored: true;
    readonly interimSilenceWasServiceFailure: false;
  };
} {
  const state = deceasedFlagState(events, correction.personId);
  if (!state.deceased) {
    throw new PdpInvariantError(
      `person ${correction.personId} carries no active deceased flag to correct`,
    );
  }
  const event: PersonFlagEvent = {
    tenantId: correction.tenantId,
    flagId: correction.flagId,
    personId: correction.personId,
    kind: 'deceased',
    action: 'corrected',
    correctionEvidenceRef: correction.correctionEvidenceRef,
    actorRef: correction.actorRef,
    occurredAt: correction.occurredAt,
    synthetic: true,
  };
  assertPersonFlagEventWellFormed(event);
  return {
    event,
    restoreDirective: { priorStateRestored: true, interimSilenceWasServiceFailure: false },
  };
}

export interface EstateUnlock {
  readonly unlockRef: string;
  readonly personId: PersonId;
  readonly unlockedByRole: CanonicalRoleKey;
  readonly documentedPurposeRef: string;
}

/**
 * Unlock for a documented estate/legal purpose (AC-2): only the compliance
 * privacy officer or practice manager, and only WITH the documented purpose.
 */
export function unlockChartForEstate(request: {
  readonly unlockRef: string;
  readonly personId: PersonId;
  readonly actorRoleKeys: readonly CanonicalRoleKey[];
  readonly documentedPurposeRef: string;
}): EstateUnlock {
  const unlockRole = request.actorRoleKeys.find((role) => chartUnlockRoles.includes(role));
  if (unlockRole === undefined) {
    throw new PdpInvariantError(
      'chart unlock is restricted to the compliance-privacy-officer and ' +
        'practice-manager roles (REQ-ID-021 AC-2)',
    );
  }
  if (!request.documentedPurposeRef) {
    throw new PdpInvariantError('chart unlock requires a documented estate/legal purpose');
  }
  return {
    unlockRef: request.unlockRef,
    personId: request.personId,
    unlockedByRole: unlockRole,
    documentedPurposeRef: request.documentedPurposeRef,
  };
}

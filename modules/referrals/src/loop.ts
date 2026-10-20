/**
 * Referral loop engine (WP-074). Every function is pure: it takes a case and
 * returns a new one, appending history rather than rewriting it.
 *
 * Closure invariants (the reason this package exists):
 * 1. A loop closes only through `closeLoop` or a destination decline, never
 *    because an appointment was booked, a fax was delivered or a timer elapsed
 *    (REQ-REF-005 EX1, REQ-REF-007 EX1, REQ-REF-015 AC8).
 * 2. `results-reviewed` needs a finalized consult note matched to this
 *    referral and patient, reviewed by the currently assigned reviewer
 *    (REQ-REF-015 AC5, AC8, EX5).
 * 3. `no-results-after-outer-bound` needs the outer bound elapsed, a
 *    documented outreach attempt and an escalation to the referring clinician
 *    (REQ-REF-015 AC9, EX3).
 * 4. `patient-non-engagement` needs an open patient follow-up hold, two
 *    documented attempts and a referrer notice, and is refused for an urgent
 *    referral (REQ-REF-005 AC12, REQ-REF-011 EX1, REQ-REF-015 EX2).
 * 5. No records leave before consent for that disclosure is verified, and a
 *    Minnesota record also needs written consent (REQ-REF-013 AC1, AC5, EX1).
 * 6. `closed` is terminal until an explicit `reopenReferral`.
 */

import {
  LOOP_STAGES,
  ReferralError,
  type Channel,
  type ClosureReason,
  type ConsentEvidence,
  type HoldReason,
  type LoopStage,
  type OutboundChannelPort,
  type OutreachAttempt,
  type PartnerEvent,
  type ReferralCase,
  type ReferrerNotice,
  type Urgency,
} from './contracts.js';
import type { PinnedDirectory } from './directory.js';
import type { Wp024BlobPort, Wp060ConsultNotePort } from './placeholder.js';

export const OUTER_BOUND_DAYS = 45;
export const NON_ENGAGEMENT_MIN_ATTEMPTS = 2;

const DAY_MS = 86_400_000;

/** Parse an ISO instant, refusing anything unparseable (fail closed: NaN never satisfies a clock). */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Strict ISO-8601 instant with a zone ('Z' or ±hh:mm) and a real calendar
 * date and time. Anything else ('1', 'June 2099', '2026-02-30T00:00:00Z') is
 * refused: fail closed, never a satisfied clock or a far-future consent.
 */
export function instant(value: string, what: string): number {
  const match = ISO_INSTANT.exec(value);
  const refuse = (): never => {
    throw new ReferralError('INVALID_INSTANT', `${what} is not a valid instant: ${value}`);
  };
  if (match === null) return refuse();
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((index) =>
    Number(match[index] ?? '0'),
  ) as [number, number, number, number, number, number];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    Number(match[8] ?? '0') > 23 ||
    Number(match[9] ?? '0') > 59
  ) {
    return refuse();
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return refuse();
  return parsed;
}

export function daysBetween(from: string, to: string): number {
  return Math.floor((instant(to, 'end instant') - instant(from, 'start instant')) / DAY_MS);
}

const STATE_NAMES: Readonly<Record<string, string>> = {
  ALABAMA: 'AL',
  ALASKA: 'AK',
  ARIZONA: 'AZ',
  ARKANSAS: 'AR',
  CALIFORNIA: 'CA',
  COLORADO: 'CO',
  CONNECTICUT: 'CT',
  DELAWARE: 'DE',
  'DISTRICT OF COLUMBIA': 'DC',
  FLORIDA: 'FL',
  GEORGIA: 'GA',
  HAWAII: 'HI',
  IDAHO: 'ID',
  ILLINOIS: 'IL',
  INDIANA: 'IN',
  IOWA: 'IA',
  KANSAS: 'KS',
  KENTUCKY: 'KY',
  LOUISIANA: 'LA',
  MAINE: 'ME',
  MARYLAND: 'MD',
  MASSACHUSETTS: 'MA',
  MICHIGAN: 'MI',
  MINNESOTA: 'MN',
  MISSISSIPPI: 'MS',
  MISSOURI: 'MO',
  MONTANA: 'MT',
  NEBRASKA: 'NE',
  NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM',
  'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC',
  'NORTH DAKOTA': 'ND',
  OHIO: 'OH',
  OKLAHOMA: 'OK',
  OREGON: 'OR',
  PENNSYLVANIA: 'PA',
  'PUERTO RICO': 'PR',
  'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN',
  TEXAS: 'TX',
  UTAH: 'UT',
  VERMONT: 'VT',
  VIRGINIA: 'VA',
  WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI',
  WYOMING: 'WY',
};
const STATE_CODES = new Set(Object.values(STATE_NAMES));

/**
 * Resolve a patient state to its two-letter code: codes match case- and
 * space-insensitively ('mn', ' Mn ') and full names map to codes
 * ('Minnesota' → 'MN'). Anything else returns null, and a send holds on it.
 */
export function resolveState(state: string): string | null {
  const key = state.trim().replace(/\s+/g, ' ').toUpperCase();
  if (STATE_CODES.has(key)) return key;
  return STATE_NAMES[key] ?? null;
}

/** The stored form: the resolved code, or the trimmed input when it is not a known state. */
export function normalizeState(state: string): string {
  return resolveState(state) ?? state.trim().toUpperCase();
}

function rank(stage: LoopStage): number {
  return LOOP_STAGES.indexOf(stage);
}

function assertOpen(referral: ReferralCase): void {
  if (referral.stage === 'closed') {
    throw new ReferralError('LOOP_CLOSED', `referral ${referral.referralId} is closed`);
  }
}

function activeHold(referral: ReferralCase, reason: HoldReason): boolean {
  return referral.holds.some((hold) => hold.reason === reason && hold.released === null);
}

function stageAt(referral: ReferralCase, stage: LoopStage): string | null {
  return referral.stages.findLast((event) => event.stage === stage)?.at ?? null;
}

function notify(
  referral: ReferralCase,
  at: string,
  stage: ReferrerNotice['stage'],
  detail: string,
  channel: Channel,
): ReferralCase {
  if (referral.referrerUpdatesOptOut) {
    return referral;
  }
  const notice: ReferrerNotice = { at, referrerNpi: referral.referringNpi, stage, channel, detail };
  return { ...referral, notices: [...referral.notices, notice] };
}

function referrerChannel(directory: PinnedDirectory, npi: string): Channel {
  return directory.lookup(npi).espAddress === null ? 'fax' : 'esp';
}

function hold(
  referral: ReferralCase,
  reason: HoldReason,
  at: string,
  detail: string,
): ReferralCase {
  if (activeHold(referral, reason)) {
    return referral;
  }
  return {
    ...referral,
    holds: [...referral.holds, { reason, at, released: null, detail }],
  };
}

function advance(
  referral: ReferralCase,
  stage: LoopStage,
  at: string,
  actor: string,
  evidenceRef: string | null,
): ReferralCase {
  if (rank(stage) <= rank(referral.stage)) {
    throw new ReferralError(
      'STAGE_ORDER',
      `referral ${referral.referralId} cannot move from ${referral.stage} to ${stage}`,
    );
  }
  return {
    ...referral,
    stage,
    stages: [...referral.stages, { stage, at, actor, evidenceRef }],
  };
}

export interface OpenReferralInput {
  readonly referralId: string;
  readonly tenantId: string;
  readonly patientRef: string;
  readonly patientState: string;
  readonly referringNpi: string;
  readonly destinationNpi: string;
  readonly reason: string;
  readonly urgency: Urgency;
  readonly location: string;
  readonly expectedReturnDays: number;
  readonly assignedReviewerId: string;
  readonly referrerUpdatesOptOut: boolean;
  readonly coordinatorId: string;
  readonly at: string;
}

/**
 * Open a loop against the pinned directory. A referral with no clinical
 * reason is not silently accepted: it opens on a `missing-information` hold
 * and the referrer is asked for it (REQ-REF-005 EX3).
 */
export function openReferral(input: OpenReferralInput, directory: PinnedDirectory): ReferralCase {
  instant(input.at, 'open instant');
  directory.lookup(input.referringNpi);
  const destination = directory.lookup(input.destinationNpi);
  if (!destination.active) {
    throw new ReferralError(
      'DESTINATION_INACTIVE',
      `destination ${destination.npi} is inactive in ${directory.version}`,
    );
  }
  const opened: ReferralCase = {
    referralId: input.referralId,
    tenantId: input.tenantId,
    patientRef: input.patientRef,
    patientState: normalizeState(input.patientState),
    referringNpi: input.referringNpi,
    destinationNpi: input.destinationNpi,
    directoryVersion: directory.version,
    reason: input.reason,
    urgency: input.urgency,
    location: input.location,
    expectedReturnDays: input.expectedReturnDays,
    referrerUpdatesOptOut: input.referrerUpdatesOptOut,
    stage: 'created',
    stages: [{ stage: 'created', at: input.at, actor: input.coordinatorId, evidenceRef: null }],
    holds: [],
    outreach: [],
    notices: [],
    disclosures: [],
    consultNoteRef: null,
    review: null,
    assignedReviewerId: input.assignedReviewerId,
    closure: null,
    escalations: [],
  };
  if (input.reason.trim() === '') {
    const held = hold(opened, 'missing-information', input.at, 'reason for referral is missing');
    return notify(
      held,
      input.at,
      'hold',
      'referral returned: reason for referral is required',
      referrerChannel(directory, input.referringNpi),
    );
  }
  return opened;
}

export function releaseHold(referral: ReferralCase, reason: HoldReason, at: string): ReferralCase {
  assertOpen(referral);
  instant(at, 'release instant');
  if (!activeHold(referral, reason)) {
    throw new ReferralError(
      'HOLD_MISSING',
      `referral ${referral.referralId} has no ${reason} hold`,
    );
  }
  return {
    ...referral,
    holds: referral.holds.map((existing) =>
      existing.reason === reason && existing.released === null
        ? { ...existing, released: at }
        : existing,
    ),
  };
}

export interface SendInput {
  readonly consent: ConsentEvidence | null;
  readonly records: readonly string[];
  readonly at: string;
  readonly coordinatorId: string;
}

export interface SendRails {
  readonly directory: PinnedDirectory;
  readonly fax: OutboundChannelPort;
  readonly esp: OutboundChannelPort;
  readonly blobs: Wp024BlobPort;
}

/**
 * Send the records packet. Consent is checked before a single byte is stored
 * or transmitted; a failed transport leaves the loop at `created` on a
 * visible `send-failed` hold (REQ-REF-014 AC2, EX1).
 */
export function sendReferral(
  referral: ReferralCase,
  input: SendInput,
  rails: SendRails,
): ReferralCase {
  assertOpen(referral);
  if (referral.stage !== 'created') {
    throw new ReferralError('STAGE_ORDER', `referral ${referral.referralId} was already sent`);
  }
  if (activeHold(referral, 'missing-information')) {
    throw new ReferralError('HOLD_ACTIVE', 'missing information must be resolved before sending');
  }
  const sendAt = instant(input.at, 'send instant');
  const consent = input.consent;
  // Fail closed: consent must name this tenant, patient and recipient, and an
  // unparseable expiry never counts as current.
  let expiresAt = Number.NaN;
  if (consent !== null) {
    try {
      expiresAt = instant(consent.expiresAt, 'consent expiry');
    } catch {
      expiresAt = Number.NaN;
    }
  }
  if (
    consent === null ||
    consent.tenantId !== referral.tenantId ||
    consent.patientRef !== referral.patientRef ||
    consent.recipientNpi !== referral.destinationNpi ||
    Number.isNaN(expiresAt) ||
    expiresAt <= sendAt
  ) {
    return hold(referral, 'consent-required', input.at, 'no current consent for this disclosure');
  }
  const patientState = resolveState(referral.patientState);
  if (patientState === null) {
    return hold(
      referral,
      'patient-state-unknown',
      input.at,
      `patient state '${referral.patientState}' is not a known state; records are not released`,
    );
  }
  if (patientState === 'MN' && !consent.writtenMn) {
    return hold(
      referral,
      'mn-written-consent-required',
      input.at,
      'Minnesota record: written consent is required before release',
    );
  }
  const destination = rails.directory.lookup(referral.destinationNpi);
  const port =
    destination.espAddress !== null ? rails.esp : destination.fax !== null ? rails.fax : null;
  const address = destination.espAddress ?? destination.fax;
  if (port === null || address === null) {
    return hold(referral, 'send-failed', input.at, 'destination has no fax or ESP address on file');
  }
  const artifactRefs = input.records.map((bytes) => rails.blobs.put(referral.tenantId, bytes));
  const receipt = port.send({
    referralId: referral.referralId,
    address,
    artifactRefs,
    at: input.at,
  });
  if (receipt.status !== 'delivered') {
    return hold(referral, 'send-failed', input.at, `${receipt.channel} ${receipt.status}`);
  }
  let sent = referral;
  for (const reason of [
    'consent-required',
    'mn-written-consent-required',
    'send-failed',
  ] as const) {
    if (activeHold(sent, reason)) {
      sent = releaseHold(sent, reason, input.at);
    }
  }
  sent = advance(sent, 'sent', input.at, input.coordinatorId, receipt.transmissionId);
  sent = {
    ...sent,
    disclosures: [
      ...sent.disclosures,
      {
        at: input.at,
        recipientNpi: referral.destinationNpi,
        consentRef: consent.consentRef,
        channel: receipt.channel,
        transmissionId: receipt.transmissionId,
        artifactRefs,
      },
    ],
  };
  return notify(
    sent,
    input.at,
    'sent',
    'referral sent; awaiting confirmation',
    referrerChannel(rails.directory, referral.referringNpi),
  );
}

export interface EventContext {
  readonly directory: PinnedDirectory;
  readonly notes: Wp060ConsultNotePort;
}

/**
 * Apply an inbound partner event. Stages only move forward (a fax-only
 * partner may skip acknowledgement). A consult note must be finalized and
 * match this referral and patient; anything else is refused for human
 * resolution (REQ-REF-003 EX1).
 */
export function applyPartnerEvent(
  referral: ReferralCase,
  event: PartnerEvent,
  context: EventContext,
): ReferralCase {
  assertOpen(referral);
  if (event.referralId !== referral.referralId || event.patientRef !== referral.patientRef) {
    throw new ReferralError(
      'EVENT_MISMATCH',
      `event does not match referral ${referral.referralId}`,
    );
  }
  if (referral.stage === 'created') {
    throw new ReferralError('STAGE_ORDER', 'a partner event cannot precede the send');
  }
  instant(event.at, 'event instant');
  const channel = referrerChannel(context.directory, referral.referringNpi);
  switch (event.kind) {
    case 'acknowledged':
    case 'scheduled':
    case 'seen': {
      let next = advance(referral, event.kind, event.at, event.channel, event.evidenceRef);
      if (event.kind === 'seen' && activeHold(next, 'patient-follow-up')) {
        next = releaseHold(next, 'patient-follow-up', event.at);
      }
      return notify(next, event.at, event.kind, event.detail, channel);
    }
    case 'consult-note': {
      if (event.consultNoteRef === null) {
        throw new ReferralError('NOTE_MISSING', 'consult-note event has no note reference');
      }
      const note = context.notes.get(event.consultNoteRef);
      if (
        note.referralId !== referral.referralId ||
        note.patientRef !== referral.patientRef ||
        note.tenantId !== referral.tenantId
      ) {
        throw new ReferralError(
          'NOTE_MISMATCH',
          `note ${note.noteRef} belongs to another referral`,
        );
      }
      if (!note.finalized) {
        throw new ReferralError('NOTE_NOT_FINAL', `note ${note.noteRef} is not finalized`);
      }
      const next = advance(
        referral,
        'results-returned',
        event.at,
        event.channel,
        event.evidenceRef,
      );
      return notify(
        { ...next, consultNoteRef: note.noteRef },
        event.at,
        'results-returned',
        'consult note received; awaiting referring review',
        channel,
      );
    }
    case 'declined': {
      // A decline can only end a loop that has no returned results: once a consult
      // note is back, only the referring review may close it (closure invariant 2).
      if (rank(referral.stage) >= rank('results-returned')) {
        throw new ReferralError(
          'DECLINE_AFTER_RESULTS',
          `referral ${referral.referralId} has returned results awaiting review`,
        );
      }
      // Once the patient has been seen, results can still return: the decline is
      // recorded and escalated, the loop stays open, and a later consult note is
      // accepted and must be reviewed (closure invariant 2).
      if (rank(referral.stage) >= rank('seen')) {
        const noted = escalate(
          referral,
          event.at,
          'referral-coordinator',
          `destination declined after the visit: ${event.detail}; results may still return`,
        );
        return notify(noted, event.at, 'hold', `declined after visit: ${event.detail}`, channel);
      }
      const closed: ReferralCase = {
        ...referral,
        stage: 'closed',
        stages: [
          ...referral.stages,
          { stage: 'closed', at: event.at, actor: event.channel, evidenceRef: event.evidenceRef },
        ],
        closure: { reason: 'declined-by-destination', at: event.at },
      };
      return notify(closed, event.at, 'closed', `declined: ${event.detail}`, channel);
    }
    case 'no-show': {
      const held = hold(referral, 'patient-follow-up', event.at, 'patient did not attend');
      return notify(held, event.at, 'hold', 'patient did not attend the referred visit', channel);
    }
  }
}

export function logOutreach(referral: ReferralCase, attempt: OutreachAttempt): ReferralCase {
  assertOpen(referral);
  instant(attempt.at, 'outreach instant');
  return { ...referral, outreach: [...referral.outreach, attempt] };
}

export function escalate(
  referral: ReferralCase,
  at: string,
  to: string,
  why: string,
): ReferralCase {
  assertOpen(referral);
  instant(at, 'escalation instant');
  if (referral.escalations.some((existing) => existing.to === to && existing.why === why)) {
    return referral;
  }
  return { ...referral, escalations: [...referral.escalations, { at, to, why }] };
}

/** The review routes to whoever is currently assigned, not only the orderer (REQ-REF-015 EX5). */
export function reassignReviewer(referral: ReferralCase, reviewerId: string): ReferralCase {
  assertOpen(referral);
  return { ...referral, assignedReviewerId: reviewerId };
}

export function reviewResults(
  referral: ReferralCase,
  reviewerId: string,
  at: string,
): ReferralCase {
  assertOpen(referral);
  instant(at, 'review instant');
  if (referral.stage !== 'results-returned' || referral.consultNoteRef === null) {
    throw new ReferralError('REVIEW_EARLY', 'there are no returned results to review');
  }
  if (reviewerId !== referral.assignedReviewerId) {
    throw new ReferralError('REVIEWER', `${reviewerId} is not the assigned reviewer`);
  }
  const reviewed = advance(referral, 'reviewed', at, reviewerId, referral.consultNoteRef);
  return {
    ...reviewed,
    review: { reviewerId, at, consultNoteRef: referral.consultNoteRef },
  };
}

function refuse(reason: ClosureReason, why: string): never {
  throw new ReferralError('CLOSURE_INVARIANT', `${reason}: ${why}`);
}

/** Close a loop. Every reason has its own evidence rule; see the file header. */
export function closeLoop(
  referral: ReferralCase,
  reason: Exclude<ClosureReason, 'declined-by-destination'>,
  at: string,
  actor: string,
  directory: PinnedDirectory,
): ReferralCase {
  assertOpen(referral);
  instant(at, 'closure instant');
  switch (reason) {
    case 'results-reviewed':
      if (referral.stage !== 'reviewed' || referral.review === null) {
        refuse(reason, 'the referring review of a matched consult note is required');
      }
      break;
    case 'no-results-after-outer-bound': {
      const sentAt = stageAt(referral, 'sent');
      if (sentAt === null || daysBetween(sentAt, at) < OUTER_BOUND_DAYS) {
        refuse(reason, `the ${String(OUTER_BOUND_DAYS)}-day outer bound has not elapsed`);
      }
      if (referral.outreach.length === 0) {
        refuse(reason, 'a documented follow-up attempt is required');
      }
      if (!referral.escalations.some((existing) => existing.to === 'referring-clinician')) {
        refuse(reason, 'the referring clinician must have been escalated to');
      }
      break;
    }
    case 'patient-non-engagement':
      if (referral.urgency === 'urgent') {
        refuse(reason, 'an urgent referral cannot close as patient non-engagement');
      }
      if (!activeHold(referral, 'patient-follow-up')) {
        refuse(reason, 'a patient follow-up hold is required');
      }
      if (referral.outreach.length < NON_ENGAGEMENT_MIN_ATTEMPTS) {
        refuse(reason, `${String(NON_ENGAGEMENT_MIN_ATTEMPTS)} documented attempts are required`);
      }
      if (
        !referral.referrerUpdatesOptOut &&
        !referral.notices.some((notice) => notice.stage === 'hold')
      ) {
        refuse(reason, 'the referring clinician must have been told of the non-engagement');
      }
      break;
  }
  const closed: ReferralCase = {
    ...referral,
    stage: 'closed',
    stages: [...referral.stages, { stage: 'closed', at, actor, evidenceRef: null }],
    closure: { reason, at },
  };
  return notify(
    closed,
    at,
    'closed',
    `loop closed: ${reason}`,
    referrerChannel(directory, referral.referringNpi),
  );
}

/**
 * Reopen a closed case in place (REQ-REF-011 AC3): history is kept, the loop
 * restarts at `created` with a new owner and must be sent again.
 */
export function reopenReferral(
  referral: ReferralCase,
  at: string,
  coordinatorId: string,
): ReferralCase {
  instant(at, 'reopen instant');
  if (referral.stage !== 'closed' || referral.closure === null) {
    throw new ReferralError('REOPEN', `referral ${referral.referralId} is not closed`);
  }
  if (referral.closure.reason === 'results-reviewed') {
    throw new ReferralError('REOPEN', 'a reviewed loop is complete; open a new referral');
  }
  return {
    ...referral,
    stage: 'created',
    stages: [
      ...referral.stages,
      { stage: 'created', at, actor: coordinatorId, evidenceRef: 'reopen' },
    ],
    closure: null,
    consultNoteRef: null,
    review: null,
  };
}

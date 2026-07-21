/**
 * canSend — the single send-time choke point (WP-018), plus the ConsentPort
 * the PDP consumes and the STOP/HELP keyword handler. Contract:
 * docs/contracts/cansend-api.md (FROZEN §canSend / §ConsentPort / §STOP/HELP).
 *
 * Fail-closed by construction (RSK-02): a null projection, an unavailable port,
 * and any non-opted-in state all DENY. Every canSend decision — allow AND deny
 * — carries a `consent-event`-stream audit input so post-STOP send prevention
 * is auditable across every channel (R6-REQ-024); live emission rides
 * FWD-AUD-021-OUTBOX.
 */

import type {
  ConsentChannel,
  ConsentEventInput,
  ConsentJurisdiction,
  ConsentPurpose,
  ConsentStateRow,
} from './consent.js';
import type { CommunicationOverlay } from './overlays.js';

export const consentDenialReasons = [
  'no-consent-on-record',
  'opted-out',
  'blocked',
  'consent-expired',
  'chd-opt-in-required',
  'consent-pending',
  'quiet-hours-deferred',
  'carrier-stop',
] as const;
export type ConsentDenialReason = (typeof consentDenialReasons)[number];

/** Structurally an @practicehub/audit-evidence AuditEmitInput (consent-event
 * stream). Kept local so the consent domain does not depend on audit-evidence
 * at runtime; the fixture suite proves it emits and chains. */
export interface ConsentAuditInput {
  readonly tenantId: string;
  readonly stream: 'consent-event';
  readonly action: string;
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly correlationRef: string;
  readonly decision: 'allow' | 'deny';
  readonly detail: Readonly<Record<string, string>>;
  readonly synthetic: true;
}

export interface CanSendInput {
  readonly tenantId: string;
  readonly personRef: string;
  readonly channel: ConsentChannel;
  readonly purpose: ConsentPurpose;
  /** The folded communication-scope projection row, or null when nothing is on
   * record (the fail-closed absent case). */
  readonly state: ConsentStateRow | null;
  readonly urgency: 'routine' | 'urgent';
  readonly asOf: string;
  /** Patient local hour 0..23 for quiet-hours; omitted = caller has no clock,
   * quiet-hours is skipped (the WP-044 comms surface computes the boundary). */
  readonly localHour?: number;
  readonly carrierStopSet?: boolean;
  readonly overlay?: CommunicationOverlay;
  /** Whether the governing opt-in came from an affirmative source. Defaults to
   * true; a conservatively-imported marketing consent may set it false so an
   * NV CHD send is refused (R6-SR-020 defence beyond the ledger CHECK). */
  readonly governingSourceAffirmative?: boolean;
  readonly actorRef: string;
  readonly occurredAt: string;
}

export interface ConsentDecision {
  readonly allow: boolean;
  readonly reason: ConsentDenialReason | 'allowed';
  readonly overlayObligations: readonly string[];
  readonly counselReviewPending: boolean;
  readonly auditInput: ConsentAuditInput;
}

function expiredAsOf(state: ConsentStateRow, asOf: string): boolean {
  if (state.currentState === 'expired') {
    return true;
  }
  return state.expiresAt !== undefined && Date.parse(state.expiresAt) <= Date.parse(asOf);
}

function decisionAudit(
  input: CanSendInput,
  allow: boolean,
  reason: ConsentDecision['reason'],
): ConsentAuditInput {
  return {
    tenantId: input.tenantId,
    stream: 'consent-event',
    action: allow ? 'send-permitted' : 'send-refused',
    actorRef: input.actorRef,
    occurredAt: input.occurredAt,
    // Grammar-safe pointer to the (person, communication scope); the audit ref
    // grammar forbids the `|`/`=` the scope key uses, so this is its ref form.
    correlationRef: `consent:${input.personRef}:${input.channel}:${input.purpose}`,
    decision: allow ? 'allow' : 'deny',
    detail: {
      channel: input.channel,
      purpose: input.purpose,
      urgency: input.urgency,
      reason,
    },
    synthetic: true,
  };
}

/**
 * The FROZEN resolution order (cansend-api.md). The first failing step decides
 * the deny reason; only a clean pass through all steps allows. No rail sends
 * without an `allow`.
 */
export function canSend(input: CanSendInput): ConsentDecision {
  const overlayObligations = input.overlay?.obligations ?? [];
  const counselReviewPending = input.overlay?.counselReviewPending ?? false;
  const decide = (allow: boolean, reason: ConsentDecision['reason']): ConsentDecision => ({
    allow,
    reason,
    overlayObligations,
    counselReviewPending,
    auditInput: decisionAudit(input, allow, reason),
  });

  const state = input.state;
  // 1. Absent — fail closed (RSK-02). An empty ledger never permits a send.
  if (state === null) {
    return decide(false, 'no-consent-on-record');
  }
  // 2. Explicit opt-out / compliance block.
  if (state.currentState === 'opted_out') {
    return decide(false, 'opted-out');
  }
  if (state.currentState === 'blocked') {
    return decide(false, 'blocked');
  }
  // 3. Expiry (MHRA auto-block, R6-SR-041) — a lapsed consent is expired at
  // send-time even before an expire event materializes.
  if (expiredAsOf(state, input.asOf)) {
    return decide(false, 'consent-expired');
  }
  // 4. CHD opt-in (R6-SR-020 / NV SB370): a marketing send in a CHD-opt-in
  // jurisdiction refuses when the governing opt-in is not affirmative.
  if (
    input.purpose === 'marketing' &&
    input.overlay?.chdOptInRequired === true &&
    input.governingSourceAffirmative === false
  ) {
    return decide(false, 'chd-opt-in-required');
  }
  // 5. Pending — a non-urgent send waits; urgent treatment may proceed.
  if (state.currentState === 'pending' && input.urgency !== 'urgent') {
    return decide(false, 'consent-pending');
  }
  // 6. Quiet hours — unless urgent treatment (the minute-boundary UX is WP-044).
  if (
    input.localHour !== undefined &&
    (input.localHour < 8 || input.localHour >= 21) &&
    !(input.urgency === 'urgent' && input.purpose === 'treatment')
  ) {
    return decide(false, 'quiet-hours-deferred');
  }
  // 7. Carrier STOP (sms) — defence in depth beside the ledger opt-out.
  if (input.channel === 'sms' && input.carrierStopSet === true) {
    return decide(false, 'carrier-stop');
  }
  return decide(true, 'allowed');
}

export type ConsentAnswer = 'granted' | 'denied' | 'unavailable';

export interface DisclosurePortInput {
  /** The folded disclosure-scope projection row, or null (fail-closed). */
  readonly state: ConsentStateRow | null;
  readonly asOf: string;
  /** Whether specific written authorization is on record for a genetic
   * disclosure (R6-SR-031). Defaults to true (the ledger CHECK guarantees it
   * for a live grant); a migrated gap can set it false to refuse. */
  readonly writtenAuthorizationOnRecord?: boolean;
}

/**
 * ConsentPort (discharges FWD-PDP-018-CONSENT): the LIVE ledger answer the PDP
 * consumes for disclosure decisions. Only a live, unexpired, opted-in (and, for
 * genetic, evidenced) consent is `granted`; everything else — including a null
 * ledger — fails closed to `denied`/`unavailable`, which the PDP treats as DENY
 * (pdp-api.md decision 9).
 */
export function consentForDisclosure(input: DisclosurePortInput): ConsentAnswer {
  const state = input.state;
  if (state === null) {
    return 'unavailable';
  }
  if (expiredAsOf(state, input.asOf)) {
    return 'denied';
  }
  if (state.currentState !== 'opted_in') {
    return 'denied';
  }
  if (state.recordType === 'genetic' && input.writtenAuthorizationOnRecord === false) {
    return 'denied';
  }
  return 'granted';
}

export const stopKeywords = ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'QUIT', 'END', 'STOPALL'] as const;
export const helpKeywords = ['HELP', 'INFO'] as const;
export const startKeywords = ['START', 'UNSTOP', 'YES'] as const;

/** Purposes a STOP halts — non-treatment SMS is halted; treatment (care) is not
 * dropped by a generic keyword (REQ-COMM-005 scope, REQ-COMM-023 care continuity
 * is WP-044). */
export const stopScopePurposes: readonly ConsentPurpose[] = ['marketing', 'operations', 'payment'];
/** Purposes a START restores over a keyword — transactional only; marketing
 * needs an affirmative opt-in elsewhere (NV SB370), never a bare keyword. */
export const startScopePurposes: readonly ConsentPurpose[] = ['operations', 'payment'];

const purposeAbbrev: Readonly<Record<ConsentPurpose, string>> = {
  treatment: 'tx',
  payment: 'pm',
  operations: 'op',
  marketing: 'mk',
};

export interface KeywordInput {
  readonly personRef: string;
  readonly channel: ConsentChannel;
  readonly keyword: string;
  readonly idBase: string;
  readonly inboundEvidenceRef: string;
  readonly jurisdiction: ConsentJurisdiction;
  readonly policyVersion: string;
  readonly effectiveAt: string;
  readonly quietHoursTz?: string;
}

export type KeywordOutcome =
  | { readonly kind: 'revoke'; readonly events: readonly ConsentEventInput[] }
  | { readonly kind: 'grant'; readonly events: readonly ConsentEventInput[] }
  | { readonly kind: 'help'; readonly template: 'org-help' }
  | { readonly kind: 'unrecognized' };

function keywordEvents(
  input: KeywordInput,
  action: 'revoke' | 'grant',
  purposes: readonly ConsentPurpose[],
): readonly ConsentEventInput[] {
  return purposes.map((purpose) => ({
    consentEventId: `${input.idBase}-${purposeAbbrev[purpose]}`,
    tenantId: '',
    personRef: input.personRef,
    scope: { type: 'communication' as const, channel: input.channel, purpose },
    action,
    effectiveAt: input.effectiveAt,
    source: 'sms_keyword' as const,
    evidenceRef: input.inboundEvidenceRef,
    jurisdiction: input.jurisdiction,
    policyVersion: input.policyVersion,
    ...(input.quietHoursTz !== undefined ? { quietHoursTz: input.quietHoursTz } : {}),
    synthetic: true as const,
  }));
}

/**
 * STOP/HELP/START handling (TCPA-standard). STOP writes revoke events for the
 * channel across non-treatment purposes, carrying the inbound message as
 * evidence — opt-out always lands and is never capability-gated. HELP returns
 * the org template. START re-grants transactional purposes only. The caller
 * finalizes tenant id and appends the returned events.
 */
export function applyKeyword(input: KeywordInput): KeywordOutcome {
  const normalized = input.keyword.trim().toUpperCase();
  if ((stopKeywords as readonly string[]).includes(normalized)) {
    return { kind: 'revoke', events: keywordEvents(input, 'revoke', stopScopePurposes) };
  }
  if ((helpKeywords as readonly string[]).includes(normalized)) {
    return { kind: 'help', template: 'org-help' };
  }
  if ((startKeywords as readonly string[]).includes(normalized)) {
    return { kind: 'grant', events: keywordEvents(input, 'grant', startScopePurposes) };
  }
  return { kind: 'unrecognized' };
}

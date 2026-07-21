/**
 * Consent ledger (WP-018, M03). Contract: docs/contracts/cansend-api.md
 * (FROZEN) + docs/contracts/consent-ledger-schema.md (§4).
 *
 * `consent_event` is the immutable append-only spine; `consent_state` is a
 * derived projection that is a PURE function of the log — foldConsentState
 * rebuilds it exactly (R6-REQ-071 replay-rebuild equivalence), and
 * reconstructStateAt reproduces any point-in-time (R6-SR-042). Two scope axes
 * ride one spine: `communication` (channel x purpose — the canSend axis) and
 * `disclosure` (purpose x recipient x record-type — the ConsentPort axis).
 *
 * The domain is decoupled: person_ref, recipient, and evidence are soft
 * grammar-checked references, never cross-module imports.
 */

export const consentChannels = ['sms', 'voice', 'ai_voice', 'email', 'fax', 'portal'] as const;
export type ConsentChannel = (typeof consentChannels)[number];

export const consentPurposes = ['treatment', 'payment', 'operations', 'marketing'] as const;
export type ConsentPurpose = (typeof consentPurposes)[number];

export const consentStateValues = [
  'opted_in',
  'opted_out',
  'pending',
  'expired',
  'blocked',
] as const;
export type ConsentStateValue = (typeof consentStateValues)[number];

export const consentActions = ['grant', 'revoke', 'expire', 'block', 'unblock', 'renew'] as const;
export type ConsentAction = (typeof consentActions)[number];

export const consentSources = [
  'portal_form',
  'sms_keyword',
  'verbal_documented',
  'paper_form',
  'api_import',
  'staff_entry',
  'double_optin',
  'web_form',
] as const;
export type ConsentSource = (typeof consentSources)[number];

/** Sources that count as an affirmative opt-in (CHD opt-in floor, R6-SR-020). */
export const affirmativeConsentSources: readonly ConsentSource[] = [
  'portal_form',
  'paper_form',
  'double_optin',
  'web_form',
  'verbal_documented',
];

export const consentRecordTypes = [
  'general',
  'genetic',
  'mental-health',
  'substance-use',
  'all',
] as const;
export type ConsentRecordType = (typeof consentRecordTypes)[number];

export const consentJurisdictions = ['NV', 'FL', 'IL', 'MN', 'virtual'] as const;
export type ConsentJurisdiction = (typeof consentJurisdictions)[number];

export const consentPartitionTags = ['gipa-genetic', 'chd', 'biometric', 'part2'] as const;
export type ConsentPartitionTag = (typeof consentPartitionTags)[number];

export type ConsentScope =
  | {
      readonly type: 'communication';
      readonly channel: ConsentChannel;
      readonly purpose: ConsentPurpose;
    }
  | {
      readonly type: 'disclosure';
      readonly purpose: ConsentPurpose;
      readonly recipient: string;
      readonly recordType: ConsentRecordType;
    };

export class ConsentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConsentError';
  }
}

const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const scopeKeyPattern = /^[a-z0-9][a-z0-9|:._=/-]{0,254}$/;
const hashPattern = /^[0-9a-f]{64}$/;

/**
 * Deterministic projection key. Communication and disclosure scopes never
 * collide (the leading discriminator differs), and the key round-trips through
 * the DB scope_key grammar.
 */
export function canonicalConsentScopeKey(scope: ConsentScope): string {
  if (scope.type === 'communication') {
    return `communication|channel=${scope.channel}|purpose=${scope.purpose}`;
  }
  return `disclosure|purpose=${scope.purpose}|recipient=${scope.recipient}|record=${scope.recordType}`;
}

/** grant/renew -> opted_in, revoke -> opted_out, expire -> expired, block ->
 * blocked, unblock -> pending. The one place the action->state map lives; the
 * DB CHECK mirrors it. */
export function resultingStateForAction(action: ConsentAction): ConsentStateValue {
  switch (action) {
    case 'grant':
    case 'renew':
      return 'opted_in';
    case 'revoke':
      return 'opted_out';
    case 'expire':
      return 'expired';
    case 'block':
      return 'blocked';
    case 'unblock':
      return 'pending';
    default: {
      const exhaustive: never = action;
      throw new ConsentError(`unknown consent action ${JSON.stringify(exhaustive)}`);
    }
  }
}

export interface ConsentEventInput {
  readonly consentEventId: string;
  readonly tenantId: string;
  readonly personRef: string;
  readonly scope: ConsentScope;
  readonly action: ConsentAction;
  readonly effectiveAt: string;
  readonly expiresAt?: string;
  readonly source: ConsentSource;
  readonly evidenceRef?: string;
  readonly evidenceHash?: string;
  readonly capturedBy?: string;
  readonly jurisdiction: ConsentJurisdiction;
  readonly policyVersion: string;
  readonly quietHoursTz?: string;
  readonly partitionTags?: readonly ConsentPartitionTag[];
  readonly occurredAt?: string;
  readonly synthetic: true;
}

export interface ConsentEvent {
  readonly consentEventId: string;
  readonly tenantId: string;
  readonly personRef: string;
  readonly scopeType: ConsentScope['type'];
  readonly scopeKey: string;
  readonly channel?: ConsentChannel;
  readonly purpose: ConsentPurpose;
  readonly recipientRef?: string;
  readonly recordType?: ConsentRecordType;
  readonly action: ConsentAction;
  readonly resultingState: ConsentStateValue;
  readonly effectiveAt: string;
  readonly expiresAt?: string;
  readonly source: ConsentSource;
  readonly evidenceRef?: string;
  readonly evidenceHash?: string;
  readonly capturedBy?: string;
  readonly jurisdiction: ConsentJurisdiction;
  readonly policyVersion: string;
  readonly quietHoursTz: string;
  readonly partitionTags: readonly ConsentPartitionTag[];
  readonly occurredAt: string;
  readonly synthetic: true;
}

export interface ConsentStateRow {
  readonly tenantId: string;
  readonly personRef: string;
  readonly scopeKey: string;
  readonly scopeType: ConsentScope['type'];
  readonly channel?: ConsentChannel;
  readonly purpose: ConsentPurpose;
  readonly recipientRef?: string;
  readonly recordType?: ConsentRecordType;
  readonly currentState: ConsentStateValue;
  readonly effectiveAt: string;
  readonly expiresAt?: string;
  readonly lastEventId: string;
  readonly quietHoursTz: string;
  readonly jurisdiction: ConsentJurisdiction;
  readonly synthetic: true;
}

function assertIso(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new ConsentError(`${label} must be an ISO timestamp; received ${JSON.stringify(value)}`);
  }
}

/**
 * Validate + materialize ONE event (deriving scopeKey, scopeType, resulting
 * state) and append it to the log. Refuses an unknown/ill-formed event at LOAD
 * — the structural rules mirror the DB CHECKs so a domain build and a DB write
 * fail for the same reasons.
 */
export function appendConsentEvent(
  log: readonly ConsentEvent[],
  input: ConsentEventInput,
): { readonly event: ConsentEvent; readonly log: readonly ConsentEvent[] } {
  if (!idPattern.test(input.consentEventId)) {
    throw new ConsentError(`consentEventId ${JSON.stringify(input.consentEventId)} is malformed`);
  }
  if (!refPattern.test(input.personRef)) {
    throw new ConsentError(`personRef ${JSON.stringify(input.personRef)} is malformed`);
  }
  if (!consentActions.includes(input.action)) {
    throw new ConsentError(`unknown consent action ${JSON.stringify(input.action)}`);
  }
  if (!consentSources.includes(input.source)) {
    throw new ConsentError(`unknown consent source ${JSON.stringify(input.source)}`);
  }
  if (!consentJurisdictions.includes(input.jurisdiction)) {
    throw new ConsentError(`unknown jurisdiction ${JSON.stringify(input.jurisdiction)}`);
  }
  if (input.policyVersion.trim() === '') {
    throw new ConsentError('policyVersion is required');
  }
  assertIso(input.effectiveAt, 'effectiveAt');
  if (input.expiresAt !== undefined) {
    assertIso(input.expiresAt, 'expiresAt');
    if (Date.parse(input.expiresAt) < Date.parse(input.effectiveAt)) {
      throw new ConsentError('expiresAt precedes effectiveAt');
    }
  }
  if (input.evidenceRef !== undefined && !refPattern.test(input.evidenceRef)) {
    throw new ConsentError(`evidenceRef ${JSON.stringify(input.evidenceRef)} is malformed`);
  }
  if (input.evidenceHash !== undefined && !hashPattern.test(input.evidenceHash)) {
    throw new ConsentError('evidenceHash must be a sha-256 hex digest');
  }
  if (input.capturedBy !== undefined && !refPattern.test(input.capturedBy)) {
    throw new ConsentError(`capturedBy ${JSON.stringify(input.capturedBy)} is malformed`);
  }
  const partitionTags = input.partitionTags ?? [];
  for (const tag of partitionTags) {
    if (!consentPartitionTags.includes(tag)) {
      throw new ConsentError(`unknown partition tag ${JSON.stringify(tag)}`);
    }
  }

  const scope = input.scope;
  let channel: ConsentChannel | undefined;
  let recipientRef: string | undefined;
  let recordType: ConsentRecordType | undefined;
  if (scope.type === 'communication') {
    if (!consentChannels.includes(scope.channel)) {
      throw new ConsentError(`unknown channel ${JSON.stringify(scope.channel)}`);
    }
    channel = scope.channel;
  } else if (scope.type === 'disclosure') {
    if (!refPattern.test(scope.recipient)) {
      throw new ConsentError(`recipient ${JSON.stringify(scope.recipient)} is malformed`);
    }
    if (!consentRecordTypes.includes(scope.recordType)) {
      throw new ConsentError(`unknown recordType ${JSON.stringify(scope.recordType)}`);
    }
    recipientRef = scope.recipient;
    recordType = scope.recordType;
  } else {
    throw new ConsentError(
      `unknown scope type ${JSON.stringify((scope as { type: string }).type)}`,
    );
  }
  if (!consentPurposes.includes(scope.purpose)) {
    throw new ConsentError(`unknown purpose ${JSON.stringify(scope.purpose)}`);
  }

  const isGrantLike = input.action === 'grant' || input.action === 'renew';
  const affirmative =
    affirmativeConsentSources.includes(input.source) && input.evidenceRef !== undefined;

  // Marketing opt-in floor (R6-SR-020 / NV SB370): a marketing GRANT needs an
  // affirmative evidenced source — never inherited from a treatment grant.
  if (scope.purpose === 'marketing' && input.action === 'grant' && !affirmative) {
    throw new ConsentError(
      'a marketing grant requires an affirmative, evidenced source (CHD opt-in floor)',
    );
  }
  // Genetic authorization (R6-SR-031): a genetic grant/renew needs specific
  // written authorization evidence.
  const isGenetic = recordType === 'genetic' || partitionTags.includes('gipa-genetic');
  if (isGrantLike && isGenetic && input.evidenceRef === undefined) {
    throw new ConsentError('a genetic consent requires specific written authorization evidence');
  }
  // Disclosure written consent (R6-SR-040 MHRA): a disclosure GRANT needs
  // written consent evidence.
  if (scope.type === 'disclosure' && input.action === 'grant' && input.evidenceRef === undefined) {
    throw new ConsentError('a records-disclosure grant requires written consent evidence');
  }

  const scopeKey = canonicalConsentScopeKey(scope);
  if (!scopeKeyPattern.test(scopeKey)) {
    throw new ConsentError(`scope key ${JSON.stringify(scopeKey)} is malformed`);
  }

  const event: ConsentEvent = {
    consentEventId: input.consentEventId,
    tenantId: input.tenantId,
    personRef: input.personRef,
    scopeType: scope.type,
    scopeKey,
    ...(channel !== undefined ? { channel } : {}),
    purpose: scope.purpose,
    ...(recipientRef !== undefined ? { recipientRef } : {}),
    ...(recordType !== undefined ? { recordType } : {}),
    action: input.action,
    resultingState: resultingStateForAction(input.action),
    effectiveAt: input.effectiveAt,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    source: input.source,
    ...(input.evidenceRef !== undefined ? { evidenceRef: input.evidenceRef } : {}),
    ...(input.evidenceHash !== undefined ? { evidenceHash: input.evidenceHash } : {}),
    ...(input.capturedBy !== undefined ? { capturedBy: input.capturedBy } : {}),
    jurisdiction: input.jurisdiction,
    policyVersion: input.policyVersion,
    quietHoursTz: input.quietHoursTz ?? 'UTC',
    partitionTags,
    occurredAt: input.occurredAt ?? input.effectiveAt,
    synthetic: true,
  };
  return { event, log: [...log, event] };
}

const stateKey = (personRef: string, scopeKey: string): string => `${personRef} ${scopeKey}`;

function projectRow(event: ConsentEvent): ConsentStateRow {
  return {
    tenantId: event.tenantId,
    personRef: event.personRef,
    scopeKey: event.scopeKey,
    scopeType: event.scopeType,
    ...(event.channel !== undefined ? { channel: event.channel } : {}),
    purpose: event.purpose,
    ...(event.recipientRef !== undefined ? { recipientRef: event.recipientRef } : {}),
    ...(event.recordType !== undefined ? { recordType: event.recordType } : {}),
    currentState: event.resultingState,
    effectiveAt: event.effectiveAt,
    ...(event.expiresAt !== undefined ? { expiresAt: event.expiresAt } : {}),
    lastEventId: event.consentEventId,
    quietHoursTz: event.quietHoursTz,
    jurisdiction: event.jurisdiction,
    synthetic: true,
  };
}

/** True when `left` is the governing event over `right` — later effectiveAt
 * wins; an equal effectiveAt breaks to the later append (log order). */
function governs(
  left: ConsentEvent,
  leftIndex: number,
  right: ConsentEvent,
  rightIndex: number,
): boolean {
  const leftMs = Date.parse(left.effectiveAt);
  const rightMs = Date.parse(right.effectiveAt);
  if (leftMs !== rightMs) {
    return leftMs > rightMs;
  }
  return leftIndex >= rightIndex;
}

/**
 * Fold the event log into the projection: one row per (person_ref, scope_key),
 * carrying the governing event's resolved state. A pure function of the log —
 * the DB projection is exactly this (drift-tested both ways).
 */
export function foldConsentState(events: readonly ConsentEvent[]): Map<string, ConsentStateRow> {
  const winners = new Map<string, { event: ConsentEvent; index: number }>();
  events.forEach((event, index) => {
    const key = stateKey(event.personRef, event.scopeKey);
    const current = winners.get(key);
    if (current === undefined || governs(event, index, current.event, current.index)) {
      winners.set(key, { event, index });
    }
  });
  const projection = new Map<string, ConsentStateRow>();
  for (const [key, winner] of winners) {
    projection.set(key, projectRow(winner.event));
  }
  return projection;
}

/** The governing projection row for one (person, scope) — null if the ledger
 * carries nothing (the fail-closed absent case). */
export function resolveConsentState(
  events: readonly ConsentEvent[],
  personRef: string,
  scope: ConsentScope,
): ConsentStateRow | null {
  const projection = foldConsentState(events);
  return projection.get(stateKey(personRef, canonicalConsentScopeKey(scope))) ?? null;
}

/**
 * Point-in-time reconstruction (R6-SR-042): fold only the events effective at
 * or before `asOf`, so the ledger answers "what did this person's consent look
 * like as of T" for disputes and audits — even for a scope with later events.
 */
export function reconstructStateAt(
  events: readonly ConsentEvent[],
  personRef: string,
  scope: ConsentScope,
  asOf: string,
): ConsentStateRow | null {
  assertIso(asOf, 'asOf');
  const asOfMs = Date.parse(asOf);
  const eligible = events.filter((event) => Date.parse(event.effectiveAt) <= asOfMs);
  const projection = foldConsentState(eligible);
  return projection.get(stateKey(personRef, canonicalConsentScopeKey(scope))) ?? null;
}

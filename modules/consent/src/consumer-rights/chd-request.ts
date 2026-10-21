/**
 * NV SB 370 consumer-health-data (CHD) rights requests (R6-SR-022,
 * REQ-PORT-001): request -> verify -> act -> appeal.
 *
 * - Clinical (HIPAA) records and CHD are inventoried separately; a consumer
 *   workflow never deletes or alters the legal clinical record (EX2).
 * - Identity ambiguity narrows a request with a stated reason and an appeal
 *   route; it never silently denies (EX1).
 * - Marketing use of the person's CHD is blocked from the moment a deletion
 *   or consent-withdrawal request arrives and stays blocked (AC2, EX2).
 * - Deletion reaches every eligible processor copy and returns a receipt per
 *   copy, plus an explanation for whatever is retained (AC2).
 */

import { plusDays, ConsumerRightsError, type IdentityVerificationPort } from './contracts.js';

/** Counsel-confirmed ruleset; the version is stamped on every request. */
export interface ChdRuleset {
  readonly version: string;
  readonly responseDays: number;
  readonly extensionDays: number;
  readonly appealResponseDays: number;
}

export const CHD_RULESET_V1: ChdRuleset = {
  version: 'nv-sb370-chd/v1',
  responseDays: 45,
  extensionDays: 45,
  appealResponseDays: 45,
};

export type ChdRequestKind = 'access' | 'deletion' | 'third-party-list' | 'withdraw-consent';

export type ChdRequestState =
  | 'received'
  | 'verified'
  | 'narrowed'
  | 'denied'
  | 'fulfilled'
  | 'partial'
  | 'appealed'
  | 'appeal-upheld'
  | 'appeal-reversed';

export type DataClass = 'hipaa-clinical' | 'chd';
export type RetentionBasis = 'none' | 'legal-hold' | 'required-retention';

export interface DataInventoryItem {
  readonly itemRef: string;
  readonly dataClass: DataClass;
  readonly purpose: string;
  readonly processor: string;
  readonly consentRef: string | null;
  readonly sharedWith: readonly string[];
  readonly sold: boolean;
  readonly retentionBasis: RetentionBasis;
}

/** A processor holding a copy of CHD. Deletion is requested per copy and answered with a receipt. */
export interface ProcessorPort {
  readonly processor: string;
  deleteCopy(
    itemRef: string,
    at: string,
  ): { readonly receiptRef: string; readonly deleted: boolean };
}

export interface ProcessorReceipt {
  readonly itemRef: string;
  readonly processor: string;
  readonly receiptRef: string;
  readonly deleted: boolean;
}

export interface RetainedItem {
  readonly itemRef: string;
  readonly dataClass: DataClass;
  readonly why: string;
}

export interface ChdDecision {
  readonly at: string;
  readonly receipts: readonly ProcessorReceipt[];
  readonly retained: readonly RetainedItem[];
  /** For access and third-party requests: the CHD inventory disclosed. */
  readonly disclosed: readonly DataInventoryItem[];
  readonly thirdParties: readonly string[];
  readonly explanation: string;
}

export interface ChdAppeal {
  readonly filedAt: string;
  readonly grounds: string;
  readonly owner: string;
  readonly dueAt: string;
  readonly decision: {
    readonly outcome: 'upheld' | 'reversed';
    readonly at: string;
    readonly by: string;
  } | null;
}

export interface ChdRequest {
  readonly requestId: string;
  readonly tenantId: string;
  readonly personRef: string;
  readonly kind: ChdRequestKind;
  readonly rulesetVersion: string;
  readonly receivedAt: string;
  readonly dueAt: string;
  readonly extended: boolean;
  readonly state: ChdRequestState;
  readonly narrowedReason: string | null;
  readonly marketingBlocked: boolean;
  readonly decision: ChdDecision | null;
  readonly appealRoute: { readonly owner: string; readonly fileBy: string } | null;
  readonly appeal: ChdAppeal | null;
  readonly history: readonly { readonly at: string; readonly state: ChdRequestState }[];
  /** Owned compliance exceptions: late responses and processor failures. Never silently dropped. */
  readonly exceptions: readonly ChdException[];
}

export interface ChdException {
  readonly kind: 'response-overdue' | 'appeal-overdue' | 'processor-failure';
  readonly at: string;
  readonly owner: string;
  readonly daysLate: number | null;
  readonly detail: string;
}

function move(request: ChdRequest, state: ChdRequestState, at: string): ChdRequest {
  return { ...request, state, history: [...request.history, { at, state }] };
}

function refuse(code: string, message: string): never {
  throw new ConsumerRightsError(code, message);
}

export function submitChdRequest(
  input: {
    readonly requestId: string;
    readonly tenantId: string;
    readonly personRef: string;
    readonly kind: ChdRequestKind;
    readonly at: string;
  },
  ruleset: ChdRuleset = CHD_RULESET_V1,
): ChdRequest {
  return {
    ...input,
    receivedAt: input.at,
    rulesetVersion: ruleset.version,
    dueAt: plusDays(input.at, ruleset.responseDays),
    extended: false,
    state: 'received',
    narrowedReason: null,
    marketingBlocked: input.kind === 'deletion' || input.kind === 'withdraw-consent',
    decision: null,
    appealRoute: null,
    appeal: null,
    history: [{ at: input.at, state: 'received' }],
    exceptions: [],
  };
}

/** One extension, with notice to the person, while the request is still open. */
export function extendChdDeadline(
  request: ChdRequest,
  at: string,
  ruleset: ChdRuleset = CHD_RULESET_V1,
): ChdRequest {
  if (request.extended) refuse('CHD_EXTENSION', 'the one permitted extension was already used');
  if (Date.parse(at) > Date.parse(request.dueAt)) {
    refuse('CHD_OVERDUE', 'an extension must be noticed before the original deadline');
  }
  return { ...request, extended: true, dueAt: plusDays(request.dueAt, ruleset.extensionDays) };
}

export function verifyChdRequester(
  request: ChdRequest,
  identity: IdentityVerificationPort,
  evidenceRef: string,
  at: string,
  appealOwner: string,
  ruleset: ChdRuleset = CHD_RULESET_V1,
): ChdRequest {
  if (request.state !== 'received') refuse('CHD_STATE', `cannot verify from ${request.state}`);
  const outcome = identity.verify(request.tenantId, request.personRef, evidenceRef);
  const appealRoute = { owner: appealOwner, fileBy: plusDays(at, ruleset.appealResponseDays) };
  if (outcome === 'verified') {
    return move(request, 'verified', at);
  }
  if (outcome === 'ambiguous') {
    return {
      ...move(request, 'narrowed', at),
      narrowedReason:
        'identity could not be fully verified: categories and processors are confirmed, specific data is withheld until verification completes',
      appealRoute,
    };
  }
  return {
    ...move(request, 'denied', at),
    narrowedReason: 'identity could not be verified from the evidence supplied',
    appealRoute,
  };
}

function chdOnly(inventory: readonly DataInventoryItem[]): readonly DataInventoryItem[] {
  return inventory.filter((item) => item.dataClass === 'chd');
}

/** Whole days after `dueAt`, or 0 when on time. */
function daysLate(dueAt: string, at: string): number {
  return Math.max(0, Math.ceil((Date.parse(at) - Date.parse(dueAt)) / 86_400_000));
}

/**
 * Record a missed deadline once. A later act against the same deadline (a retry of a
 * partial deletion) keeps the first owned exception and adds no duplicate.
 */
function withOverdue(
  request: ChdRequest,
  kind: 'response-overdue' | 'appeal-overdue',
  dueAt: string,
  at: string,
  owner: string,
): ChdRequest {
  const late = daysLate(dueAt, at);
  if (late === 0) return request;
  const alreadyOwned = request.exceptions.some(
    (exception) => exception.kind === kind && exception.detail.endsWith(`after ${dueAt}`),
  );
  if (alreadyOwned) return request;
  return {
    ...request,
    exceptions: [
      ...request.exceptions,
      { kind, at, owner, daysLate: late, detail: `acted ${String(late)} day(s) after ${dueAt}` },
    ],
  };
}

/**
 * Act on a verified (or narrowed) request. Deletion touches CHD copies with no
 * retention basis only; clinical records and held CHD are retained and explained.
 *
 * - A late act still proceeds; the breach is recorded as an owned
 *   `response-overdue` exception, never used to refuse the consumer.
 * - Every processor needed for deletion must have a port before any copy is
 *   deleted (nothing is deleted when one is missing).
 * - A copy that fails to delete moves the request to `partial` with every
 *   receipt kept and the failure owned; a retry skips copies already deleted.
 */
export function actOnChdRequest(
  request: ChdRequest,
  inventory: readonly DataInventoryItem[],
  processors: readonly ProcessorPort[],
  at: string,
  appealOwner: string,
  ruleset: ChdRuleset = CHD_RULESET_V1,
): ChdRequest {
  if (
    request.state !== 'verified' &&
    request.state !== 'narrowed' &&
    request.state !== 'appeal-reversed' &&
    request.state !== 'partial'
  ) {
    refuse('CHD_STATE', `cannot act from ${request.state}`);
  }
  const retry = request.state === 'partial';
  const narrowed = request.state === 'narrowed';
  const chd = chdOnly(inventory);
  const retained: RetainedItem[] = inventory
    .filter((item) => item.dataClass === 'hipaa-clinical')
    .map((item) => ({
      itemRef: item.itemRef,
      dataClass: item.dataClass,
      why: 'legal clinical record under HIPAA; outside the consumer-health-data workflow',
    }));
  const priorReceipts = retry ? (request.decision?.receipts ?? []) : [];
  const alreadyDeleted = new Set(
    priorReceipts.filter((receipt) => receipt.deleted).map((receipt) => receipt.itemRef),
  );
  const receipts: ProcessorReceipt[] = priorReceipts.filter((receipt) => receipt.deleted);
  const failures: string[] = [];
  let disclosed: readonly DataInventoryItem[] = [];
  let explanation: string;

  switch (request.kind) {
    case 'deletion':
    case 'withdraw-consent': {
      const eligible: DataInventoryItem[] = [];
      for (const item of chd) {
        if (narrowed || item.retentionBasis !== 'none') {
          retained.push({
            itemRef: item.itemRef,
            dataClass: item.dataClass,
            why: narrowed
              ? 'held until identity verification completes; marketing use stays blocked'
              : `retained under ${item.retentionBasis}; marketing use stays blocked`,
          });
        } else if (!alreadyDeleted.has(item.itemRef)) {
          eligible.push(item);
        }
      }
      const missing = [
        ...new Set(
          eligible
            .map((item) => item.processor)
            .filter((processor) => !processors.some((port) => port.processor === processor)),
        ),
      ];
      if (missing.length > 0) {
        refuse('CHD_PROCESSOR', `no processor port for ${missing.join(', ')}; nothing was deleted`);
      }
      for (const item of eligible) {
        const port = processors.find((candidate) => candidate.processor === item.processor);
        if (port === undefined) continue;
        let answer: { readonly receiptRef: string; readonly deleted: boolean };
        try {
          answer = port.deleteCopy(item.itemRef, at);
        } catch (error) {
          answer = { receiptRef: `error:${(error as Error).message}`, deleted: false };
        }
        receipts.push({ itemRef: item.itemRef, processor: item.processor, ...answer });
        if (!answer.deleted) failures.push(`${item.processor}:${item.itemRef}`);
      }
      explanation = narrowed
        ? 'request narrowed pending identity verification'
        : 'eligible consumer-health-data copies deleted; retained items are listed with their basis';
      break;
    }
    case 'access':
      disclosed = narrowed
        ? chd.map((item) => ({ ...item, itemRef: '[withheld pending verification]' }))
        : chd;
      explanation = narrowed
        ? 'categories disclosed; specific items withheld'
        : 'CHD inventory disclosed';
      break;
    case 'third-party-list':
      explanation = 'third parties and processors that received CHD';
      break;
  }
  const thirdParties = [
    ...new Set(chd.flatMap((item) => [item.processor, ...item.sharedWith])),
  ].sort();
  let next = withOverdue(request, 'response-overdue', request.dueAt, at, appealOwner);
  if (failures.length > 0) {
    next = {
      ...move(next, 'partial', at),
      decision: {
        at,
        receipts,
        retained,
        disclosed,
        thirdParties,
        explanation: `partial: ${String(failures.length)} copy(ies) not deleted; retry pending`,
      },
      exceptions: [
        ...next.exceptions,
        {
          kind: 'processor-failure',
          at,
          owner: appealOwner,
          daysLate: null,
          detail: `copies not deleted: ${failures.join(', ')}`,
        },
      ],
    };
    return next;
  }
  return {
    ...move(next, 'fulfilled', at),
    decision: { at, receipts, retained, disclosed, thirdParties, explanation },
    appealRoute: { owner: appealOwner, fileBy: plusDays(at, ruleset.appealResponseDays) },
  };
}

/** Any decision (fulfilled, narrowed or denied) can be appealed once, to a named owner with a deadline. */
export function appealChdDecision(
  request: ChdRequest,
  grounds: string,
  at: string,
  ruleset: ChdRuleset = CHD_RULESET_V1,
): ChdRequest {
  if (request.state !== 'fulfilled' && request.state !== 'narrowed' && request.state !== 'denied') {
    refuse('CHD_STATE', `nothing to appeal from ${request.state}`);
  }
  if (request.appeal !== null) refuse('CHD_APPEAL', 'this request was already appealed');
  if (request.appealRoute === null) refuse('CHD_APPEAL', 'no appeal route was issued');
  if (grounds.trim() === '') refuse('CHD_APPEAL', 'an appeal needs grounds');
  return {
    ...move(request, 'appealed', at),
    appeal: {
      filedAt: at,
      grounds,
      owner: request.appealRoute.owner,
      dueAt: plusDays(at, ruleset.appealResponseDays),
      decision: null,
    },
  };
}

/** A late appeal decision still stands; the breach is an owned `appeal-overdue` exception. */
export function decideChdAppeal(
  request: ChdRequest,
  outcome: 'upheld' | 'reversed',
  by: string,
  at: string,
): ChdRequest {
  if (request.state !== 'appealed' || request.appeal === null) {
    refuse('CHD_STATE', 'no open appeal');
  }
  if (by !== request.appeal.owner) refuse('CHD_APPEAL', `${by} does not own this appeal`);
  const appeal = request.appeal;
  const flagged = withOverdue(request, 'appeal-overdue', appeal.dueAt, at, appeal.owner);
  const decided = { ...appeal, decision: { outcome, at, by } };
  if (outcome === 'upheld') {
    return { ...move(flagged, 'appeal-upheld', at), appeal: decided };
  }
  /** A reversal reopens the request for a fresh decision under the same deadline rules. */
  return {
    ...move(flagged, 'appeal-reversed', at),
    appeal: decided,
    dueAt: appeal.dueAt,
  };
}

/** Marketing may use this person's CHD (in this tenant) only when no rights request blocks it. */
export function chdMarketingAllowed(
  requests: readonly ChdRequest[],
  tenantId: string,
  personRef: string,
): boolean {
  return !requests.some(
    (request) =>
      request.tenantId === tenantId && request.personRef === personRef && request.marketingBlocked,
  );
}

/**
 * R6-SR-021: a sale or share of CHD needs its own written authorization,
 * never inferred from the collection opt-in or bundled with any other consent.
 * By default nothing is sold. An authorization belongs to one tenant.
 */
export interface ChdSaleAuthorization {
  readonly tenantId: string;
  readonly personRef: string;
  readonly purchaser: string;
  readonly written: boolean;
  readonly signedAt: string;
  readonly expiresAt: string;
  readonly bundledWith: readonly string[];
  readonly revokedAt: string | null;
}

export function chdSaleAllowed(
  authorizations: readonly ChdSaleAuthorization[],
  tenantId: string,
  personRef: string,
  purchaser: string,
  at: string,
): boolean {
  return authorizations.some(
    (auth) =>
      auth.tenantId === tenantId &&
      auth.personRef === personRef &&
      auth.purchaser === purchaser &&
      auth.written &&
      auth.bundledWith.length === 0 &&
      auth.revokedAt === null &&
      Date.parse(auth.signedAt) <= Date.parse(at) &&
      Date.parse(at) < Date.parse(auth.expiresAt),
  );
}

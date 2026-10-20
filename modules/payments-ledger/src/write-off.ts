import { createHash } from 'node:crypto';

import {
  LedgerError,
  type BalancedLedger,
  type LedgerPostInput,
  type LedgerRail,
  type LedgerReceipt,
} from './ledger.js';
import { assertSafeInteger } from './money.js';

export const writeOffReasons = [
  'contractual-adjustment',
  'small-balance',
  'uncollectible',
  'charity',
] as const;
export type WriteOffReason = (typeof writeOffReasons)[number];

export const writeOffRoles = ['billing-clerk', 'billing-supervisor', 'rcm-lead'] as const;
export type WriteOffRole = (typeof writeOffRoles)[number];

const roleRank: Readonly<Record<WriteOffRole, number>> = {
  'billing-clerk': 0,
  'billing-supervisor': 1,
  'rcm-lead': 2,
};

/** Amount ceilings are minor units. small-balance cannot be stretched by a higher role. */
const reasonCeiling: Readonly<Record<WriteOffReason, number>> = {
  'small-balance': 1_000,
  'contractual-adjustment': Number.MAX_SAFE_INTEGER,
  uncollectible: Number.MAX_SAFE_INTEGER,
  charity: Number.MAX_SAFE_INTEGER,
};

const minimumRoleFor = (reason: WriteOffReason, amountMinor: number): WriteOffRole => {
  if (reason === 'charity') return 'rcm-lead';
  if (reason === 'uncollectible') return amountMinor <= 10_000 ? 'billing-supervisor' : 'rcm-lead';
  if (amountMinor <= 1_000) return 'billing-clerk';
  if (amountMinor <= 10_000) return 'billing-supervisor';
  return 'rcm-lead';
};

export class WriteOffError extends Error {
  public constructor(
    public readonly code:
      | 'UNDER_AUTHORIZED'
      | 'TIER_EXCEEDED'
      | 'APPROVAL_MISMATCH'
      | 'APPROVAL_CONSUMED'
      | 'SELF_APPROVAL'
      | 'UNKNOWN_APPROVER'
      | 'EXCEEDS_OPEN_RECEIVABLE'
      | 'DEPRECATED_PATH_REFUSED',
  ) {
    super(code);
    this.name = 'WriteOffError';
  }
}

export interface WriteOffApproval {
  readonly tenantId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: WriteOffReason;
  readonly role: WriteOffRole;
  readonly rail: LedgerRail;
  readonly approvalHash: string;
}

export function authorizeWriteOff(input: {
  readonly tenantId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: WriteOffReason;
  readonly role: WriteOffRole;
  readonly rail: LedgerRail;
}): WriteOffApproval {
  if (input.tenantId.trim() === '' || !/^[A-Z]{3}$/.test(input.currency)) {
    throw new LedgerError('INVALID_LINE');
  }
  if (!writeOffReasons.includes(input.reason) || !writeOffRoles.includes(input.role)) {
    throw new LedgerError('INVALID_LINE');
  }
  try {
    assertSafeInteger(input.amountMinor, 'write-off');
  } catch {
    throw new LedgerError('INVALID_LINE');
  }
  if (input.amountMinor > reasonCeiling[input.reason]) throw new WriteOffError('TIER_EXCEEDED');
  if (roleRank[input.role] < roleRank[minimumRoleFor(input.reason, input.amountMinor)]) {
    throw new WriteOffError('UNDER_AUTHORIZED');
  }
  const approvalHash = createHash('sha256')
    .update(
      JSON.stringify([
        input.tenantId,
        input.amountMinor,
        input.currency,
        input.reason,
        input.role,
        input.rail,
      ]),
    )
    .digest('hex');
  return { ...input, approvalHash };
}

interface PostingInput {
  readonly journalId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** The write-off's accounting instant; accounting exports place it by this date. */
  readonly occurredAt?: string;
}

/** One governed write-off as recorded (mirrors the 0021 + 0068 `write_off` row). */
export interface WriteOffRecord {
  readonly tenantId: string;
  readonly writeOffId: string;
  readonly journalId: string;
  readonly targetRef: string;
  readonly reason: WriteOffReason;
  readonly role: WriteOffRole;
  readonly amountMinor: number;
  readonly currency: string;
  readonly approvalHash: string;
  readonly approverActorId: string;
  readonly requesterActorId: string;
}

interface Consumption {
  readonly journalId: string;
  readonly idempotencyKey: string;
}

/**
 * Approvals already used, per ledger. An approval is consumed by exactly one
 * journal; an identical retry of that journal is still idempotent, and any
 * other use is `APPROVAL_CONSUMED`. The 0068 UNIQUE constraints are the
 * database half of the same rule.
 */
const consumed = new WeakMap<BalancedLedger, Map<string, Consumption>>();
const recorded = new WeakMap<BalancedLedger, WriteOffRecord[]>();

function consumptionFor(ledger: BalancedLedger): Map<string, Consumption> {
  let map = consumed.get(ledger);
  if (map === undefined) {
    map = new Map();
    consumed.set(ledger, map);
  }
  return map;
}

/** True when this exact posting already consumed every key; throws when another posting did. */
function claimKeys(
  ledger: BalancedLedger,
  keys: readonly string[],
  posting: PostingInput,
): boolean {
  const map = consumptionFor(ledger);
  let retry = true;
  for (const key of keys) {
    const prior = map.get(key);
    if (prior === undefined) {
      retry = false;
      continue;
    }
    if (prior.journalId !== posting.journalId || prior.idempotencyKey !== posting.idempotencyKey) {
      throw new WriteOffError('APPROVAL_CONSUMED');
    }
  }
  return retry;
}

function markKeys(ledger: BalancedLedger, keys: readonly string[], posting: PostingInput): void {
  const map = consumptionFor(ledger);
  for (const key of keys) {
    map.set(key, { journalId: posting.journalId, idempotencyKey: posting.idempotencyKey });
  }
}

function writeOffLines(
  amountMinor: number,
  currency: string,
  sourceRef: string,
): LedgerPostInput['lines'] {
  return [
    { accountRef: 'write-off-expense', side: 'debit', amountMinor, currency, sourceRef },
    { accountRef: 'accounts-receivable', side: 'credit', amountMinor, currency, sourceRef },
  ];
}

/**
 * The open balance of one receivable: accounts-receivable debits minus
 * credits for (tenant, sourceRef, currency). A write-off may not take it
 * below zero, so two approvals can never write off the same receivable twice.
 */
export function openReceivableMinor(
  ledger: BalancedLedger,
  tenantId: string,
  targetRef: string,
  currency: string,
): number {
  let open = 0;
  for (const journal of ledger.journals()) {
    if (journal.tenantId !== tenantId) continue;
    for (const line of journal.lines) {
      if (
        line.accountRef === 'accounts-receivable' &&
        line.sourceRef === targetRef &&
        line.currency === currency
      ) {
        open += line.side === 'debit' ? line.amountMinor : -line.amountMinor;
      }
    }
  }
  return open;
}

function isBoundApproval(approval: WriteOffApproval): approval is BoundWriteOffApproval {
  const bound = approval as Partial<BoundWriteOffApproval>;
  return (
    typeof bound.writeOffId === 'string' &&
    typeof bound.targetRef === 'string' &&
    typeof bound.requesterActorId === 'string' &&
    typeof bound.approverActorId === 'string'
  );
}

/**
 * The retired tier-only path.
 *
 * @deprecated It used to trust a caller-declared role. It no longer posts on
 * that basis: without an `authority` it is refused (`DEPRECATED_PATH_REFUSED`);
 * with an authority and a bound approval for the same receivable it routes
 * through the governed `postApprovedWriteOff`. Use `approveWriteOff` +
 * `postApprovedWriteOff` directly.
 */
export function postWriteOff(
  ledger: BalancedLedger,
  approval: WriteOffApproval,
  input: PostingInput & { readonly sourceRef: string },
  authority?: WriteOffAuthority,
): LedgerReceipt {
  if (authority === undefined || !isBoundApproval(approval)) {
    throw new WriteOffError('DEPRECATED_PATH_REFUSED');
  }
  if (approval.targetRef !== input.sourceRef) throw new WriteOffError('APPROVAL_MISMATCH');
  return postApprovedWriteOff(ledger, authority, approval, input);
}

/**
 * Where an approver's role comes from: an authenticated actor directory or a
 * PDP decision, never the request. The simulated authority below stands for
 * the identity/PDP port until one is wired.
 */
export interface WriteOffAuthority {
  roleOf(tenantId: string, actorId: string): WriteOffRole | null;
}

export interface WriteOffActor {
  readonly tenantId: string;
  readonly actorId: string;
  readonly role: WriteOffRole;
}

export function simulatedWriteOffAuthority(actors: readonly WriteOffActor[]): WriteOffAuthority {
  const roles = new Map(
    actors.map((actor) => [JSON.stringify([actor.tenantId, actor.actorId]), actor.role]),
  );
  return {
    roleOf(tenantId: string, actorId: string): WriteOffRole | null {
      return roles.get(JSON.stringify([tenantId, actorId])) ?? null;
    },
  };
}

export interface WriteOffRequest {
  readonly tenantId: string;
  readonly writeOffId: string;
  /** The receivable being written off (AR item or its sourceRef). */
  readonly targetRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: WriteOffReason;
  readonly rail: LedgerRail;
  readonly requesterActorId: string;
  readonly approverActorId: string;
}

/** An approval bound to one write-off id, one receivable and one named approver. */
export interface BoundWriteOffApproval extends WriteOffApproval {
  readonly writeOffId: string;
  readonly targetRef: string;
  readonly requesterActorId: string;
  readonly approverActorId: string;
}

/**
 * Approve a write-off. The approver's role is resolved from `authority`,
 * the approver must differ from the requester, and the tier table applies to
 * that resolved role. The hash binds every field, so an approval cannot be
 * moved to another receivable, amount or write-off id.
 */
export function approveWriteOff(
  authority: WriteOffAuthority,
  request: WriteOffRequest,
): BoundWriteOffApproval {
  for (const value of [
    request.writeOffId,
    request.targetRef,
    request.requesterActorId,
    request.approverActorId,
  ]) {
    if (value.trim() === '') throw new LedgerError('INVALID_LINE');
  }
  if (request.approverActorId === request.requesterActorId) {
    throw new WriteOffError('SELF_APPROVAL');
  }
  const role = authority.roleOf(request.tenantId, request.approverActorId);
  if (role === null) throw new WriteOffError('UNKNOWN_APPROVER');
  authorizeWriteOff({
    tenantId: request.tenantId,
    amountMinor: request.amountMinor,
    currency: request.currency,
    reason: request.reason,
    role,
    rail: request.rail,
  });
  const approvalHash = createHash('sha256')
    .update(
      JSON.stringify([
        'write-off-approval/v2',
        request.tenantId,
        request.writeOffId,
        request.targetRef,
        request.amountMinor,
        request.currency,
        request.reason,
        role,
        request.rail,
        request.requesterActorId,
        request.approverActorId,
      ]),
    )
    .digest('hex');
  return {
    tenantId: request.tenantId,
    writeOffId: request.writeOffId,
    targetRef: request.targetRef,
    amountMinor: request.amountMinor,
    currency: request.currency,
    reason: request.reason,
    role,
    rail: request.rail,
    requesterActorId: request.requesterActorId,
    approverActorId: request.approverActorId,
    approvalHash,
  };
}

/**
 * Post a governed write-off. The approval is re-derived from `authority`
 * (a forged role or edited field is `APPROVAL_MISMATCH`), is consumed by this
 * one journal (a second use or a reused write-off id is `APPROVAL_CONSUMED`),
 * and the journal carries the reason, approval hash and approver.
 */
export function postApprovedWriteOff(
  ledger: BalancedLedger,
  authority: WriteOffAuthority,
  approval: BoundWriteOffApproval,
  input: PostingInput,
): LedgerReceipt {
  const expected = approveWriteOff(authority, approval);
  if (expected.approvalHash !== approval.approvalHash || expected.role !== approval.role) {
    throw new WriteOffError('APPROVAL_MISMATCH');
  }
  const keys = [
    JSON.stringify(['approval', approval.tenantId, approval.approvalHash]),
    JSON.stringify(['write-off', approval.tenantId, approval.writeOffId]),
  ];
  const retry = claimKeys(ledger, keys, input);
  if (!retry && ledger.journal(approval.tenantId, input.journalId) === undefined) {
    // Cap at the open receivable: cumulative write-offs never exceed what is owed.
    const open = openReceivableMinor(
      ledger,
      approval.tenantId,
      approval.targetRef,
      approval.currency,
    );
    if (approval.amountMinor > open) throw new WriteOffError('EXCEEDS_OPEN_RECEIVABLE');
  }
  const receipt = ledger.postBalancedSet({
    tenantId: approval.tenantId,
    journalId: input.journalId,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    rail: approval.rail,
    writeOff: {
      writeOffId: approval.writeOffId,
      reason: approval.reason,
      approvalHash: approval.approvalHash,
      approverActorId: approval.approverActorId,
    },
    lines: writeOffLines(approval.amountMinor, approval.currency, approval.targetRef),
  });
  if (!retry) {
    markKeys(ledger, keys, input);
    const records = recorded.get(ledger) ?? [];
    records.push({
      tenantId: approval.tenantId,
      writeOffId: approval.writeOffId,
      journalId: input.journalId,
      targetRef: approval.targetRef,
      reason: approval.reason,
      role: approval.role,
      amountMinor: approval.amountMinor,
      currency: approval.currency,
      approvalHash: approval.approvalHash,
      approverActorId: approval.approverActorId,
      requesterActorId: approval.requesterActorId,
    });
    recorded.set(ledger, records);
  }
  return receipt;
}

/** The governed write-offs posted to this ledger for one tenant. */
export function writeOffRecords(
  ledger: BalancedLedger,
  tenantId: string,
): readonly WriteOffRecord[] {
  return (recorded.get(ledger) ?? []).filter((record) => record.tenantId === tenantId);
}

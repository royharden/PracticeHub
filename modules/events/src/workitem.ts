/**
 * WorkItem domain (WP-022, M05). Contract: docs/contracts/workitem-sla-api.md
 * (FROZEN). Canonical data model: WorkItem = the universal worklist entry
 * (denial, PA, referral-aging, consent-renewal, merge-queue, sign-off, an owned
 * message thread…) — one accountable owner at a time, event-sourced so every SLA
 * breach and ownership change is reconstructable (R8 §5.7: this append-only log
 * is one of the module's two immutable spines).
 *
 * Pure model + projection fold. Ownership is single-owner by construction; the
 * acceptance rule (REQ-TASK-002 E1) is encoded here — opening, queuing, tagging,
 * an inbound, a holding reply, or an auto-ack NEVER count as ownership
 * acceptance; only an explicit claim / assignment / reassignment moves owner_ref.
 */

import {
  SlaError,
  slaTimerStates,
  slaTimerTypes,
  type SlaTimer,
  type SlaTimerType,
} from './sla.js';

/**
 * WorkItem origin taxonomy — the sources that route into the engine. The
 * upstream domains (merge, PDP, obligation-clocks, identity crosswalk) declare
 * their WorkItem class here so their forward obligations (FWD-MERGE-022-TASKS,
 * FWD-PDP-022-WORKITEMS, FWD-CLOCK-022-WORKITEMS, FWD-ID-004-RECON) have a
 * representable target. Extending the taxonomy is a data/contract change here,
 * never a schema change (origin is a text column with a CHECK vocabulary).
 */
export const workItemOrigins = [
  'thread',
  'merge-review',
  'authority-review',
  'obligation-clock',
  'identity-recon',
  'fulfillment',
  'complaint',
  'admin',
] as const;
export type WorkItemOrigin = (typeof workItemOrigins)[number];

export const workItemRisks = ['routine', 'elevated', 'urgent', 'critical'] as const;
export type WorkItemRisk = (typeof workItemRisks)[number];

export const workItemStatuses = [
  'unmatched',
  'open',
  'pending',
  'snoozed',
  'resolved',
  'reopened',
] as const;
export type WorkItemStatus = (typeof workItemStatuses)[number];

export const workItemPriorities = ['normal', 'high', 'urgent'] as const;
export type WorkItemPriority = (typeof workItemPriorities)[number];

export const ownershipReasons = [
  'claim',
  'assignment',
  'escalation',
  'pto',
  'coverage',
  'manual',
] as const;
export type OwnershipReason = (typeof ownershipReasons)[number];

export const workItemEventTypes = [
  'opened',
  'queued',
  'assigned',
  'claimed',
  'reassigned',
  'inbound_received',
  'holding_reply',
  'reply_sent',
  'timer_started',
  'timer_paused',
  'timer_resumed',
  'timer_breached',
  'timer_met',
  'escalated',
  'watcher_added',
  'watcher_removed',
  'resolved',
  'reopened',
] as const;
export type WorkItemEventType = (typeof workItemEventTypes)[number];

/**
 * The ONLY event types that transfer accountability (REQ-TASK-002 E1 /
 * REQ-TASK-029 E2). An inbound, a queued item, a tag, an auto-ack, or a holding
 * reply is deliberately excluded — it can never become ownership by accident.
 */
export const acceptanceEventTypes: readonly WorkItemEventType[] = [
  'assigned',
  'claimed',
  'reassigned',
];

/** The reassignment/claim context handoff (R8 §5.1 Context Package). */
export interface ContextPackage {
  readonly transcriptRef?: string;
  readonly patientSummaryRef?: string;
  readonly openOrders?: readonly string[];
  readonly priorOwnerNotesRef?: string;
  /** Current SLA timer state at handoff — the new owner inherits live clocks. */
  readonly timerState: readonly SlaTimer[];
  readonly consentFlags?: readonly string[];
}

export interface WorkItemEvent {
  readonly workItemId: string;
  readonly eventSeq: number;
  readonly eventType: WorkItemEventType;
  readonly occurredAt: string;
  readonly actorRef?: string;
  readonly fromOwnerRef?: string;
  readonly toOwnerRef?: string;
  readonly reason?: OwnershipReason;
  readonly timerType?: SlaTimerType;
  readonly dueAt?: string;
  readonly escalationStep?: number;
  readonly escalationAction?: string;
  readonly escalationTarget?: string;
  readonly contextPackage?: ContextPackage;
  readonly watcherRef?: string;
}

/**
 * Immutable descriptor set at open — folded onto the projection but never
 * changed by later events (the queue-entry facts of REQ-TASK-002 A1).
 */
export interface WorkItemOpen {
  readonly workItemId: string;
  readonly origin: WorkItemOrigin;
  readonly subjectRef?: string;
  readonly purpose: string;
  readonly risk: WorkItemRisk;
  readonly serviceTier: string;
  readonly slaPolicyId: string | null;
  readonly policyVersion: number | null;
  readonly responseDueAt: string | null;
  readonly poolId: string | null;
  readonly openedAt: string;
}

export interface WorkItem {
  readonly workItemId: string;
  readonly origin: WorkItemOrigin;
  readonly subjectRef: string | null;
  readonly purpose: string;
  readonly risk: WorkItemRisk;
  readonly serviceTier: string;
  readonly slaPolicyId: string | null;
  readonly policyVersion: number | null;
  /** An SLA policy is attached — a no-SLA item sorts below all SLA items (E1). */
  readonly hasSla: boolean;
  readonly status: WorkItemStatus;
  readonly priority: WorkItemPriority;
  readonly ownerRef: string | null;
  readonly poolId: string | null;
  readonly watchers: readonly string[];
  readonly escalated: boolean;
  readonly openedAt: string;
  readonly responseDueAt: string | null;
  readonly firstOwnedAt: string | null;
  readonly lastEventSeq: number;
}

/** The projection at open, before any lifecycle event. Owner is null (unmatched). */
export function initialWorkItem(open: WorkItemOpen): WorkItem {
  const hasSla = open.slaPolicyId !== null && open.policyVersion !== null;
  return {
    workItemId: open.workItemId,
    origin: open.origin,
    subjectRef: open.subjectRef ?? null,
    purpose: open.purpose,
    risk: open.risk,
    serviceTier: open.serviceTier,
    slaPolicyId: open.slaPolicyId,
    policyVersion: open.policyVersion,
    hasSla,
    status: 'unmatched',
    priority: 'normal',
    ownerRef: null,
    poolId: open.poolId,
    watchers: [],
    escalated: false,
    openedAt: open.openedAt,
    responseDueAt: open.responseDueAt,
    firstOwnedAt: null,
    lastEventSeq: 0,
  };
}

function transferOwnership(item: WorkItem, event: WorkItemEvent): WorkItem {
  if (event.toOwnerRef === undefined) {
    throw new SlaError(`${event.eventType} event must name toOwnerRef`);
  }
  // Single-owner invariant (REQ-TASK-002 A2 / REQ-TASK-029 A4): the prior owner
  // is demoted to a watcher (retains visibility, loses accountability) and never
  // duplicated in the watcher set.
  const priorOwner = item.ownerRef;
  const watchers =
    priorOwner !== null && priorOwner !== event.toOwnerRef && !item.watchers.includes(priorOwner)
      ? [...item.watchers, priorOwner]
      : item.watchers;
  return {
    ...item,
    ownerRef: event.toOwnerRef,
    poolId: null,
    watchers: watchers.filter((watcher) => watcher !== event.toOwnerRef),
    status: item.status === 'unmatched' || item.status === 'resolved' ? 'open' : item.status,
    firstOwnedAt: item.firstOwnedAt ?? event.occurredAt,
  };
}

/** Apply one event to the projection (the fold step). Pure. */
export function applyWorkItemEvent(item: WorkItem, event: WorkItemEvent): WorkItem {
  if (event.eventSeq !== item.lastEventSeq + 1) {
    throw new SlaError(
      `work item ${item.workItemId} event out of order: expected seq ${item.lastEventSeq + 1}, ` +
        `got ${event.eventSeq}`,
    );
  }
  const advanced = { ...item, lastEventSeq: event.eventSeq };
  switch (event.eventType) {
    case 'assigned':
    case 'claimed':
    case 'reassigned':
      if (event.eventType !== 'assigned' && event.contextPackage === undefined) {
        // A claim or reassignment hands off context (REQ-TASK-029 A3). An initial
        // assignment of a fresh item has no prior context to carry.
        throw new SlaError(`${event.eventType} of ${item.workItemId} must carry a context package`);
      }
      return { ...transferOwnership(advanced, event), lastEventSeq: event.eventSeq };
    case 'queued':
      return {
        ...advanced,
        status: advanced.status === 'unmatched' ? 'unmatched' : advanced.status,
      };
    case 'escalated':
      return {
        ...advanced,
        escalated: true,
        priority: advanced.priority === 'urgent' ? 'urgent' : 'high',
      };
    case 'watcher_added':
      if (event.watcherRef === undefined) {
        throw new SlaError('watcher_added must name watcherRef');
      }
      return advanced.watchers.includes(event.watcherRef) || advanced.ownerRef === event.watcherRef
        ? advanced
        : { ...advanced, watchers: [...advanced.watchers, event.watcherRef] };
    case 'watcher_removed':
      return { ...advanced, watchers: advanced.watchers.filter((w) => w !== event.watcherRef) };
    case 'resolved':
      return { ...advanced, status: 'resolved' };
    case 'reopened':
      return { ...advanced, status: 'reopened' };
    case 'holding_reply':
    case 'inbound_received':
    case 'reply_sent':
    case 'opened':
    case 'timer_started':
    case 'timer_paused':
    case 'timer_resumed':
    case 'timer_breached':
    case 'timer_met':
      // Non-acceptance / timer events never touch ownership (E1/E2).
      return advanced;
  }
}

/** Fold an ordered event log (seq 1..n) onto the open descriptor. */
export function foldWorkItem(open: WorkItemOpen, events: readonly WorkItemEvent[]): WorkItem {
  return events.reduce(applyWorkItemEvent, initialWorkItem(open));
}

/**
 * Fold the SLA timers from the same log (timer_started/paused/resumed/breached/
 * met events). A pause accrues wall time into pausedTotalSeconds; a resume
 * closes the interval; met/breached set terminal-ish state. One row per timer
 * type — the newest event governs.
 */
export function foldTimers(events: readonly WorkItemEvent[]): readonly SlaTimer[] {
  const timers = new Map<SlaTimerType, { timer: SlaTimer; pausedSince: string | null }>();
  for (const event of events) {
    if (event.timerType === undefined) {
      continue;
    }
    const type = event.timerType;
    const current = timers.get(type);
    switch (event.eventType) {
      case 'timer_started': {
        if (event.dueAt === undefined) {
          throw new SlaError(`timer_started for ${type} must carry dueAt`);
        }
        timers.set(type, {
          timer: {
            timerType: type,
            startedAt: event.occurredAt,
            dueAt: event.dueAt,
            pausedTotalSeconds: 0,
            state: 'running',
          },
          pausedSince: null,
        });
        break;
      }
      case 'timer_paused': {
        if (current === undefined) {
          throw new SlaError(`timer_paused for ${type} before it started`);
        }
        timers.set(type, {
          timer: { ...current.timer, state: 'paused' },
          pausedSince: event.occurredAt,
        });
        break;
      }
      case 'timer_resumed': {
        if (current === undefined || current.pausedSince === null) {
          throw new SlaError(`timer_resumed for ${type} while not paused`);
        }
        const pausedMs = Date.parse(event.occurredAt) - Date.parse(current.pausedSince);
        timers.set(type, {
          timer: {
            ...current.timer,
            state: 'running',
            pausedTotalSeconds: current.timer.pausedTotalSeconds + Math.max(0, pausedMs) / 1000,
          },
          pausedSince: null,
        });
        break;
      }
      case 'timer_breached': {
        if (current === undefined) {
          throw new SlaError(`timer_breached for ${type} before it started`);
        }
        timers.set(type, { timer: { ...current.timer, state: 'breached' }, pausedSince: null });
        break;
      }
      case 'timer_met': {
        if (current === undefined) {
          throw new SlaError(`timer_met for ${type} before it started`);
        }
        timers.set(type, {
          timer: { ...current.timer, state: 'met' },
          pausedSince: current.pausedSince,
        });
        break;
      }
      default:
        break;
    }
  }
  return [...timers.values()]
    .map((entry) => entry.timer)
    .sort(
      (left, right) =>
        slaTimerTypes.indexOf(left.timerType) - slaTimerTypes.indexOf(right.timerType),
    );
}

/**
 * The holding-reply rule (REQ-TASK-029 A1 / R8 §5.5): a teammate's substantive
 * holding reply PAUSES the next_response timer (it does not satisfy it) and a
 * resolution/follow-up timer with its own escalation begins. Returns the two
 * events to append (in order). It does NOT change owner_ref (E2 — an explicit
 * claim/reassignment is required for that).
 */
export function holdingReplyEvents(input: {
  readonly workItemId: string;
  readonly baseSeq: number;
  readonly occurredAt: string;
  readonly actorRef: string;
  readonly resolutionDueAt: string;
}): readonly WorkItemEvent[] {
  return [
    {
      workItemId: input.workItemId,
      eventSeq: input.baseSeq + 1,
      eventType: 'holding_reply',
      occurredAt: input.occurredAt,
      actorRef: input.actorRef,
    },
    {
      workItemId: input.workItemId,
      eventSeq: input.baseSeq + 2,
      eventType: 'timer_paused',
      occurredAt: input.occurredAt,
      timerType: 'next_response',
    },
    {
      workItemId: input.workItemId,
      eventSeq: input.baseSeq + 3,
      eventType: 'timer_started',
      occurredAt: input.occurredAt,
      timerType: 'resolution',
      dueAt: input.resolutionDueAt,
    },
  ];
}

/**
 * Whether a work item may be claimed now (REQ-TASK-029 E1): only an unowned item
 * (pooled or unmatched) is claimable — the first claim wins; a second claim on an
 * already-owned item is refused ("already claimed"). The store enforces the race
 * with a row lock; this is the pure precondition.
 */
export function isClaimable(item: WorkItem): boolean {
  return item.ownerRef === null && item.status !== 'resolved';
}

export const workItemEventTypeSet: ReadonlySet<string> = new Set(workItemEventTypes);
export const slaTimerStateSet: ReadonlySet<string> = new Set(slaTimerStates);

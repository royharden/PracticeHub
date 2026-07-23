/**
 * WorkItem domain unit tests (WP-022): the projection fold, single-owner
 * accountability with the acceptance rule (REQ-TASK-002 E1), holding-reply timer
 * behavior (REQ-TASK-029 A1), timer folding, and the William Given/When/Then
 * scenario driven end-to-end through the pure engine (R8 §5.5 — the gate).
 */
import { describe, expect, it } from 'vitest';

import {
  acceptanceEventTypes,
  applyWorkItemEvent,
  foldTimers,
  foldWorkItem,
  holdingReplyEvents,
  initialWorkItem,
  isClaimable,
  type ContextPackage,
  type WorkItemEvent,
  type WorkItemOpen,
} from './workitem.js';
import { SlaError } from './sla.js';

const open: WorkItemOpen = {
  workItemId: 'wi-thread-william-0001',
  origin: 'thread',
  subjectRef: 'thread:th-william-0001',
  purpose: 'member-message',
  risk: 'routine',
  serviceTier: 'concierge',
  slaPolicyId: 'sla-concierge',
  policyVersion: 1,
  responseDueAt: '2026-03-02T09:00:00Z',
  poolId: null,
  openedAt: '2026-03-02T08:00:00Z',
};

const context: ContextPackage = {
  transcriptRef: 'synthetic-transcript:th-william-0001',
  patientSummaryRef: 'synthetic-summary:np-parker-vale',
  openOrders: ['synthetic-order:vo2-panel'],
  priorOwnerNotesRef: 'synthetic-note:william-handoff-0001',
  timerState: [],
  consentFlags: ['sms/treatment:opted_in'],
};

describe('projection fold + open', () => {
  it('opens unmatched with no owner and hasSla derived from the attached policy', () => {
    const item = initialWorkItem(open);
    expect(item.status).toBe('unmatched');
    expect(item.ownerRef).toBeNull();
    expect(item.hasSla).toBe(true);
    expect(isClaimable(item)).toBe(true);
  });

  it('a no-policy item has hasSla=false', () => {
    const admin = initialWorkItem({ ...open, slaPolicyId: null, policyVersion: null });
    expect(admin.hasSla).toBe(false);
  });

  it('rejects an out-of-order event', () => {
    const item = initialWorkItem(open);
    expect(() =>
      applyWorkItemEvent(item, {
        workItemId: open.workItemId,
        eventSeq: 5,
        eventType: 'queued',
        occurredAt: open.openedAt,
      }),
    ).toThrow(SlaError);
  });
});

describe('single-owner accountability (REQ-TASK-002)', () => {
  it('only assigned/claimed/reassigned are acceptance events — opening/tagging/holding-reply are not (E1)', () => {
    expect(acceptanceEventTypes).toEqual(['assigned', 'claimed', 'reassigned']);
    expect(acceptanceEventTypes).not.toContain('holding_reply');
    expect(acceptanceEventTypes).not.toContain('opened');
    expect(acceptanceEventTypes).not.toContain('queued');
    expect(acceptanceEventTypes).not.toContain('inbound_received');
  });

  it('a non-acceptance event never sets an owner (opening/queuing/inbound/holding-reply)', () => {
    let item = initialWorkItem(open);
    const noise: WorkItemEvent[] = [
      { workItemId: open.workItemId, eventSeq: 1, eventType: 'opened', occurredAt: open.openedAt },
      { workItemId: open.workItemId, eventSeq: 2, eventType: 'queued', occurredAt: open.openedAt },
      {
        workItemId: open.workItemId,
        eventSeq: 3,
        eventType: 'inbound_received',
        occurredAt: open.openedAt,
      },
      {
        workItemId: open.workItemId,
        eventSeq: 4,
        eventType: 'holding_reply',
        occurredAt: open.openedAt,
        actorRef: 'synthetic-guide:maya',
      },
    ];
    for (const event of noise) {
      item = applyWorkItemEvent(item, event);
    }
    expect(item.ownerRef).toBeNull();
    expect(item.firstOwnedAt).toBeNull();
  });

  it('a claim/reassignment must carry a context package', () => {
    const item = applyWorkItemEvent(initialWorkItem(open), {
      workItemId: open.workItemId,
      eventSeq: 1,
      eventType: 'assigned',
      occurredAt: open.openedAt,
      toOwnerRef: 'synthetic-guide:william',
      reason: 'assignment',
    });
    expect(() =>
      applyWorkItemEvent(item, {
        workItemId: open.workItemId,
        eventSeq: 2,
        eventType: 'reassigned',
        occurredAt: '2026-03-02T13:15:00Z',
        toOwnerRef: 'synthetic-guide:maya',
        reason: 'escalation',
      }),
    ).toThrow(/context package/);
  });
});

describe('holding reply (REQ-TASK-029 A1)', () => {
  it('pauses next_response and starts a resolution timer, without changing owner', () => {
    const events = holdingReplyEvents({
      workItemId: open.workItemId,
      baseSeq: 5,
      occurredAt: '2026-03-02T13:10:00Z',
      actorRef: 'synthetic-guide:maya',
      resolutionDueAt: '2026-03-02T17:10:00Z',
    });
    expect(events.map((event) => event.eventType)).toEqual([
      'holding_reply',
      'timer_paused',
      'timer_started',
    ]);
    expect(events[1]?.timerType).toBe('next_response');
    expect(events[2]?.timerType).toBe('resolution');
  });
});

// The William scenario (R8 §5.5) as an ordered log — the engine e2e / the gate.
const williamLog: readonly WorkItemEvent[] = [
  {
    workItemId: open.workItemId,
    eventSeq: 1,
    eventType: 'opened',
    occurredAt: '2026-03-02T08:00:00Z',
    actorRef: 'synthetic-system:router',
  },
  {
    workItemId: open.workItemId,
    eventSeq: 2,
    eventType: 'queued',
    occurredAt: '2026-03-02T08:00:00Z',
  },
  {
    workItemId: open.workItemId,
    eventSeq: 3,
    eventType: 'inbound_received',
    occurredAt: '2026-03-02T08:00:00Z',
  },
  {
    workItemId: open.workItemId,
    eventSeq: 4,
    eventType: 'timer_started',
    occurredAt: '2026-03-02T08:00:00Z',
    timerType: 'next_response',
    dueAt: '2026-03-02T09:00:00Z',
  },
  {
    workItemId: open.workItemId,
    eventSeq: 5,
    eventType: 'assigned',
    occurredAt: '2026-03-02T08:02:00Z',
    toOwnerRef: 'synthetic-guide:william',
    reason: 'assignment',
  },
  {
    workItemId: open.workItemId,
    eventSeq: 6,
    eventType: 'timer_breached',
    occurredAt: '2026-03-02T09:00:00Z',
    timerType: 'next_response',
  },
  {
    workItemId: open.workItemId,
    eventSeq: 7,
    eventType: 'escalated',
    occurredAt: '2026-03-02T09:00:00Z',
    escalationStep: 0,
    escalationAction: 'notify_owner',
    escalationTarget: 'synthetic-guide:william',
  },
  {
    workItemId: open.workItemId,
    eventSeq: 8,
    eventType: 'watcher_added',
    occurredAt: '2026-03-02T09:00:00Z',
    watcherRef: 'synthetic-supervisor:pod-a',
  },
  {
    workItemId: open.workItemId,
    eventSeq: 9,
    eventType: 'escalated',
    occurredAt: '2026-03-02T13:00:00Z',
    escalationStep: 2,
    escalationAction: 'notify_supervisor',
    escalationTarget: 'synthetic-supervisor:pod-a',
  },
  {
    workItemId: open.workItemId,
    eventSeq: 10,
    eventType: 'escalated',
    occurredAt: '2026-03-02T13:00:00Z',
    escalationStep: 3,
    escalationAction: 'mark_priority_high',
    escalationTarget: 'synthetic-escalation-queue:pod-a',
  },
  {
    workItemId: open.workItemId,
    eventSeq: 11,
    eventType: 'holding_reply',
    occurredAt: '2026-03-02T13:10:00Z',
    actorRef: 'synthetic-guide:maya',
  },
  {
    workItemId: open.workItemId,
    eventSeq: 12,
    eventType: 'timer_paused',
    occurredAt: '2026-03-02T13:10:00Z',
    timerType: 'next_response',
  },
  {
    workItemId: open.workItemId,
    eventSeq: 13,
    eventType: 'timer_started',
    occurredAt: '2026-03-02T13:10:00Z',
    timerType: 'resolution',
    dueAt: '2026-03-02T17:10:00Z',
  },
  {
    workItemId: open.workItemId,
    eventSeq: 14,
    eventType: 'reassigned',
    occurredAt: '2026-03-02T13:15:00Z',
    actorRef: 'synthetic-supervisor:pod-a',
    fromOwnerRef: 'synthetic-guide:william',
    toOwnerRef: 'synthetic-guide:maya',
    reason: 'escalation',
    contextPackage: context,
  },
];

describe('William Given/When/Then (R8 §5.5 — engine e2e)', () => {
  const item = foldWorkItem(open, williamLog);
  const timers = foldTimers(williamLog);

  it('THEN the next_response timer breached and the escalation chain fired in order', () => {
    const escalations = williamLog.filter((event) => event.eventType === 'escalated');
    expect(escalations.map((event) => event.escalationAction)).toEqual([
      'notify_owner',
      'notify_supervisor',
      'mark_priority_high',
    ]);
    expect(item.escalated).toBe(true);
    expect(item.priority).toBe('high');
  });

  it('THEN the holding reply paused the next_response timer and started a resolution timer', () => {
    const next = timers.find((timer) => timer.timerType === 'next_response');
    const resolution = timers.find((timer) => timer.timerType === 'resolution');
    expect(next?.state).toBe('paused');
    expect(resolution?.state).toBe('running');
  });

  it('THEN ownership is exactly Maya (single owner) and William is demoted to a watcher', () => {
    expect(item.ownerRef).toBe('synthetic-guide:maya');
    expect(item.watchers).toContain('synthetic-guide:william');
    expect(item.watchers).not.toContain('synthetic-guide:maya');
    // Supervisor added as a watcher at escalation, still present.
    expect(item.watchers).toContain('synthetic-supervisor:pod-a');
  });

  it('THEN the full ownership history is reconstructable from the append-only log', () => {
    const owners = williamLog
      .filter((event) => event.eventType === 'reassigned' || event.eventType === 'assigned')
      .map((event) => event.toOwnerRef);
    expect(owners).toEqual(['synthetic-guide:william', 'synthetic-guide:maya']);
    // The reassignment carried a context package (transcript, notes, timer state).
    const handoff = williamLog.find((event) => event.eventType === 'reassigned');
    expect(handoff?.contextPackage?.transcriptRef).toBeDefined();
    expect(handoff?.contextPackage?.priorOwnerNotesRef).toBeDefined();
  });
});

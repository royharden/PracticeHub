/**
 * Executable 4-class fixture packs for the WP-022 requirement slice:
 *   REQ-TASK-002 — claim each patient thread to one accountable owner;
 *   REQ-TASK-019 — Guide worklist prioritized by SLA state;
 *   REQ-TASK-029 — holding-reply pauses the timer; claim/reassignment preserves
 *                  full context.
 * Every case runs against the REAL domain functions — a fixture that merely
 * "exists" without encoding its acceptance criterion cannot pass here.
 *
 * Review-009 discipline: the accepted-op list is validated at LOAD (an unknown
 * op fails the pack's structural test, not silently), and the dispatcher ends in
 * a throwing default.
 */
import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import {
  acceptanceEventTypes,
  applyWorkItemEvent,
  foldWorkItem,
  holdingReplyEvents,
  isClaimable,
  type ContextPackage,
  type WorkItem,
  type WorkItemEvent,
  type WorkItemOpen,
} from './workitem.js';
import { computeTimerState, planEscalation, type SlaPolicy, type SlaTimer } from './sla.js';
import { prioritizeWorklist, toWorklistEntry } from './worklist.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));

const acceptedOps = [
  'ownership',
  'acceptance',
  'worklist',
  'holding-reply',
  'reassign',
  'claimable',
  'escalation',
  'timer-state',
] as const;
type FixtureOp = (typeof acceptedOps)[number];

const context: ContextPackage = {
  timerState: [],
  transcriptRef: 'synthetic-transcript:fx',
  priorOwnerNotesRef: 'synthetic-note:fx',
};

const conciergeChain: SlaPolicy['escalationChain'] = [
  { afterMinutes: 60, action: 'notify_owner', target: 'synthetic-role:owner' },
  { afterMinutes: 60, action: 'notify_supervisor', target: 'synthetic-supervisor:pod-a' },
  { afterMinutes: 300, action: 'notify_supervisor', target: 'synthetic-supervisor:pod-a' },
  { afterMinutes: 300, action: 'mark_priority_high', target: 'synthetic-escalation-queue:pod-a' },
];

interface WorklistItemSpec {
  readonly id: string;
  readonly hasSla: boolean;
  readonly openedAt: string;
  readonly timerDueAt?: string;
  readonly timerState?: SlaTimer['state'];
  readonly escalated?: boolean;
}

interface FixtureCase {
  readonly name: string;
  readonly op: FixtureOp;
  readonly open?: WorkItemOpen;
  readonly log?: readonly WorkItemEvent[];
  readonly expectOwner?: string | null;
  readonly expectStatus?: WorkItem['status'];
  readonly expectFirstOwned?: boolean;
  readonly expectWatchers?: readonly string[];
  readonly eventType?: WorkItemEvent['eventType'];
  readonly expectAcceptance?: boolean;
  readonly now?: string;
  readonly items?: readonly WorklistItemSpec[];
  readonly expectOrder?: readonly string[];
  readonly baseSeq?: number;
  readonly expectSequence?: readonly string[];
  readonly toOwner?: string;
  readonly withContext?: boolean;
  readonly expectThrow?: boolean;
  readonly ownerRef?: string | null;
  readonly status?: WorkItem['status'];
  readonly expectClaimable?: boolean;
  readonly startedAt?: string;
  readonly dueAt?: string;
  readonly pausedSeconds?: number;
  readonly timerStateIn?: SlaTimer['state'];
  readonly expectActions?: readonly string[];
  readonly expectState?: SlaTimer['state'];
}

function buildWorklistItem(spec: WorklistItemSpec): WorkItem {
  const open: WorkItemOpen = {
    workItemId: spec.id,
    origin: spec.hasSla ? 'thread' : 'admin',
    purpose: spec.hasSla ? 'member-message' : 'inventory-count',
    risk: 'routine',
    serviceTier: spec.hasSla ? 'concierge' : 'internal',
    slaPolicyId: spec.hasSla ? 'sla-concierge' : null,
    policyVersion: spec.hasSla ? 1 : null,
    responseDueAt: spec.hasSla ? spec.openedAt : null,
    poolId: null,
    openedAt: spec.openedAt,
  };
  const base = foldWorkItem(open, []);
  return spec.escalated === true ? { ...base, escalated: true, priority: 'high' } : base;
}

function runCase(fixtureCase: FixtureCase): void {
  switch (fixtureCase.op) {
    case 'ownership': {
      const item = foldWorkItem(fixtureCase.open as WorkItemOpen, fixtureCase.log ?? []);
      if (fixtureCase.expectOwner !== undefined) {
        expect(item.ownerRef).toBe(fixtureCase.expectOwner);
      }
      if (fixtureCase.expectStatus !== undefined) {
        expect(item.status).toBe(fixtureCase.expectStatus);
      }
      if (fixtureCase.expectFirstOwned !== undefined) {
        expect(item.firstOwnedAt !== null).toBe(fixtureCase.expectFirstOwned);
      }
      if (fixtureCase.expectWatchers !== undefined) {
        expect([...item.watchers].sort()).toEqual([...fixtureCase.expectWatchers].sort());
      }
      break;
    }
    case 'acceptance': {
      expect(
        acceptanceEventTypes.includes(fixtureCase.eventType as WorkItemEvent['eventType']),
      ).toBe(fixtureCase.expectAcceptance);
      break;
    }
    case 'worklist': {
      const entries = (fixtureCase.items ?? []).map((spec) => {
        const item = buildWorklistItem(spec);
        const timers: SlaTimer[] =
          spec.timerDueAt === undefined
            ? []
            : [
                {
                  timerType: 'next_response',
                  startedAt: spec.openedAt,
                  dueAt: spec.timerDueAt,
                  pausedTotalSeconds: 0,
                  state: spec.timerState ?? 'running',
                },
              ];
        return toWorklistEntry(item, timers, fixtureCase.now as string);
      });
      const sorted = prioritizeWorklist(entries);
      expect(sorted.map((entry) => entry.item.workItemId)).toEqual(fixtureCase.expectOrder);
      break;
    }
    case 'holding-reply': {
      const events = holdingReplyEvents({
        workItemId: 'wi-fx',
        baseSeq: fixtureCase.baseSeq ?? 5,
        occurredAt: '2026-03-02T13:10:00Z',
        actorRef: 'synthetic-guide:maya',
        resolutionDueAt: '2026-03-02T17:10:00Z',
      });
      expect(events.map((event) => event.eventType)).toEqual(fixtureCase.expectSequence);
      // A holding reply is not an acceptance event — it never changes owner.
      expect(events.some((event) => acceptanceEventTypes.includes(event.eventType))).toBe(false);
      break;
    }
    case 'reassign': {
      const current = foldWorkItem(fixtureCase.open as WorkItemOpen, fixtureCase.log ?? []);
      const reassign: WorkItemEvent = {
        workItemId: current.workItemId,
        eventSeq: current.lastEventSeq + 1,
        eventType: 'reassigned',
        occurredAt: '2026-03-02T13:15:00Z',
        actorRef: 'synthetic-supervisor:pod-a',
        toOwnerRef: fixtureCase.toOwner as string,
        reason: 'escalation',
        ...(fixtureCase.withContext === false ? {} : { contextPackage: context }),
      };
      if (fixtureCase.expectThrow === true) {
        expect(() => applyWorkItemEvent(current, reassign)).toThrow();
        break;
      }
      const next = applyWorkItemEvent(current, reassign);
      if (fixtureCase.expectOwner !== undefined) {
        expect(next.ownerRef).toBe(fixtureCase.expectOwner);
      }
      if (fixtureCase.expectWatchers !== undefined) {
        expect([...next.watchers].sort()).toEqual([...fixtureCase.expectWatchers].sort());
      }
      break;
    }
    case 'claimable': {
      const open: WorkItemOpen = {
        workItemId: 'wi-fx',
        origin: 'thread',
        purpose: 'member-message',
        risk: 'routine',
        serviceTier: 'concierge',
        slaPolicyId: 'sla-concierge',
        policyVersion: 1,
        responseDueAt: '2026-03-02T09:00:00Z',
        poolId: null,
        openedAt: '2026-03-02T08:00:00Z',
      };
      const log: WorkItemEvent[] =
        fixtureCase.ownerRef == null
          ? []
          : [
              {
                workItemId: 'wi-fx',
                eventSeq: 1,
                eventType: 'claimed',
                occurredAt: '2026-03-02T08:05:00Z',
                toOwnerRef: fixtureCase.ownerRef,
                reason: 'claim',
                contextPackage: context,
              },
            ];
      const item = foldWorkItem(open, log);
      expect(isClaimable(item)).toBe(fixtureCase.expectClaimable);
      break;
    }
    case 'escalation': {
      const timer: SlaTimer = {
        timerType: 'next_response',
        startedAt: fixtureCase.startedAt as string,
        dueAt: fixtureCase.dueAt as string,
        pausedTotalSeconds: fixtureCase.pausedSeconds ?? 0,
        state: 'running',
      };
      const policy: SlaPolicy = {
        policyId: 'sla-concierge',
        version: 1,
        effectiveOn: '2026-01-01',
        memberTier: 'concierge',
        hoursMode: 'after_hours',
        firstResponseTargetMinutes: 60,
        nextResponseTargetMinutes: 60,
        resolutionTargetMinutes: 240,
        escalationChain: conciergeChain,
        quietHoursExempt: true,
      };
      const fired = planEscalation(policy, timer, fixtureCase.now as string);
      expect(fired.map((step) => step.step.action)).toEqual(fixtureCase.expectActions);
      break;
    }
    case 'timer-state': {
      const timer: SlaTimer = {
        timerType: 'next_response',
        startedAt: fixtureCase.startedAt ?? '2026-03-02T08:00:00Z',
        dueAt: fixtureCase.dueAt as string,
        pausedTotalSeconds: fixtureCase.pausedSeconds ?? 0,
        state: fixtureCase.timerStateIn ?? 'running',
      };
      expect(computeTimerState(timer, fixtureCase.now as string)).toBe(fixtureCase.expectState);
      break;
    }
    default: {
      throw new Error(
        `unrecognized fixture op ${JSON.stringify((fixtureCase as { op: string }).op)} — ` +
          'the dispatcher refuses unknown cases (review-009)',
      );
    }
  }
}

interface TaskingFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly cases: readonly FixtureCase[];
}

for (const requirementId of ['REQ-TASK-002', 'REQ-TASK-019', 'REQ-TASK-029']) {
  describe(`${requirementId} fixture pack (4-class floor)`, () => {
    const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);

    it('carries all four fixture classes with the synthetic watermark', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
    });

    it('every case declares a recognized op (load-time validation, review-009)', () => {
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as unknown as TaskingFixture;
        expect(fixture.cases.length).toBeGreaterThan(0);
        for (const fixtureCase of fixture.cases) {
          expect(
            (acceptedOps as readonly string[]).includes(fixtureCase.op),
            `${fixtureClass}: unknown op ${JSON.stringify(fixtureCase.op)}`,
          ).toBe(true);
        }
      }
    });

    for (const fixtureClass of requiredFixtureClasses) {
      describe(fixtureClass, () => {
        const fixture = pack.fixtures[fixtureClass] as unknown as TaskingFixture;
        for (const fixtureCase of fixture.cases) {
          it(fixtureCase.name, () => {
            runCase(fixtureCase);
          });
        }
      });
    }
  });
}

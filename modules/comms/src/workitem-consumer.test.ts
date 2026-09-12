import { createHash } from 'node:crypto';

import type { Queryable, WorkItem } from '@practicehub/events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const events = vi.hoisted(() => ({
  openWorkItem: vi.fn(),
  appendEvents: vi.fn(),
  claimWorkItem: vi.fn(),
  loadWorkItem: vi.fn(),
  reassignWorkItem: vi.fn(),
}));

vi.mock('@practicehub/events', () => events);

import {
  appendHoldingTaskEventsOnce,
  openAccountableThread,
  resolveAccountableThread,
  takeAccountableThread,
} from './workitem-consumer.js';
import { openThread } from './thread.js';

const item: WorkItem = {
  workItemId: 'work-1',
  origin: 'thread',
  subjectRef: 'thread:thread-1',
  purpose: 'member-message',
  risk: 'routine',
  serviceTier: 'concierge',
  slaPolicyId: 'sla-1',
  policyVersion: 1,
  hasSla: true,
  status: 'open',
  priority: 'normal',
  ownerRef: 'guide-1',
  poolId: null,
  watchers: [],
  escalated: false,
  openedAt: '2026-09-12T14:00:00Z',
  responseDueAt: '2026-09-12T15:00:00Z',
  firstOwnedAt: '2026-09-12T14:00:00Z',
  lastEventSeq: 4,
};

function executor() {
  return { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) } satisfies Queryable;
}

function domainThread(ownerRef: string | null, escalated = false) {
  return openThread({
    tenantId: 'tenant-a',
    threadId: 'thread-1',
    personRef: 'person-1',
    workItemId: 'work-1',
    channel: 'sms',
    purpose: 'treatment',
    ownerRef,
    escalated,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  events.openWorkItem.mockResolvedValue({ ...item, ownerRef: null, lastEventSeq: 3 });
  events.appendEvents.mockResolvedValue(item);
  events.claimWorkItem.mockResolvedValue({ ...item, ownerRef: 'guide-2' });
  events.reassignWorkItem.mockResolvedValue({ ...item, ownerRef: 'guide-2' });
  events.loadWorkItem.mockResolvedValue(item);
});

describe('real WorkItem API consumer boundary', () => {
  it('opens, assigns and persists Thread in one caller transaction', async () => {
    const exec = executor();
    const result = await openAccountableThread(exec, {
      tenantId: 'tenant-a',
      threadId: 'thread-1',
      personRef: 'person-1',
      workItemId: 'work-1',
      ownerRef: 'guide-1',
      poolId: 'guide-pool',
      serviceTier: 'concierge',
      slaPolicyId: 'sla-1',
      policyVersion: 1,
      openedAt: '2026-09-12T14:00:00Z',
      firstResponseDueAt: '2026-09-12T15:00:00Z',
      actorRef: 'router-1',
    });
    expect(events.openWorkItem).toHaveBeenCalledOnce();
    expect(events.appendEvents).toHaveBeenCalledWith(exec, 'tenant-a', 'work-1', [
      expect.objectContaining({ eventType: 'assigned', toOwnerRef: 'guide-1' }),
    ]);
    expect(exec.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO comms.thread'),
      expect.any(Array),
    );
    expect(result.thread.ownerRef).toBe('guide-1');
  });

  it('uses row-locked claim for pooled work and reassignment for owned escalation', async () => {
    const common = {
      toOwnerRef: 'guide-2',
      actorRef: 'guide-2',
      occurredAt: '2026-09-12T14:05:00Z',
      contextPackage: { transcriptRef: 'transcript:thread-1', timerState: [] },
    };
    const pooled = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ work_item_ref: 'work-1', owner_ref: null, escalated: false, status: 'open' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
    } satisfies Queryable;
    const escalated = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            { work_item_ref: 'work-1', owner_ref: 'guide-1', escalated: true, status: 'open' },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
    } satisfies Queryable;
    await takeAccountableThread(pooled, { thread: domainThread(null), ...common });
    await takeAccountableThread(escalated, { thread: domainThread('guide-1', true), ...common });
    expect(events.claimWorkItem).toHaveBeenCalledOnce();
    expect(events.reassignWorkItem).toHaveBeenCalledWith(
      escalated,
      expect.objectContaining({ reason: 'escalation', workItemId: 'work-1' }),
    );
  });

  it('fences holding task events and rejects changed replay intent', async () => {
    const taskEvents = [
      {
        workItemId: 'work-1',
        eventSeq: 4,
        eventType: 'holding_reply' as const,
        occurredAt: '2026-09-12T14:00:00Z',
        actorRef: 'guide-1',
      },
    ];
    const hash = createHash('sha256').update(JSON.stringify(taskEvents)).digest('hex');
    const first = {
      query: vi.fn().mockResolvedValueOnce({ rows: [{ intent_hash: hash }], rowCount: 1 }),
    } satisfies Queryable;
    await expect(
      appendHoldingTaskEventsOnce(first, {
        tenantId: 'tenant-a',
        idempotencyKey: 'holding-key',
        events: taskEvents,
        createdAt: '2026-09-12T14:00:00Z',
      }),
    ).resolves.toBe('appended');
    expect(events.appendEvents).toHaveBeenCalledOnce();

    events.appendEvents.mockClear();
    const replay = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({
          rows: [{ intent_hash: hash, work_item_ref: 'work-1' }],
          rowCount: 1,
        }),
    } satisfies Queryable;
    await expect(
      appendHoldingTaskEventsOnce(replay, {
        tenantId: 'tenant-a',
        idempotencyKey: 'holding-key',
        events: taskEvents,
        createdAt: '2026-09-12T15:00:00Z',
      }),
    ).resolves.toBe('duplicate');
    expect(events.appendEvents).not.toHaveBeenCalled();

    const changed = [
      {
        workItemId: 'work-1',
        eventSeq: 4,
        eventType: 'holding_reply' as const,
        occurredAt: '2026-09-12T15:00:00Z',
        actorRef: 'guide-1',
      },
    ];
    const conflict = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({
          rows: [{ intent_hash: hash, work_item_ref: 'work-1' }],
          rowCount: 1,
        }),
    } satisfies Queryable;
    await expect(
      appendHoldingTaskEventsOnce(conflict, {
        tenantId: 'tenant-a',
        idempotencyKey: 'holding-key',
        events: changed,
        createdAt: '2026-09-12T15:00:00Z',
      }),
    ).rejects.toThrow('changed intent');
  });

  it('requires Thread closure after WorkItem resolution so the caller transaction rolls both back', async () => {
    const exec = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } satisfies Queryable;
    await expect(
      resolveAccountableThread(exec, {
        thread: domainThread('guide-1'),
        actorRef: 'guide-1',
        occurredAt: '2026-09-12T16:00:00Z',
        disposition: 'answered',
        evidenceRef: 'audit:1',
      }),
    ).rejects.toThrow('roll back the WorkItem resolution');
    expect(events.appendEvents).toHaveBeenCalledWith(exec, 'tenant-a', 'work-1', [
      expect.objectContaining({ eventType: 'resolved' }),
    ]);
  });
});

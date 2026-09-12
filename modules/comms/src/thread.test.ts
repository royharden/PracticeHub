import type { ConsentStateRow } from '@practicehub/consent';
import type { ContextPackage } from '@practicehub/events';
import { describe, expect, it, vi } from 'vitest';

import {
  claimThreadEvents,
  escalationNotificationKeys,
  sendAccountableMessage,
  type AccountableMessagePorts,
} from './accountable-message.js';
import {
  openThread,
  readAuthorizedThread,
  reconcileDelivery,
  recordMessage,
  resolveThread,
} from './thread.js';

const now = '2026-09-12T14:00:00.000Z';
const consentState: ConsentStateRow = {
  tenantId: 'tenant-a',
  personRef: 'person-1',
  scopeKey: 'communication|channel=sms|purpose=treatment',
  scopeType: 'communication',
  channel: 'sms',
  purpose: 'treatment',
  currentState: 'opted_in',
  effectiveAt: now,
  lastEventId: 'consent-1',
  quietHoursTz: 'UTC',
  jurisdiction: 'virtual',
  synthetic: true,
};

function thread(ownerRef: string | null = 'guide-1') {
  return openThread({
    tenantId: 'tenant-a',
    threadId: 'thread-1',
    personRef: 'person-1',
    workItemId: 'work-1',
    channel: 'sms',
    purpose: 'treatment',
    ownerRef,
  });
}

function consent(state: ConsentStateRow | null = consentState) {
  return {
    tenantId: 'tenant-a',
    personRef: 'person-1',
    channel: 'sms' as const,
    purpose: 'treatment' as const,
    state,
    urgency: 'routine' as const,
    asOf: now,
    actorRef: 'guide-1',
    occurredAt: now,
  };
}

function ports(): AccountableMessagePorts {
  return {
    cpaas: {
      sendMessage: vi.fn().mockResolvedValue({
        status: 'accepted',
        effectKey: 'effect-1',
        receiptRef: null,
        requiresReconciliation: true,
        deliveryState: 'unknown',
        synthetic: true,
      }),
    },
    appendConsentAudit: vi.fn().mockResolvedValue(undefined),
    appendTaskEventsOnce: vi.fn().mockResolvedValue(undefined),
  };
}

describe('four-class accountable-message fixtures', () => {
  it('happy: allows an opted-in send but preserves unknown until reconciliation', async () => {
    const dependencies = ports();
    const outcome = await sendAccountableMessage(dependencies, {
      thread: thread(),
      consent: consent(),
      actorRef: 'guide-1',
      messageId: 'message-1',
      payloadRef: 'payload:message-1',
      occurredAt: now,
    });
    expect(outcome.consent.allow).toBe(true);
    expect(outcome.rail?.deliveryState).toBe('unknown');
    expect(dependencies.cpaas.sendMessage).toHaveBeenCalledOnce();
  });

  it('failure: fails closed without invoking the rail and still audits the denial', async () => {
    const dependencies = ports();
    const outcome = await sendAccountableMessage(dependencies, {
      thread: thread(),
      consent: consent(null),
      actorRef: 'guide-1',
      messageId: 'message-1',
      payloadRef: 'payload:message-1',
      occurredAt: now,
    });
    expect(outcome.consent.reason).toBe('no-consent-on-record');
    expect(outcome.rail).toBeNull();
    expect(dependencies.cpaas.sendMessage).not.toHaveBeenCalled();
    expect(dependencies.appendConsentAudit).toHaveBeenCalledOnce();
  });

  it('boundary: a holding reply pauses next_response and starts resolution', async () => {
    const dependencies = ports();
    vi.mocked(dependencies.cpaas.sendMessage).mockResolvedValue({
      status: 'accepted',
      effectKey: 'effect-1',
      receiptRef: null,
      requiresReconciliation: true,
      deliveryState: 'accepted',
      synthetic: true,
    });
    const outcome = await sendAccountableMessage(dependencies, {
      thread: thread(),
      consent: consent(),
      actorRef: 'guide-1',
      messageId: 'message-1',
      payloadRef: 'payload:message-1',
      occurredAt: now,
      holding: { resolutionDueAt: '2026-09-12T18:00:00.000Z', taskBaseSeq: 8 },
    });
    expect(outcome.taskEvents.map((event) => event.eventType)).toEqual([
      'holding_reply',
      'timer_paused',
      'timer_started',
    ]);
    expect(outcome.taskEvents[1]).toMatchObject({ timerType: 'next_response' });
    expect(outcome.taskEvents[2]).toMatchObject({ timerType: 'resolution' });
  });

  it('recovery: duplicate inbound and absent receipt never create a second effect', () => {
    const message = {
      messageId: 'message-1',
      direction: 'inbound' as const,
      contentRef: 'content:1',
      occurredAt: now,
      vendorEventKey: 'vendor-1',
      effectKey: 'effect-1',
      holding: false,
    };
    const once = recordMessage(thread(), message);
    const twice = recordMessage(once, message);
    expect(twice).toBe(once);
    expect(
      reconcileDelivery(once, {
        messageId: 'message-1',
        messageVendorEventKey: 'vendor-1',
        receiptEventKey: 'receipt-event-1',
        effectKey: 'effect-1',
        outcome: null,
        observedAt: now,
      }).messages[0]?.deliveryState,
    ).toBe('unknown');
  });
});

describe('ownership, visibility, escalation and closure invariants', () => {
  it('transfers an unowned task with the actual context package and rejects a second claim', () => {
    const context: ContextPackage = {
      transcriptRef: 'transcript:thread-1',
      priorOwnerNotesRef: 'notes:thread-1',
      openOrders: ['order-1'],
      timerState: [],
      consentFlags: ['sms:opted-in'],
    };
    expect(
      claimThreadEvents({
        thread: thread(null),
        taskBaseSeq: 4,
        actorRef: 'guide-2',
        occurredAt: now,
        context,
      })[0],
    ).toMatchObject({ eventType: 'claimed', toOwnerRef: 'guide-2', contextPackage: context });
    expect(() =>
      claimThreadEvents({
        thread: thread(),
        taskBaseSeq: 4,
        actorRef: 'guide-2',
        occurredAt: now,
        context,
      }),
    ).toThrow('already claimed');
  });

  it('uses a distinct SMS fallback key rather than retrying the push rail', () => {
    const keys = escalationNotificationKeys({
      tenantId: 'tenant-a',
      threadId: 'thread-1',
      step: 2,
    });
    expect(keys.primary).toContain(':push');
    expect(keys.fallback).toContain(':sms');
    expect(keys.primary).not.toBe(keys.fallback);
  });

  it('returns actual history and task context only after authorization', async () => {
    const subject = recordMessage(thread(), {
      messageId: 'message-1',
      direction: 'inbound',
      contentRef: 'content:1',
      occurredAt: now,
      vendorEventKey: 'vendor-1',
      holding: false,
    });
    const context: ContextPackage = {
      transcriptRef: 'transcript:1',
      openOrders: ['order-1'],
      timerState: [],
    };
    const allowed = await readAuthorizedThread(
      {
        authorize: vi.fn().mockResolvedValue(true),
        loadThread: vi.fn().mockResolvedValue(subject),
        loadContext: vi.fn().mockResolvedValue({ workItemId: 'work-1', context }),
        loadTaskEvents: vi
          .fn()
          .mockResolvedValue([
            { workItemId: 'work-1', eventSeq: 1, eventType: 'opened', occurredAt: now },
          ]),
      },
      { tenantId: 'tenant-a', actorRef: 'guide-2', threadId: 'thread-1' },
    );
    expect(allowed.thread.messages).toHaveLength(1);
    expect(allowed.context.openOrders).toEqual(['order-1']);
    expect(allowed.taskEvents).toHaveLength(1);
  });

  it('refuses a same-tenant loader response for a different authorized thread', async () => {
    await expect(
      readAuthorizedThread(
        {
          authorize: vi.fn().mockResolvedValue(true),
          loadThread: vi.fn().mockResolvedValue({ ...thread(), threadId: 'thread-other' }),
          loadContext: vi.fn(),
          loadTaskEvents: vi.fn(),
        },
        { tenantId: 'tenant-a', actorRef: 'guide-2', threadId: 'thread-1' },
      ),
    ).rejects.toThrow('thread not found');
  });

  it('requires explicit disposition and evidence to close', () => {
    expect(() => resolveThread(thread(), { disposition: '', evidenceRef: '' })).toThrow();
    expect(
      resolveThread(thread(), { disposition: 'answered', evidenceRef: 'audit:42' }),
    ).toMatchObject({
      status: 'resolved',
      resolutionDisposition: 'answered',
      resolutionEvidenceRef: 'audit:42',
    });
  });
});

describe('review regressions', () => {
  it('does not use email consent for an SMS thread', async () => {
    const dependencies = ports();
    await expect(
      sendAccountableMessage(dependencies, {
        thread: thread(),
        consent: { ...consent(), channel: 'email' },
        actorRef: 'guide-1',
        messageId: 'message-1',
        payloadRef: 'payload:message-1',
        occurredAt: now,
      }),
    ).rejects.toThrow('consent scope does not match');
    expect(dependencies.cpaas.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects a consent projection whose identity or scope differs from the send', async () => {
    const dependencies = ports();
    await expect(
      sendAccountableMessage(dependencies, {
        thread: thread(),
        consent: consent({ ...consentState, tenantId: 'tenant-other' }),
        actorRef: 'guide-1',
        messageId: 'message-1',
        payloadRef: 'payload:1',
        occurredAt: now,
      }),
    ).rejects.toThrow('consent state does not match');
    expect(dependencies.cpaas.sendMessage).not.toHaveBeenCalled();
  });

  it('evaluates consent expiry at actual send time rather than caller asOf', async () => {
    const dependencies = ports();
    const result = await sendAccountableMessage(dependencies, {
      thread: thread(),
      consent: {
        ...consent({ ...consentState, expiresAt: '2026-09-12T13:00:00.000Z' }),
        asOf: '2026-09-12T12:30:00.000Z',
      },
      actorRef: 'guide-1',
      messageId: 'message-1',
      payloadRef: 'payload:1',
      occurredAt: now,
    });
    expect(result.consent.reason).toBe('consent-expired');
    expect(dependencies.cpaas.sendMessage).not.toHaveBeenCalled();
  });

  it('does not persist holding/SLA events when the rail rejects the send', async () => {
    const dependencies = ports();
    vi.mocked(dependencies.cpaas.sendMessage).mockResolvedValue({
      status: 'rejected',
      effectKey: 'effect-1',
      receiptRef: null,
      requiresReconciliation: false,
      deliveryState: 'failed',
      synthetic: true,
    });
    const result = await sendAccountableMessage(dependencies, {
      thread: thread(),
      consent: consent(),
      actorRef: 'guide-1',
      messageId: 'message-1',
      payloadRef: 'payload:message-1',
      occurredAt: now,
      holding: { resolutionDueAt: '2026-09-12T18:00:00.000Z', taskBaseSeq: 8 },
    });
    expect(result.taskEvents).toEqual([]);
    expect(dependencies.appendTaskEventsOnce).not.toHaveBeenCalled();
  });

  it('does not persist holding/SLA events for an uncertain external effect', async () => {
    const dependencies = ports();
    const result = await sendAccountableMessage(dependencies, {
      thread: thread(),
      consent: consent(),
      actorRef: 'guide-1',
      messageId: 'message-1',
      payloadRef: 'payload:message-1',
      occurredAt: now,
      holding: { resolutionDueAt: '2026-09-12T18:00:00.000Z', taskBaseSeq: 8 },
    });
    expect(result.rail).toMatchObject({ status: 'accepted', deliveryState: 'unknown' });
    expect(result.taskEvents).toEqual([]);
    expect(dependencies.appendTaskEventsOnce).not.toHaveBeenCalled();
  });

  it('uses collision-safe tenant tuple encoding', async () => {
    const { tenantScopedKey } = await import('./thread.js');
    expect(tenantScopedKey('a:b', 'c')).not.toBe(tenantScopedKey('a', 'b:c'));
  });

  it('rejects a duplicate vendor key with changed payload', () => {
    const once = recordMessage(thread(), {
      messageId: 'message-1',
      direction: 'inbound',
      contentRef: 'content:1',
      occurredAt: now,
      vendorEventKey: 'vendor-1',
      holding: false,
    });
    expect(() =>
      recordMessage(once, {
        messageId: 'message-1',
        direction: 'inbound',
        contentRef: 'content:changed',
        occurredAt: now,
        vendorEventKey: 'vendor-1',
        holding: false,
      }),
    ).toThrow('duplicate vendor key changed');
  });

  it('rejects a late receipt that would regress delivered state', () => {
    const delivered = recordMessage(thread(), {
      messageId: 'message-1',
      direction: 'outbound',
      contentRef: 'content:1',
      occurredAt: now,
      vendorEventKey: 'vendor-1',
      effectKey: 'effect-1',
      deliveryState: 'delivered',
      holding: false,
    });
    expect(() =>
      reconcileDelivery(delivered, {
        messageId: 'message-1',
        messageVendorEventKey: 'vendor-1',
        receiptEventKey: 'receipt-event-2',
        effectKey: 'effect-1',
        outcome: 'accepted',
        observedAt: '2026-09-12T14:01:00.000Z',
      }),
    ).toThrow('regress a terminal');
  });

  it('rejects invalid message and receipt timestamps rather than comparing NaN', () => {
    expect(() =>
      recordMessage(thread(), {
        messageId: 'message-1',
        direction: 'inbound',
        contentRef: 'content:1',
        occurredAt: 'invalid',
        vendorEventKey: 'vendor-1',
        holding: false,
      }),
    ).toThrow('valid timestamp');
    const message = recordMessage(thread(), {
      messageId: 'message-1',
      direction: 'outbound',
      contentRef: 'content:1',
      occurredAt: now,
      vendorEventKey: 'vendor-1',
      effectKey: 'effect-1',
      holding: false,
    });
    expect(() =>
      reconcileDelivery(message, {
        messageId: 'message-1',
        messageVendorEventKey: 'vendor-1',
        receiptEventKey: 'receipt-event-invalid',
        effectKey: 'effect-1',
        outcome: 'delivered',
        observedAt: 'invalid',
      }),
    ).toThrow('valid timestamp');
  });

  it('uses reassignment semantics to take over an owned escalated thread', () => {
    const context: ContextPackage = { timerState: [] };
    expect(
      claimThreadEvents({
        thread: { ...thread(), escalated: true },
        taskBaseSeq: 9,
        actorRef: 'guide-2',
        occurredAt: now,
        context,
      })[0],
    ).toMatchObject({
      eventType: 'reassigned',
      fromOwnerRef: 'guide-1',
      toOwnerRef: 'guide-2',
      reason: 'escalation',
    });
  });

  it('refuses to claim a resolved unowned thread', () => {
    const context: ContextPackage = { timerState: [] };
    const closed = resolveThread(thread(null), { disposition: 'answered', evidenceRef: 'audit:1' });
    expect(() =>
      claimThreadEvents({
        thread: closed,
        taskBaseSeq: 4,
        actorRef: 'guide-2',
        occurredAt: now,
        context,
      }),
    ).toThrow('resolved thread is not claimable');
  });
});

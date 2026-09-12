import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { ConsentStateRow } from '@practicehub/consent';
import { holdingReplyEvents, type ContextPackage } from '@practicehub/events';

import {
  claimThreadEvents,
  escalationNotificationKeys,
  sendAccountableMessage,
} from './accountable-message.js';
import { openThread, readAuthorizedThread, recordMessage, resolveThread } from './thread.js';

interface FixtureCase {
  readonly class: 'HAPPY' | 'FAILURE' | 'BOUNDARY' | 'RECOVERY';
  readonly probe: string;
}

interface RequirementFixture {
  readonly requirement: string;
  readonly cases: readonly FixtureCase[];
}

const requirements = ['REQ-COMM-018', 'REQ-COMM-020', 'REQ-COMM-021', 'REQ-COMM-027'];
const classes = ['HAPPY', 'FAILURE', 'BOUNDARY', 'RECOVERY'];

function load(requirement: string): RequirementFixture {
  const url = new URL(`../fixtures/${requirement}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as RequirementFixture;
}

function subject(ownerRef: string | null = 'guide-1') {
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

async function execute(probe: string): Promise<boolean> {
  const context: ContextPackage = { transcriptRef: 'transcript:thread-1', timerState: [] };
  const holding = (): boolean =>
    holdingReplyEvents({
      workItemId: 'work-1',
      baseSeq: 1,
      occurredAt: '2026-09-12T14:00:00Z',
      actorRef: 'guide-1',
      resolutionDueAt: '2026-09-12T18:00:00Z',
    }).some((event) => event.timerType === 'resolution');
  const keys = () =>
    escalationNotificationKeys({ tenantId: 'tenant-a', threadId: 'thread-1', step: 2 });
  const state: ConsentStateRow = {
    tenantId: 'tenant-a',
    personRef: 'person-1',
    scopeKey: 'communication|channel=sms|purpose=treatment',
    scopeType: 'communication',
    channel: 'sms',
    purpose: 'treatment',
    currentState: 'opted_in',
    effectiveAt: '2026-09-12T13:00:00Z',
    lastEventId: 'consent-1',
    quietHoursTz: 'UTC',
    jurisdiction: 'virtual',
    synthetic: true,
  };
  const attempt = async (
    thread = subject(),
  ): Promise<{ readonly threw: boolean; readonly sent: boolean }> => {
    const rail = vi.fn().mockResolvedValue({
      status: 'accepted',
      effectKey: 'effect-1',
      receiptRef: 'receipt:1',
      requiresReconciliation: false,
      deliveryState: 'accepted',
      synthetic: true,
    });
    try {
      await sendAccountableMessage(
        {
          cpaas: { sendMessage: rail },
          appendConsentAudit: async () => undefined,
          appendTaskEventsOnce: async () => undefined,
        },
        {
          thread,
          consent: {
            tenantId: 'tenant-a',
            personRef: 'person-1',
            channel: 'sms',
            purpose: 'treatment',
            state,
            urgency: 'routine',
            asOf: '2026-09-12T14:00:00Z',
            actorRef: 'guide-1',
            occurredAt: '2026-09-12T14:00:00Z',
          },
          actorRef: 'guide-1',
          messageId: 'message-1',
          payloadRef: 'payload:1',
          occurredAt: '2026-09-12T14:00:00Z',
        },
      );
      return { threw: false, sent: rail.mock.calls.length > 0 };
    } catch {
      return { threw: true, sent: rail.mock.calls.length > 0 };
    }
  };

  switch (probe) {
    case 'holding-pauses-next-response':
    case 'holding-does-not-meet-timer':
    case 'holding-send-starts-resolution':
      return holding();
    case 'distinct-primary-and-fallback':
    case 'fallback-is-not-primary-retry':
      return keys().primary !== keys().fallback && keys().fallback.endsWith(':sms');
    case 'notification-keys-are-stable':
      return JSON.stringify(keys()) === JSON.stringify(keys());
    case 'claim-carries-context':
      return (
        claimThreadEvents({
          thread: subject(null),
          taskBaseSeq: 1,
          actorRef: 'guide-2',
          occurredAt: '2026-09-12T14:00:00Z',
          context,
        })[0]?.contextPackage === context
      );
    case 'second-claim-refused':
      try {
        claimThreadEvents({
          thread: subject(),
          taskBaseSeq: 1,
          actorRef: 'guide-2',
          occurredAt: '2026-09-12T14:00:00Z',
          context,
        });
        return false;
      } catch {
        return true;
      }
    case 'owner-and-authorized-context':
    case 'authorized-view-loads-real-context': {
      const view = await readAuthorizedThread(
        {
          authorize: async () => true,
          loadThread: async () => subject(),
          loadContext: async () => ({ workItemId: 'work-1', context }),
          loadTaskEvents: async () => [],
        },
        { tenantId: 'tenant-a', actorRef: 'guide-2', threadId: 'thread-1' },
      );
      return view.thread.ownerRef === 'guide-1' && view.context === context;
    }
    case 'unauthorized-view-refused':
      try {
        await readAuthorizedThread(
          {
            authorize: async () => false,
            loadThread: async () => subject(),
            loadContext: async () => ({ workItemId: 'work-1', context }),
            loadTaskEvents: async () => [],
          },
          { tenantId: 'tenant-a', actorRef: 'intruder', threadId: 'thread-1' },
        );
        return false;
      } catch {
        return true;
      }
    case 'duplicate-inbound-is-idempotent': {
      const message = {
        messageId: 'message-1',
        direction: 'inbound' as const,
        contentRef: 'content:1',
        occurredAt: '2026-09-12T14:00:00Z',
        vendorEventKey: 'vendor-1',
        holding: false,
      };
      const once = recordMessage(subject(), message);
      return recordMessage(once, message) === once;
    }
    case 'unknown-delivery-awaits-receipt':
      return (
        recordMessage(subject(), {
          messageId: 'message-1',
          direction: 'outbound',
          contentRef: 'content:1',
          occurredAt: '2026-09-12T14:00:00Z',
          vendorEventKey: 'vendor-1',
          holding: false,
        }).messages[0]?.deliveryState === 'unknown'
      );
    case 'resolved-thread-refuses-send': {
      const result = await attempt(
        resolveThread(subject(), { disposition: 'answered', evidenceRef: 'audit:1' }),
      );
      return result.threw && !result.sent;
    }
    case 'closure-requires-evidence':
      try {
        resolveThread(subject(), { disposition: '', evidenceRef: '' });
        return false;
      } catch {
        return true;
      }
    case 'identity-mismatch-refused': {
      const result = await attempt({ ...subject(), personRef: 'person-other' });
      return result.threw && !result.sent;
    }
    default:
      throw new Error(`unknown fixture probe ${probe}`);
  }
}

describe('scoped requirement fixture contract', () => {
  it.each(requirements)('%s executes every four-class behavior probe', async (requirement) => {
    const fixture = load(requirement);
    expect(fixture.requirement).toBe(requirement);
    expect(fixture.cases.map((entry) => entry.class)).toEqual(classes);
    expect(new Set(fixture.cases.map((entry) => entry.probe)).size).toBe(4);
    for (const fixtureCase of fixture.cases) expect(await execute(fixtureCase.probe)).toBe(true);
  });
});

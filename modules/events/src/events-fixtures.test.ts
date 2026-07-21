/**
 * Executable 4-class fixture pack for the WP-021 requirement slice
 * (REQ-PLAT-018: integration idempotency and replay receipt). Every case runs
 * against the REAL substrate functions — a fixture that merely "exists" without
 * encoding its acceptance criterion cannot pass here. The classes trace the
 * requirement essence integration-delivery-failure -> safe-replay ->
 * reconciled-effect:
 *   HAPPY    — an event delivers exactly once (drain publish, inbox records).
 *   BOUNDARY — at-least-once redelivery dedups; the retry/dead-letter boundary.
 *   FAILURE  — a failed delivery retries then dead-letters; a capability denied
 *              AT DRAIN parks with no side effect; a malformed envelope is refused.
 *   RECOVERY — replay after a crash never re-sends a landed effect; an unknown
 *              outcome reconciles from a receipt; a dead reconciliation alarms.
 *
 * Review-009 discipline: the accepted-op list is validated at LOAD (an unknown
 * op fails the pack's structural test, not silently), and the dispatcher ends in
 * a throwing default.
 */
import { fileURLToPath } from 'node:url';

import {
  foldInbox,
  inboxDedupDecision,
  planDrainAction,
  planFailureAction,
  reconcileUnknownDelivery,
  reconciliationAlarm,
  recoveryFenceDecision,
  validateEventEnvelope,
  type DeliveryStatus,
  type EventEnvelopeInput,
} from '@practicehub/platform';
import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));

const acceptedOps = ['envelope', 'drain', 'dedup', 'failure', 'replay', 'reconcile'] as const;
type FixtureOp = (typeof acceptedOps)[number];

const defaultEnvelope: EventEnvelopeInput<unknown> = {
  eventId: '01H8XGJWBWBAQ4Z5Z5Z5Z5Z5Z5',
  tenantId: 'northwind-synthetic',
  type: 'consent.recorded',
  aggregate: { type: 'consent-ledger', id: 'np-fx', version: 1 },
  occurredAt: '2026-03-15T00:00:00Z',
  recordedAt: '2026-03-15T00:00:00Z',
  source: { module: 'consent' },
  idempotencyKey: 'consent:np-fx:recorded:0001',
  dataClassification: 'demographic',
  payload: { scope: 'sms/treatment' },
  synthetic: true,
};

interface FixtureCase {
  readonly name: string;
  readonly op: FixtureOp;
  readonly envelope?: Partial<EventEnvelopeInput<unknown>>;
  readonly expectValid?: boolean;
  readonly expectError?: string;
  readonly delivery?: { readonly status: DeliveryStatus; readonly attempts: number };
  readonly capabilityAllowed?: boolean;
  readonly inbox?: 'process' | 'skip-duplicate';
  readonly expectAction?: string;
  readonly seen?: readonly { readonly consumer: string; readonly eventId: string }[];
  readonly consumer?: string;
  readonly eventId?: string;
  readonly expectDecision?: 'process' | 'skip-duplicate';
  readonly maxAttempts?: number;
  readonly expectFailure?: 'retry-later' | 'dead-letter';
  readonly alreadyConsumed?: boolean;
  readonly expectResend?: 'resend-safe' | 'reconciled-no-resend';
  readonly receiptFound?: boolean;
  readonly expectStatus?: DeliveryStatus;
  readonly expectedVolume?: number;
  readonly observedVolume?: number;
  readonly ran?: boolean;
  readonly expectAlarm?: boolean;
}

interface EventsFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly cases: readonly FixtureCase[];
}

function runCase(fixtureCase: FixtureCase): void {
  switch (fixtureCase.op) {
    case 'envelope': {
      const input = { ...defaultEnvelope, ...fixtureCase.envelope } as EventEnvelopeInput<unknown>;
      if (fixtureCase.expectError !== undefined) {
        expect(() => validateEventEnvelope(input)).toThrow();
        break;
      }
      expect(() => validateEventEnvelope(input)).not.toThrow();
      if (fixtureCase.expectValid !== undefined) {
        expect(true).toBe(fixtureCase.expectValid);
      }
      break;
    }
    case 'drain': {
      const action = planDrainAction({
        delivery: fixtureCase.delivery as { status: DeliveryStatus; attempts: number },
        capabilityAllowed: fixtureCase.capabilityAllowed ?? true,
        inbox: fixtureCase.inbox ?? 'process',
      });
      expect(action).toBe(fixtureCase.expectAction);
      break;
    }
    case 'dedup': {
      const seen = foldInbox(fixtureCase.seen ?? []);
      const decision = inboxDedupDecision(
        seen,
        fixtureCase.consumer ?? 'thread-projector',
        fixtureCase.eventId ?? defaultEnvelope.eventId,
      );
      expect(decision).toBe(fixtureCase.expectDecision);
      break;
    }
    case 'failure': {
      const failure = planFailureAction(fixtureCase.delivery ?? { status: 'failed', attempts: 1 }, {
        maxAttempts: fixtureCase.maxAttempts ?? 3,
      });
      expect(failure).toBe(fixtureCase.expectFailure);
      break;
    }
    case 'replay': {
      const decision = recoveryFenceDecision(
        fixtureCase.delivery ?? { status: 'pending', attempts: 0 },
        fixtureCase.alreadyConsumed ?? false,
      );
      expect(decision).toBe(fixtureCase.expectResend);
      break;
    }
    case 'reconcile': {
      if (fixtureCase.expectStatus !== undefined) {
        const status = reconcileUnknownDelivery(
          fixtureCase.delivery ?? { status: 'unknown', attempts: 1 },
          fixtureCase.receiptFound ?? false,
        );
        expect(status).toBe(fixtureCase.expectStatus);
        break;
      }
      const alarm = reconciliationAlarm({
        expectedVolume: fixtureCase.expectedVolume ?? 0,
        observedVolume: fixtureCase.observedVolume ?? 0,
        ran: fixtureCase.ran ?? true,
      });
      expect(alarm).toBe(fixtureCase.expectAlarm);
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

const requirementId = 'REQ-PLAT-018';

describe(`${requirementId} fixture pack (4-class floor)`, () => {
  const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);

  it('carries all four fixture classes with the synthetic watermark', () => {
    expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
  });

  it('every case declares a recognized op (load-time validation, review-009)', () => {
    for (const fixtureClass of requiredFixtureClasses) {
      const fixture = pack.fixtures[fixtureClass] as unknown as EventsFixture;
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
      const fixture = pack.fixtures[fixtureClass] as unknown as EventsFixture;
      for (const fixtureCase of fixture.cases) {
        it(fixtureCase.name, () => {
          runCase(fixtureCase);
        });
      }
    });
  }
});

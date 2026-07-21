import { describe, expect, it } from 'vitest';

import {
  deliveryStatuses,
  isLegalDeliveryTransition,
  planDrainAction,
  planFailureAction,
  OutboxError,
  type DeliveryStatus,
  type OutboxDelivery,
} from './outbox.js';

const pending: OutboxDelivery = { status: 'pending', attempts: 0 };

describe('outbox delivery state machine', () => {
  it('pending advances only to publishing; published and dead are terminal', () => {
    expect(isLegalDeliveryTransition('pending', 'publishing')).toBe(true);
    expect(isLegalDeliveryTransition('pending', 'published')).toBe(false);
    for (const to of deliveryStatuses) {
      expect(isLegalDeliveryTransition('published', to)).toBe(false);
      expect(isLegalDeliveryTransition('dead', to)).toBe(false);
    }
  });

  it('an unknown outcome resolves only to published or failed (never guessed)', () => {
    expect(isLegalDeliveryTransition('unknown', 'published')).toBe(true);
    expect(isLegalDeliveryTransition('unknown', 'failed')).toBe(true);
    expect(isLegalDeliveryTransition('unknown', 'dead')).toBe(false);
  });
});

describe('planDrainAction', () => {
  it('publishes a first sighting whose capability check passes', () => {
    expect(planDrainAction({ delivery: pending, capabilityAllowed: true, inbox: 'process' })).toBe(
      'publish',
    );
  });

  it('skips a redelivery without re-running the side effect (exactly-once effect)', () => {
    expect(
      planDrainAction({ delivery: pending, capabilityAllowed: true, inbox: 'skip-duplicate' }),
    ).toBe('skip-duplicate');
  });

  it('parks — never fires the side effect — when capability is denied at drain', () => {
    // Drain is authoritative: a kill-switch/rollback landing after enqueue parks
    // the event even though it was allowed when enqueued, and even on a first
    // sighting that would otherwise publish.
    expect(planDrainAction({ delivery: pending, capabilityAllowed: false, inbox: 'process' })).toBe(
      'park-denied',
    );
    expect(
      planDrainAction({ delivery: pending, capabilityAllowed: false, inbox: 'skip-duplicate' }),
    ).toBe('park-denied');
  });

  it('is a noop on an already-terminal delivery', () => {
    for (const status of ['published', 'dead'] as DeliveryStatus[]) {
      expect(
        planDrainAction({
          delivery: { status, attempts: 1 },
          capabilityAllowed: true,
          inbox: 'process',
        }),
      ).toBe('noop');
    }
  });
});

describe('planFailureAction', () => {
  it('retries until maxAttempts, then dead-letters', () => {
    expect(planFailureAction({ status: 'failed', attempts: 1 }, { maxAttempts: 3 })).toBe(
      'retry-later',
    );
    expect(planFailureAction({ status: 'failed', attempts: 3 }, { maxAttempts: 3 })).toBe(
      'dead-letter',
    );
  });

  it('rejects a nonsensical retry policy', () => {
    expect(() => planFailureAction({ status: 'failed', attempts: 1 }, { maxAttempts: 0 })).toThrow(
      OutboxError,
    );
  });
});

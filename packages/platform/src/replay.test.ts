import { describe, expect, it } from 'vitest';

import { type OutboxDelivery } from './outbox.js';
import {
  reconcileUnknownDelivery,
  reconciliationAlarm,
  recoveryFenceDecision,
  replayEquivalent,
} from './replay.js';

describe('replay-rebuild equivalence', () => {
  it('is true only for a byte-identical rebuild', () => {
    expect(replayEquivalent('[1,2,3]', '[1,2,3]')).toBe(true);
    expect(replayEquivalent('[1,2,3]', '[1,2,4]')).toBe(false);
  });
});

describe('recovery-epoch fence (no duplicate external send on replay)', () => {
  it('never re-sends an effect that already published or was already consumed', () => {
    const published: OutboxDelivery = { status: 'published', attempts: 1 };
    expect(recoveryFenceDecision(published, false)).toBe('reconciled-no-resend');
    const pending: OutboxDelivery = { status: 'pending', attempts: 0 };
    expect(recoveryFenceDecision(pending, true)).toBe('reconciled-no-resend');
  });

  it('allows a resend only for a not-yet-produced effect', () => {
    const pending: OutboxDelivery = { status: 'pending', attempts: 0 };
    expect(recoveryFenceDecision(pending, false)).toBe('resend-safe');
  });
});

describe('unknown-state reconciliation', () => {
  it('resolves unknown to published with a receipt, failed without one', () => {
    const unknown: OutboxDelivery = { status: 'unknown', attempts: 1 };
    expect(reconcileUnknownDelivery(unknown, true)).toBe('published');
    expect(reconcileUnknownDelivery(unknown, false)).toBe('failed');
  });

  it('refuses to reconcile a delivery that is not unknown', () => {
    expect(() => reconcileUnknownDelivery({ status: 'pending', attempts: 0 }, true)).toThrow();
  });
});

describe('reconciliation heartbeat alarm', () => {
  it('fires when the job did not run (a dead reconciliation is not a clean night)', () => {
    expect(reconciliationAlarm({ expectedVolume: 10, observedVolume: 0, ran: false })).toBe(true);
  });

  it('fires on any drift, quiet only on an exact match', () => {
    expect(reconciliationAlarm({ expectedVolume: 10, observedVolume: 9, ran: true })).toBe(true);
    expect(reconciliationAlarm({ expectedVolume: 10, observedVolume: 11, ran: true })).toBe(true);
    expect(reconciliationAlarm({ expectedVolume: 10, observedVolume: 10, ran: true })).toBe(false);
  });
});

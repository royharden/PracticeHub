import { describe, expect, it } from 'vitest';

import { ageQueues, businessDaysBetween, closureReport, escalateAging } from './aging.js';
import { partnerEvents } from './channels.js';
import type { ReferralCase } from './contracts.js';
import { applyPartnerEvent, closeLoop, reviewResults, sendReferral } from './loop.js';
import { consentFor, day, directory, NPI, notes, opened, rails, RECORDS } from './test-harness.js';

const dir = directory();
const context = { directory: dir, notes: notes() };

function sent(id: string, overrides: Parameters<typeof opened>[0] = {}, at = day(0)): ReferralCase {
  const referral = opened({ referralId: id, at, ...overrides });
  return sendReferral(
    referral,
    {
      consent: consentFor(referral.destinationNpi),
      records: RECORDS,
      at,
      coordinatorId: 'synthetic-coordinator-1',
    },
    rails(dir),
  );
}

function step(referral: ReferralCase, kind: 'acknowledged' | 'scheduled' | 'no-show', at: string) {
  const [event] = partnerEvents('esp', referral.referralId, referral.patientRef, [{ kind, at }]);
  if (!event) {
    throw new Error('script produced no events');
  }
  return applyPartnerEvent(referral, event, context);
}

describe('WP-074 aging queues', () => {
  it('counts business days, not calendar days', () => {
    expect(businessDaysBetween(day(0), day(4))).toBe(4);
    expect(businessDaysBetween(day(0), day(7))).toBe(5);
    expect(businessDaysBetween(day(4), day(7))).toBe(1);
  });

  it('surfaces open loops past their stage threshold, ranked by days outstanding', () => {
    const fresh = sent('synthetic-referral-fresh', {}, day(10));
    const unacked = sent('synthetic-referral-unacked', {}, day(0));
    const olderUnacked = sent('synthetic-referral-older', {}, day(-5));
    const unscheduled = step(sent('synthetic-referral-unscheduled'), 'acknowledged', day(1));

    const queues = ageQueues([fresh, unacked, olderUnacked, unscheduled], day(14));

    expect(queues.chase.map((item) => item.referralId)).toEqual([
      'synthetic-referral-older',
      'synthetic-referral-unacked',
      'synthetic-referral-unscheduled',
    ]);
    expect(queues.chase[0]?.daysOutstanding).toBe(19);
    expect(queues.chase[0]?.why).toBe('no acknowledgement within 5 business days');
    expect(queues.chase[2]?.why).toBe('no appointment within 10 days');
  });

  it('keeps patient-side and hold states off the chase list', () => {
    const noShow = step(
      step(sent('synthetic-referral-noshow'), 'scheduled', day(1)),
      'no-show',
      day(3),
    );
    const blocked = sendReferral(
      opened({ referralId: 'synthetic-referral-blocked' }),
      { consent: null, records: RECORDS, at: day(0), coordinatorId: 'synthetic-coordinator-1' },
      rails(dir),
    );
    const queues = ageQueues([noShow, blocked], day(20));
    expect(queues.chase).toHaveLength(0);
    expect(queues.patientFollowUp.map((item) => item.referralId)).toEqual([
      'synthetic-referral-noshow',
    ]);
    expect(queues.consentBlocked.map((item) => item.referralId)).toEqual([
      'synthetic-referral-blocked',
    ]);
  });

  it('puts overdue consult notes on the chase list and unreviewed results on the review queue', () => {
    const waiting = step(
      sent('synthetic-referral-waiting', { expectedReturnDays: 10 }),
      'scheduled',
      day(1),
    );
    const [note] = partnerEvents('esp', 'synthetic-referral-0001', 'synthetic-patient-0101', [
      { kind: 'consult-note', at: day(5), consultNoteRef: 'synthetic-consult-note-0001' },
    ]);
    if (!note) {
      throw new Error('script produced no events');
    }
    const returned = applyPartnerEvent(sent('synthetic-referral-0001'), note, context);
    const queues = ageQueues([waiting, returned], day(12));
    expect(queues.chase.map((item) => item.referralId)).toEqual(['synthetic-referral-waiting']);
    expect(queues.review.map((item) => item.referralId)).toEqual(['synthetic-referral-0001']);
  });

  it('never closes a loop, however old it is', () => {
    const ancient = sent('synthetic-referral-ancient', {}, day(-200));
    const aged = escalateAging(ancient, day(0));
    expect(aged.stage).toBe('sent');
    expect(aged.closure).toBeNull();
  });

  it('escalates an unacknowledged urgent referral to the ordering provider and the outer bound to the referrer, once', () => {
    const urgent = sent('synthetic-referral-urgent', { urgency: 'urgent' });
    const early = escalateAging(urgent, day(1));
    expect(early.escalations).toHaveLength(0);
    const late = escalateAging(escalateAging(urgent, day(2)), day(2));
    expect(late.escalations.map((item) => item.to)).toEqual(['ordering-provider']);

    const routine = escalateAging(sent('synthetic-referral-routine'), day(45));
    expect(routine.escalations.map((item) => item.to)).toEqual(['referring-clinician']);
    expect(escalateAging(routine, day(50)).escalations).toHaveLength(1);
  });
});

describe('WP-074 loop-closure report', () => {
  it('reports closure rate, results closure rate and days to close per destination', () => {
    const [note] = partnerEvents('esp', 'synthetic-referral-0001', 'synthetic-patient-0101', [
      { kind: 'consult-note', at: day(8), consultNoteRef: 'synthetic-consult-note-0001' },
    ]);
    if (!note) {
      throw new Error('script produced no events');
    }
    const closed = closeLoop(
      reviewResults(
        applyPartnerEvent(sent('synthetic-referral-0001'), note, context),
        'synthetic-clinician-a',
        day(10),
      ),
      'results-reviewed',
      day(10),
      'synthetic-clinician-a',
      dir,
    );
    const open = sent('synthetic-referral-open');
    const imaging = sent('synthetic-referral-imaging', { destinationNpi: NPI.imaging });

    const rows = closureReport([closed, open, imaging], 'destinationNpi');
    expect(rows).toEqual([
      {
        key: NPI.cardiology,
        total: 2,
        closed: 1,
        closureRate: 0.5,
        resultsClosureRate: 0.5,
        averageDaysToClose: 10,
      },
      {
        key: NPI.imaging,
        total: 1,
        closed: 0,
        closureRate: 0,
        resultsClosureRate: 0,
        averageDaysToClose: null,
      },
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import { partnerEvents } from './channels.js';
import { ReferralError, type PartnerEvent, type ReferralCase } from './contracts.js';
import {
  applyPartnerEvent,
  closeLoop,
  escalate,
  logOutreach,
  reassignReviewer,
  reopenReferral,
  reviewResults,
  sendReferral,
} from './loop.js';
import { consentFor, day, directory, NPI, notes, opened, rails, RECORDS } from './test-harness.js';

const dir = directory();
const context = { directory: dir, notes: notes() };

function send(referral: ReferralCase, at = day(0)): ReferralCase {
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

function events(
  referral: ReferralCase,
  script: Parameters<typeof partnerEvents>[3],
): PartnerEvent[] {
  return [...partnerEvents('esp', referral.referralId, referral.patientRef, script)];
}

function apply(referral: ReferralCase, list: readonly PartnerEvent[]): ReferralCase {
  return list.reduce((current, event) => applyPartnerEvent(current, event, context), referral);
}

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ReferralError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected a ReferralError');
}

describe('WP-074 loop closure end to end', () => {
  it('runs created -> sent -> acknowledged -> scheduled -> seen -> results -> reviewed -> closed', () => {
    let referral = send(opened());
    expect(referral.stage).toBe('sent');
    expect(referral.disclosures).toHaveLength(1);
    expect(referral.disclosures[0]?.channel).toBe('esp');
    expect(referral.disclosures[0]?.consentRef).toBe('synthetic-consent-0001');
    expect(referral.disclosures[0]?.artifactRefs).toHaveLength(2);

    referral = apply(
      referral,
      events(referral, [
        { kind: 'acknowledged', at: day(1) },
        { kind: 'scheduled', at: day(3) },
        { kind: 'seen', at: day(12) },
        { kind: 'consult-note', at: day(14), consultNoteRef: 'synthetic-consult-note-0001' },
      ]),
    );
    expect(referral.stage).toBe('results-returned');
    expect(referral.consultNoteRef).toBe('synthetic-consult-note-0001');

    referral = reviewResults(referral, 'synthetic-clinician-a', day(15));
    referral = closeLoop(referral, 'results-reviewed', day(15), 'synthetic-clinician-a', dir);

    expect(referral.stage).toBe('closed');
    expect(referral.closure).toEqual({ reason: 'results-reviewed', at: day(15) });
    expect(referral.stages.map((event) => event.stage)).toEqual([
      'created',
      'sent',
      'acknowledged',
      'scheduled',
      'seen',
      'results-returned',
      'reviewed',
      'closed',
    ]);
    expect(referral.notices.map((notice) => notice.stage)).toEqual([
      'sent',
      'acknowledged',
      'scheduled',
      'seen',
      'results-returned',
      'closed',
    ]);
    expect(referral.notices.every((notice) => notice.referrerNpi === NPI.referrerA)).toBe(true);
  });

  it('closes a fax-only destination through the same loop, keyed off the fax send', () => {
    let referral = send(opened({ destinationNpi: NPI.imaging }));
    expect(referral.disclosures[0]?.channel).toBe('fax');
    referral = apply(referral, [
      ...partnerEvents('fax', referral.referralId, referral.patientRef, [
        { kind: 'scheduled', at: day(2) },
        { kind: 'consult-note', at: day(9), consultNoteRef: 'synthetic-consult-note-0001' },
      ]),
    ]);
    referral = reviewResults(referral, 'synthetic-clinician-a', day(10));
    referral = closeLoop(referral, 'results-reviewed', day(10), 'synthetic-clinician-a', dir);
    expect(referral.stage).toBe('closed');
  });
});

describe('WP-074 closure invariants', () => {
  it('refuses to close on a booked appointment alone', () => {
    const referral = apply(send(opened()), events(opened(), [{ kind: 'scheduled', at: day(2) }]));
    expect(
      codeOf(() => closeLoop(referral, 'results-reviewed', day(3), 'synthetic-coordinator-1', dir)),
    ).toBe('CLOSURE_INVARIANT');
  });

  it('refuses to close returned results that nobody reviewed', () => {
    const referral = apply(
      send(opened()),
      events(opened(), [
        { kind: 'consult-note', at: day(9), consultNoteRef: 'synthetic-consult-note-0001' },
      ]),
    );
    expect(
      codeOf(() => closeLoop(referral, 'results-reviewed', day(10), 'synthetic-clinician-a', dir)),
    ).toBe('CLOSURE_INVARIANT');
  });

  it('refuses an unfinalized note and a note for another referral', () => {
    const referral = send(opened());
    const [draft] = events(referral, [
      { kind: 'consult-note', at: day(9), consultNoteRef: 'synthetic-consult-note-0002' },
    ]);
    const [foreign] = events(referral, [
      { kind: 'consult-note', at: day(9), consultNoteRef: 'synthetic-consult-note-0003' },
    ]);
    if (!draft || !foreign) {
      throw new Error('script produced no events');
    }
    expect(codeOf(() => applyPartnerEvent(referral, draft, context))).toBe('NOTE_NOT_FINAL');
    expect(codeOf(() => applyPartnerEvent(referral, foreign, context))).toBe('NOTE_MISMATCH');
  });

  it('routes the review to the currently assigned reviewer', () => {
    let referral = apply(
      send(opened()),
      events(opened(), [
        { kind: 'consult-note', at: day(9), consultNoteRef: 'synthetic-consult-note-0001' },
      ]),
    );
    referral = reassignReviewer(referral, 'synthetic-clinician-covering');
    expect(codeOf(() => reviewResults(referral, 'synthetic-clinician-a', day(10)))).toBe(
      'REVIEWER',
    );
    const reviewed = reviewResults(referral, 'synthetic-clinician-covering', day(10));
    expect(reviewed.review?.reviewerId).toBe('synthetic-clinician-covering');
  });

  it('refuses events that move a stage backwards and anything after closure', () => {
    let referral = apply(send(opened()), events(opened(), [{ kind: 'seen', at: day(5) }]));
    const [late] = events(referral, [{ kind: 'acknowledged', at: day(6) }]);
    if (!late) {
      throw new Error('script produced no events');
    }
    expect(codeOf(() => applyPartnerEvent(referral, late, context))).toBe('STAGE_ORDER');
    // Targeted fix: a decline before the visit still closes; after 'seen' it no longer does.
    let early = apply(send(opened()), events(opened(), [{ kind: 'acknowledged', at: day(2) }]));
    early = apply(early, events(early, [{ kind: 'declined', at: day(3), detail: 'panel closed' }]));
    expect(early.closure?.reason).toBe('declined-by-destination');
    expect(early.notices.at(-1)?.detail).toBe('declined: panel closed');
    const [afterClose] = events(early, [{ kind: 'scheduled', at: day(4) }]);
    if (!afterClose) throw new Error('script produced no events');
    expect(codeOf(() => applyPartnerEvent(early, afterClose, context))).toBe('LOOP_CLOSED');
    referral = apply(
      referral,
      events(referral, [{ kind: 'declined', at: day(7), detail: 'panel closed' }]),
    );
    expect(referral.closure).toBeNull();
  });

  it('closes after the outer bound only with outreach and a referrer escalation', () => {
    let referral = send(opened());
    expect(
      codeOf(() =>
        closeLoop(
          referral,
          'no-results-after-outer-bound',
          day(30),
          'synthetic-coordinator-1',
          dir,
        ),
      ),
    ).toBe('CLOSURE_INVARIANT');
    referral = logOutreach(referral, { at: day(20), method: 'call', note: 'left message' });
    expect(
      codeOf(() =>
        closeLoop(
          referral,
          'no-results-after-outer-bound',
          day(46),
          'synthetic-coordinator-1',
          dir,
        ),
      ),
    ).toBe('CLOSURE_INVARIANT');
    referral = escalate(referral, day(45), 'referring-clinician', 'outer bound passed');
    referral = closeLoop(
      referral,
      'no-results-after-outer-bound',
      day(46),
      'synthetic-coordinator-1',
      dir,
    );
    expect(referral.closure?.reason).toBe('no-results-after-outer-bound');
  });

  it('closes patient non-engagement only after attempts and a referrer notice, never when urgent', () => {
    let referral = apply(
      send(opened()),
      events(opened(), [
        { kind: 'scheduled', at: day(2) },
        { kind: 'no-show', at: day(8) },
      ]),
    );
    expect(referral.holds.at(-1)?.reason).toBe('patient-follow-up');
    expect(referral.notices.at(-1)?.stage).toBe('hold');
    referral = logOutreach(referral, { at: day(9), method: 'call', note: 'no answer' });
    expect(
      codeOf(() =>
        closeLoop(referral, 'patient-non-engagement', day(10), 'synthetic-coordinator-1', dir),
      ),
    ).toBe('CLOSURE_INVARIANT');
    referral = logOutreach(referral, { at: day(11), method: 'portal', note: 'message sent' });
    const closed = closeLoop(
      referral,
      'patient-non-engagement',
      day(12),
      'synthetic-coordinator-1',
      dir,
    );
    expect(closed.closure?.reason).toBe('patient-non-engagement');

    const urgent = { ...referral, urgency: 'urgent' as const };
    expect(
      codeOf(() =>
        closeLoop(urgent, 'patient-non-engagement', day(12), 'synthetic-coordinator-1', dir),
      ),
    ).toBe('CLOSURE_INVARIANT');
  });

  it('reopens a non-engagement closure in place and keeps its history', () => {
    let referral = apply(send(opened()), events(opened(), [{ kind: 'no-show', at: day(8) }]));
    referral = logOutreach(referral, { at: day(9), method: 'call', note: 'no answer' });
    referral = logOutreach(referral, { at: day(10), method: 'fax', note: 'letter' });
    referral = closeLoop(
      referral,
      'patient-non-engagement',
      day(11),
      'synthetic-coordinator-1',
      dir,
    );
    const reopened = reopenReferral(referral, day(20), 'synthetic-coordinator-2');
    expect(reopened.stage).toBe('created');
    expect(reopened.closure).toBeNull();
    expect(reopened.stages.length).toBe(referral.stages.length + 1);
    expect(send(reopened, day(21)).disclosures).toHaveLength(2);
  });

  it('honors a patient request that the referrer receive no updates', () => {
    const referral = send(opened({ referrerUpdatesOptOut: true }));
    expect(referral.stage).toBe('sent');
    expect(referral.notices).toHaveLength(0);
  });
});

describe('WP-074 consent gate on send', () => {
  it('sends nothing without current consent for this recipient', () => {
    const referral = opened();
    const r = rails(dir);
    for (const consent of [
      null,
      consentFor(NPI.imaging),
      consentFor(NPI.cardiology, { expiresAt: day(-1) }),
    ]) {
      const held = sendReferral(
        referral,
        { consent, records: RECORDS, at: day(0), coordinatorId: 'synthetic-coordinator-1' },
        r,
      );
      expect(held.stage).toBe('created');
      expect(held.disclosures).toHaveLength(0);
      expect(held.holds.at(-1)?.reason).toBe('consent-required');
    }
  });

  it('requires written consent for a Minnesota record and releases the hold once supplied', () => {
    const referral = opened({ patientState: 'MN', destinationNpi: NPI.orthoMn });
    const r = rails(dir);
    const held = sendReferral(
      referral,
      {
        consent: consentFor(NPI.orthoMn),
        records: RECORDS,
        at: day(0),
        coordinatorId: 'synthetic-coordinator-1',
      },
      r,
    );
    expect(held.holds.at(-1)?.reason).toBe('mn-written-consent-required');
    expect(held.disclosures).toHaveLength(0);
    const sent = sendReferral(
      held,
      {
        consent: consentFor(NPI.orthoMn, { writtenMn: true }),
        records: RECORDS,
        at: day(1),
        coordinatorId: 'synthetic-coordinator-1',
      },
      r,
    );
    expect(sent.stage).toBe('sent');
    expect(sent.holds.every((existing) => existing.released !== null)).toBe(true);
  });

  it('surfaces a failed transmission and a destination with no address', () => {
    const busy = sendReferral(
      opened(),
      {
        consent: consentFor(NPI.cardiology),
        records: RECORDS,
        at: day(0),
        coordinatorId: 'synthetic-coordinator-1',
      },
      rails(dir, 'delivered', 'busy'),
    );
    expect(busy.stage).toBe('created');
    expect(busy.holds.at(-1)?.detail).toBe('esp busy');

    const nowhere = sendReferral(
      opened({ destinationNpi: NPI.endocrineNoContact }),
      {
        consent: consentFor(NPI.endocrineNoContact),
        records: RECORDS,
        at: day(0),
        coordinatorId: 'synthetic-coordinator-1',
      },
      rails(dir),
    );
    expect(nowhere.holds.at(-1)?.reason).toBe('send-failed');
    expect(nowhere.disclosures).toHaveLength(0);
  });

  it('returns a referral with no reason to the referrer instead of accepting it', () => {
    const referral = opened({ reason: '  ' });
    expect(referral.holds.at(-1)?.reason).toBe('missing-information');
    expect(referral.notices.at(-1)?.detail).toContain('reason for referral is required');
    expect(codeOf(() => send(referral))).toBe('HOLD_ACTIVE');
  });

  it('refuses a destination that the pinned directory lists as inactive', () => {
    expect(codeOf(() => opened({ destinationNpi: NPI.retiredNeurology }))).toBe(
      'DESTINATION_INACTIVE',
    );
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  detectPhi,
  Reviews,
  wp044ReviewInviteSource,
  type InviteRequest,
  type PhiClass,
  type ReviewsError,
} from './reviews.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));

const base = {
  tenantId: 'northwind-synthetic',
  visitRef: 'visit:nwind-0001',
  locationRef: 'location:nwind-01',
  providerRef: 'provider:nwind-01',
} as const;

const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as ReviewsError).code;
  }
};

describe('WP-073 sentiment-blind reviews', () => {
  it('sends an invite for every eligible visit and none for an ineligible one', () => {
    const reviews = new Reviews();
    const sent = reviews.planInvite({ ...base, inviteRef: 'invite:nwind-send1', eligible: true });
    const skipped = reviews.planInvite({
      ...base,
      inviteRef: 'invite:nwind-skip1',
      eligible: false,
    });
    expect(sent?.sent).toBe(true);
    expect(sent?.sourcePackageId).toBe('WP-044');
    expect(skipped).toBeNull();
  });

  it('REQ-REP-001 AC2: identical eligible fixtures give identical invites whatever sentiment or gating is attached', () => {
    const request: InviteRequest = { ...base, inviteRef: 'invite:nwind-same1', eligible: true };
    const expected = new Reviews().planInvite(request);
    const attachments: readonly Record<string, unknown>[] = [
      { sentimentScore: 100 },
      { sentimentScore: 1 },
      { sentimentScore: null },
      { sentimentScore: 101 },
      { sentimentScore: -1 },
      { sentimentScore: 3.5 },
      { sentimentScore: 'hostile' },
      { gate: 'sentiment-at-least', threshold: 4, sentimentScore: 1 },
      { complaintOpen: true, satisfaction: 0, predictedSentiment: 'negative' },
    ];
    for (const attachment of attachments) {
      const reviews = new Reviews();
      const withSentiment = { ...request, ...attachment } as InviteRequest;
      expect(reviews.planInvite(withSentiment), JSON.stringify(attachment)).toEqual(expected);
    }
  });

  it('offers no sentiment or gating field on the invite request type (REQ-REP-005 AC2)', () => {
    const reviews = new Reviews();
    const invite = reviews.planInvite({
      ...base,
      inviteRef: 'invite:nwind-type1',
      eligible: true,
      // @ts-expect-error sentiment is not part of the invite decision API
      sentimentScore: 5,
    });
    expect(invite?.sent).toBe(true);
    const gated: InviteRequest = {
      ...base,
      inviteRef: 'invite:nwind-type2',
      eligible: false,
      // @ts-expect-error there is no gate to configure
      gate: 'sentiment-at-least',
    };
    expect(reviews.planInvite(gated)).toBeNull();
  });

  it('keeps attribution on a clean public reply', () => {
    const reviews = new Reviews();
    reviews.planInvite({ ...base, inviteRef: 'invite:nwind-0001', eligible: true });
    reviews.submitResponse({
      tenantId: base.tenantId,
      responseRef: 'response:nwind-0001',
      inviteRef: 'invite:nwind-0001',
      text: 'Thank you for the visit',
    });
    const published = reviews.approveResponse({
      tenantId: base.tenantId,
      responseRef: 'response:nwind-0001',
      approvedBy: 'staff:practice-manager-synthetic',
      approvedAt: '2026-09-25T15:00:00Z',
    });
    expect(published).toMatchObject({
      visitRef: base.visitRef,
      locationRef: base.locationRef,
      providerRef: base.providerRef,
    });
  });

  it('names the WP-044 review-invite source placeholder', () => {
    const fixture = JSON.parse(
      readFileSync(`${root}modules/reviews/fixtures/WP-044.placeholder.json`, 'utf8'),
    ) as Wp044Fixture;
    expect(fixture.packageId).toBe('WP-044');
    expect(fixture.standsFor).toBe('review-invite source');
    expect(wp044ReviewInviteSource).toEqual(fixture);
  });
});

describe('WP-073 rework 1: PHI never reaches a public reply', () => {
  const phiCases: readonly (readonly [PhiClass, string])[] = [
    ['ssn', 'My SSN is 219-09-9999'],
    ['ssn', 'SSN 219099999'],
    ['phone', 'call me at (702) 555-0142'],
    ['phone', 'text 702.555.0142 anytime'],
    ['phone', 'reach me on 7025550142'],
    ['email', 'write to jane.roe@example.test'],
    ['date', 'I was seen on 03/14/2026'],
    ['date', 'appointment 2026-03-14 went long'],
    ['date', 'my visit on March 14th'],
    ['record-identifier', 'my MRN is on the form'],
    ['record-identifier', 'quote my medical record please'],
    ['birth-date', 'date of birth 1950-02-01'],
    ['birth-date', 'DOB on file is wrong'],
    ['person-name', 'Patient Jane Roe was unhappy'],
    ['person-name', 'Dr. Smith explained everything'],
    ['person-name', 'my name is Jane'],
    ['clinical-term', 'they handled my diabetes well'],
    ['clinical-term', 'my metformin refill was late'],
    ['clinical-term', 'the diagnosis was explained clearly'],
  ];

  for (const [phiClass, text] of phiCases) {
    it(`holds a ${phiClass} reply privately: "${text}"`, () => {
      expect(detectPhi(text)).toContain(phiClass);
      const reviews = new Reviews();
      reviews.planInvite({ ...base, inviteRef: 'invite:nwind-phi01', eligible: true });
      expect(
        code(() =>
          reviews.submitResponse({
            tenantId: base.tenantId,
            responseRef: 'response:nwind-phi01',
            inviteRef: 'invite:nwind-phi01',
            text,
          }),
        ),
      ).toBe('PHI_BLOCKED');
      expect(reviews.publicReplies()).toEqual([]);
      expect(reviews.privateHolds()).toMatchObject([
        { text, phiClasses: expect.arrayContaining([phiClass]) },
      ]);
    });
  }

  it('blocks every text the review reproduced', () => {
    for (const text of [
      'Jane Roe was seen on 03/14/2026 for her diabetes and metformin refill',
      'Patient Jane Roe, date of birth 1950-02-01',
      'call me at (702) 555-0142',
      'SSN 219099999',
    ]) {
      expect(detectPhi(text), text).not.toEqual([]);
    }
  });

  it('publishes ordinary replies without PHI', () => {
    for (const text of [
      'Thank you for the visit',
      'We take all feedback seriously and encourage you to contact us directly.',
      'Thanks for sharing your experience with our team',
    ]) {
      expect(detectPhi(text), text).toEqual([]);
    }
  });
});

describe('WP-073 rework 1: a response reference is used once per tenant', () => {
  const setup = (): Reviews => {
    const reviews = new Reviews();
    reviews.planInvite({ ...base, inviteRef: 'invite:nwind-dup01', eligible: true });
    return reviews;
  };
  const submit = (reviews: Reviews, text: string, responseRef = 'response:nwind-dup01') =>
    reviews.submitResponse({
      tenantId: base.tenantId,
      responseRef,
      inviteRef: 'invite:nwind-dup01',
      text,
    });

  it('makes an identical resubmission idempotent', () => {
    const reviews = setup();
    const first = submit(reviews, 'first');
    expect(submit(reviews, 'first')).toBe(first);
    expect(reviews.pendingReplies()).toHaveLength(1);
    expect(reviews.publicReplies()).toEqual([]);
  });

  it('refuses a divergent resubmission of a published reference', () => {
    const reviews = setup();
    submit(reviews, 'first');
    expect(code(() => submit(reviews, 'second'))).toBe('RESPONSE_CONFLICT');
    expect(reviews.pendingReplies().map((reply) => reply.text)).toEqual(['first']);
  });

  it('never lets a held reference become public, and does not duplicate the hold', () => {
    const reviews = setup();
    expect(code(() => submit(reviews, 'my MRN is 12'))).toBe('PHI_BLOCKED');
    expect(code(() => submit(reviews, 'my MRN is 12'))).toBe('PHI_BLOCKED');
    expect(code(() => submit(reviews, 'clean text now'))).toBe('RESPONSE_CONFLICT');
    expect(reviews.privateHolds()).toHaveLength(1);
    expect(reviews.publicReplies()).toEqual([]);
  });

  it('keeps the same reference apart across tenants', () => {
    const reviews = setup();
    reviews.planInvite({
      ...base,
      tenantId: 'riverbend-synthetic',
      inviteRef: 'invite:nwind-dup01',
      eligible: true,
    });
    submit(reviews, 'first');
    reviews.submitResponse({
      tenantId: 'riverbend-synthetic',
      responseRef: 'response:nwind-dup01',
      inviteRef: 'invite:nwind-dup01',
      text: 'other tenant',
    });
    expect(reviews.pendingReplies()).toHaveLength(2);
  });
});

interface Wp044Fixture {
  readonly synthetic: true;
  readonly packageId: 'WP-044';
  readonly placeholder: true;
  readonly standsFor: 'review-invite source';
  readonly sourceRef: 'placeholder:wp-044-review-invite-source';
}

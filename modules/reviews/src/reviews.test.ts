import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { Reviews, wp044ReviewInviteSource, type ReviewsError } from './reviews.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));

const base = {
  tenantId: 'northwind-synthetic',
  visitRef: 'visit:nwind-0001',
  locationRef: 'location:nwind-01',
  providerRef: 'provider:nwind-01',
} as const;

describe('WP-073 sentiment-blind reviews', () => {
  it('sends an invite for a low score and a high score when the visit is eligible', () => {
    const reviews = new Reviews();
    const low = reviews.planInvite({
      ...base,
      gate: 'none',
      inviteRef: 'invite:nwind-low01',
      eligible: true,
      sentimentScore: 1,
    });
    const high = reviews.planInvite({
      ...base,
      gate: 'none',
      inviteRef: 'invite:nwind-high1',
      eligible: true,
      sentimentScore: 100,
    });
    const skipped = reviews.planInvite({
      ...base,
      gate: 'none',
      inviteRef: 'invite:nwind-skip1',
      eligible: false,
      sentimentScore: 100,
    });
    expect(low?.sent).toBe(true);
    expect(high?.sent).toBe(true);
    expect(low?.sourcePackageId).toBe('WP-044');
    expect(skipped).toBeNull();
  });

  it('denies an illegal sentiment gate even when the score would pass it', () => {
    const reviews = new Reviews();
    expect(() =>
      reviews.planInvite({
        ...base,
        gate: 'sentiment-at-least',
        threshold: 4,
        inviteRef: 'invite:nwind-gate1',
        eligible: true,
        sentimentScore: 5,
      }),
    ).toThrow(expect.objectContaining({ code: 'GATING_DENIED' } satisfies Partial<ReviewsError>));
    expect(reviews.publicReplies()).toEqual([]);
  });

  it('blocks a PHI response from the public reply list and keeps attribution on a clean reply', () => {
    const reviews = new Reviews();
    reviews.planInvite({
      ...base,
      gate: 'none',
      inviteRef: 'invite:nwind-0001',
      eligible: true,
      sentimentScore: null,
    });
    const published = reviews.submitResponse({
      tenantId: base.tenantId,
      responseRef: 'response:nwind-0001',
      inviteRef: 'invite:nwind-0001',
      text: 'Thank you for the visit',
    });
    expect(published).toMatchObject({
      visitRef: base.visitRef,
      locationRef: base.locationRef,
      providerRef: base.providerRef,
    });
    expect(() =>
      reviews.submitResponse({
        tenantId: base.tenantId,
        responseRef: 'response:nwind-phi1',
        inviteRef: 'invite:nwind-0001',
        text: 'My SSN is 219-09-9999',
      }),
    ).toThrow(expect.objectContaining({ code: 'PHI_BLOCKED' } satisfies Partial<ReviewsError>));
    expect(reviews.publicReplies().map((reply) => reply.text)).toEqual(['Thank you for the visit']);
    expect(reviews.privateHolds().map((hold) => hold.text)).toEqual(['My SSN is 219-09-9999']);
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

interface Wp044Fixture {
  readonly synthetic: true;
  readonly packageId: 'WP-044';
  readonly placeholder: true;
  readonly standsFor: 'review-invite source';
  readonly sourceRef: 'placeholder:wp-044-review-invite-source';
}

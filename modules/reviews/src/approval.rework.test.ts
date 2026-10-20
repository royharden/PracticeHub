/**
 * WP-073 targeted fix (decision-targeted-fix.md): public replies publish only
 * after a recorded human approval. The first describe block uses only the
 * attempt-2 API (planInvite, submitResponse, publicReplies), so it runs
 * unchanged against candidates/D57-WP-073-a2 and fails there.
 */
import { describe, expect, it } from 'vitest';

import { Reviews, type ReviewsError } from './reviews.js';

const base = {
  tenantId: 'northwind-synthetic',
  visitRef: 'visit:nwind-0001',
  locationRef: 'location:nwind-01',
  providerRef: 'provider:nwind-01',
} as const;

/** The pass-2 reviewer's Q3 texts: untitled names, unlisted diagnoses and medications. */
const reviewerExamples = [
  'Thanks Jane Roe for coming in',
  'Great care for my asthma',
  'Glad the Lipitor switch helped',
  'Hope your hypertension is better, Robert',
] as const;

const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as ReviewsError).code;
  }
};

function withInvite(): Reviews {
  const reviews = new Reviews();
  reviews.planInvite({ ...base, inviteRef: 'invite:nwind-appr1', eligible: true });
  return reviews;
}

const submit = (reviews: Reviews, text: string, n: number) => {
  try {
    reviews.submitResponse({
      tenantId: base.tenantId,
      responseRef: `response:nwind-appr${String(n).padStart(2, '0')}`,
      inviteRef: 'invite:nwind-appr1',
      text,
    });
  } catch {
    // A PHI hold is also "not published"; the assertion below is what matters.
  }
};

describe('WP-073 targeted fix: no reply publishes without a recorded human approval', () => {
  it('an unapproved reply never publishes, including the reviewer PHI examples', () => {
    const reviews = withInvite();
    [...reviewerExamples, 'Thank you for the visit'].forEach((text, index) => {
      submit(reviews, text, index);
    });
    expect(reviews.publicReplies()).toEqual([]);
  });
});

describe('WP-073 targeted fix: the approval path', () => {
  it('queues the reviewer examples for a human decision, flagging nothing automatically as public', () => {
    const reviews = withInvite();
    reviewerExamples.forEach((text, index) => {
      submit(reviews, text, index);
    });
    expect(reviews.pendingReplies().map((reply) => reply.text)).toEqual([...reviewerExamples]);
    expect(reviews.pendingReplies().every((reply) => reply.status === 'pending-approval')).toBe(
      true,
    );
  });

  it('publishes only after approval, recording who approved and when', () => {
    const reviews = withInvite();
    submit(reviews, 'Thank you for the visit', 1);
    expect(reviews.publicReplies()).toEqual([]);
    const published = reviews.approveResponse({
      tenantId: base.tenantId,
      responseRef: 'response:nwind-appr01',
      approvedBy: 'staff:practice-manager-synthetic',
      approvedAt: '2026-09-25T15:00:00Z',
    });
    expect(published).toMatchObject({
      status: 'published',
      approvedBy: 'staff:practice-manager-synthetic',
      approvedAt: '2026-09-25T15:00:00Z',
    });
    expect(reviews.publicReplies()).toEqual([published]);
    expect(reviews.pendingReplies()).toEqual([]);
  });

  it('refuses an approval with no approver or no parseable time', () => {
    const reviews = withInvite();
    submit(reviews, 'Thank you for the visit', 1);
    for (const approval of [
      { approvedBy: ' ', approvedAt: '2026-09-25T15:00:00Z' },
      { approvedBy: 'staff:pm', approvedAt: 'today' },
      { approvedBy: 'staff:pm', approvedAt: '2026-09-25' },
    ]) {
      expect(
        code(() =>
          reviews.approveResponse({
            tenantId: base.tenantId,
            responseRef: 'response:nwind-appr01',
            ...approval,
          }),
        ),
      ).toBe('APPROVAL_INVALID');
    }
    expect(reviews.publicReplies()).toEqual([]);
  });

  it('never approves a reply the PHI pre-screen held', () => {
    const reviews = withInvite();
    submit(reviews, 'my MRN is 12', 1);
    expect(
      code(() =>
        reviews.approveResponse({
          tenantId: base.tenantId,
          responseRef: 'response:nwind-appr01',
          approvedBy: 'staff:pm',
          approvedAt: '2026-09-25T15:00:00Z',
        }),
      ),
    ).toBe('PHI_BLOCKED');
    expect(reviews.publicReplies()).toEqual([]);
  });

  it('makes a repeated identical approval idempotent and refuses a different one', () => {
    const reviews = withInvite();
    submit(reviews, 'Thank you for the visit', 1);
    const approval = {
      tenantId: base.tenantId,
      responseRef: 'response:nwind-appr01',
      approvedBy: 'staff:pm',
      approvedAt: '2026-09-25T15:00:00Z',
    };
    const first = reviews.approveResponse(approval);
    expect(reviews.approveResponse(approval)).toBe(first);
    expect(code(() => reviews.approveResponse({ ...approval, approvedBy: 'staff:other' }))).toBe(
      'RESPONSE_CONFLICT',
    );
    expect(reviews.publicReplies()).toHaveLength(1);
  });
});

const inviteRefPattern = /^invite:[a-z0-9][a-z0-9-]{7,63}$/;
const responseRefPattern = /^response:[a-z0-9][a-z0-9-]{7,63}$/;
const visitRefPattern = /^visit:[a-z0-9][a-z0-9-]{7,63}$/;
const locationRefPattern = /^location:[a-z0-9][a-z0-9-]{7,63}$/;
const providerRefPattern = /^provider:[a-z0-9][a-z0-9-]{7,63}$/;

const phiPatterns = [
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b\d{3}-\d{3}-\d{4}\b/,
  /\bMRN\b/i,
  /\bDOB\b/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];

export interface Wp044ReviewInviteSource {
  readonly synthetic: true;
  readonly packageId: 'WP-044';
  readonly placeholder: true;
  readonly standsFor: 'review-invite source';
  readonly sourceRef: 'placeholder:wp-044-review-invite-source';
}

export const wp044ReviewInviteSource: Wp044ReviewInviteSource = {
  synthetic: true,
  packageId: 'WP-044',
  placeholder: true,
  standsFor: 'review-invite source',
  sourceRef: 'placeholder:wp-044-review-invite-source',
};

export class ReviewsError extends Error {
  public constructor(
    public readonly code: 'REVIEW_INVALID' | 'GATING_DENIED' | 'PHI_BLOCKED' | 'INVITE_UNKNOWN',
  ) {
    super(code);
    this.name = 'ReviewsError';
  }
}

export interface ReviewAttribution {
  readonly visitRef: string;
  readonly locationRef: string;
  readonly providerRef: string;
}

export interface ReviewInvite extends ReviewAttribution {
  readonly tenantId: string;
  readonly inviteRef: string;
  readonly sent: true;
  readonly sourcePackageId: 'WP-044';
  readonly sourceRef: Wp044ReviewInviteSource['sourceRef'];
}

export interface PublicReview extends ReviewAttribution {
  readonly tenantId: string;
  readonly responseRef: string;
  readonly inviteRef: string;
  readonly text: string;
}

export interface PrivateReviewHold {
  readonly tenantId: string;
  readonly responseRef: string;
  readonly inviteRef: string;
  readonly text: string;
}

interface InviteRequestBase extends ReviewAttribution {
  readonly tenantId: string;
  readonly inviteRef: string;
  readonly eligible: boolean;
  readonly sentimentScore: number | null;
}

export type InviteRequest =
  | (InviteRequestBase & { readonly gate: 'none' })
  | (InviteRequestBase & { readonly gate: 'sentiment-at-least'; readonly threshold: number });

const discardSentiment = (score: number | null): void => {
  if (score !== null && (!Number.isSafeInteger(score) || score < 0 || score > 100)) {
    throw new ReviewsError('REVIEW_INVALID');
  }
};

const assertAttribution = (input: ReviewAttribution): void => {
  if (
    !visitRefPattern.test(input.visitRef) ||
    !locationRefPattern.test(input.locationRef) ||
    !providerRefPattern.test(input.providerRef)
  ) {
    throw new ReviewsError('REVIEW_INVALID');
  }
};

export const containsPhi = (text: string): boolean =>
  phiPatterns.some((pattern) => pattern.test(text));

export class Reviews {
  readonly #invites = new Map<string, ReviewInvite>();
  readonly #publicReplies: PublicReview[] = [];
  readonly #privateHolds: PrivateReviewHold[] = [];

  public planInvite(input: InviteRequest): ReviewInvite | null {
    if (input.gate === 'sentiment-at-least') throw new ReviewsError('GATING_DENIED');
    discardSentiment(input.sentimentScore);
    assertAttribution(input);
    if (input.tenantId === '' || !inviteRefPattern.test(input.inviteRef)) {
      throw new ReviewsError('REVIEW_INVALID');
    }
    if (!input.eligible) return null;
    const invite = Object.freeze({
      tenantId: input.tenantId,
      inviteRef: input.inviteRef,
      visitRef: input.visitRef,
      locationRef: input.locationRef,
      providerRef: input.providerRef,
      sent: true as const,
      sourcePackageId: wp044ReviewInviteSource.packageId,
      sourceRef: wp044ReviewInviteSource.sourceRef,
    });
    const key = JSON.stringify([input.tenantId, input.inviteRef]);
    const prior = this.#invites.get(key);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(invite)) {
      throw new ReviewsError('REVIEW_INVALID');
    }
    this.#invites.set(key, invite);
    return invite;
  }

  public submitResponse(input: {
    readonly tenantId: string;
    readonly responseRef: string;
    readonly inviteRef: string;
    readonly text: string;
  }): PublicReview {
    if (!responseRefPattern.test(input.responseRef) || input.text === '') {
      throw new ReviewsError('REVIEW_INVALID');
    }
    const invite = this.#invites.get(JSON.stringify([input.tenantId, input.inviteRef]));
    if (invite === undefined) throw new ReviewsError('INVITE_UNKNOWN');
    if (containsPhi(input.text)) {
      this.#privateHolds.push(
        Object.freeze({
          tenantId: input.tenantId,
          responseRef: input.responseRef,
          inviteRef: input.inviteRef,
          text: input.text,
        }),
      );
      throw new ReviewsError('PHI_BLOCKED');
    }
    const stored = Object.freeze({
      tenantId: input.tenantId,
      responseRef: input.responseRef,
      inviteRef: input.inviteRef,
      text: input.text,
      visitRef: invite.visitRef,
      locationRef: invite.locationRef,
      providerRef: invite.providerRef,
    });
    this.#publicReplies.push(stored);
    return stored;
  }

  public publicReplies(): readonly PublicReview[] {
    return Object.freeze([...this.#publicReplies]);
  }

  public privateHolds(): readonly PrivateReviewHold[] {
    return Object.freeze([...this.#privateHolds]);
  }
}

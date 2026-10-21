const inviteRefPattern = /^invite:[a-z0-9][a-z0-9-]{7,63}$/;
const responseRefPattern = /^response:[a-z0-9][a-z0-9-]{7,63}$/;
const visitRefPattern = /^visit:[a-z0-9][a-z0-9-]{7,63}$/;
const locationRefPattern = /^location:[a-z0-9][a-z0-9-]{7,63}$/;
const providerRefPattern = /^provider:[a-z0-9][a-z0-9-]{7,63}$/;

/**
 * PHI classes a public reply must never carry (REQ-REP-003, REQ-REP-006).
 * Detection fails closed: a false positive only moves a reply to the private
 * hold, never onto the public platform.
 */
export type PhiClass =
  | 'ssn'
  | 'phone'
  | 'email'
  | 'date'
  | 'record-identifier'
  | 'birth-date'
  | 'person-name'
  | 'clinical-term';

const monthNames =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

const clinicalTerms = [
  'diagnos\\w*',
  'prescri\\w*',
  'medication\\w*',
  'dosage',
  'dose',
  'refill\\w*',
  'surgery',
  'biopsy',
  'chemo\\w*',
  'lab results?',
  'test results?',
  'blood (?:pressure|work|test)',
  'a1c',
  'cholesterol',
  'diabet\\w*',
  'cancer',
  'tumou?r',
  'hiv',
  'hepatitis',
  'depress\\w*',
  'anxiety',
  'pregnan\\w*',
  'std',
  'sti',
  'metformin',
  'insulin',
  'ozempic',
  'wegovy',
  'mounjaro',
  'zepbound',
  'semaglutide',
  'tirzepatide',
  'glp-?1',
  'testosterone',
  'statins?',
  'lisinopril',
  'atorvastatin',
  'thyroid',
  'hormone therapy',
  'mammogram',
  'colonoscopy',
];

const phiPatterns: readonly (readonly [PhiClass, RegExp])[] = [
  ['ssn', /\b\d{3}[-\s.]?\d{2}[-\s.]?\d{4}\b/],
  ['phone', /(?:\(\d{3}\)\s*|\b\d{3}[-\s.])\d{3}[-\s.]\d{4}\b/],
  ['phone', /\b\d{10}\b/],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['date', /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/],
  ['date', /\b\d{4}-\d{2}-\d{2}\b/],
  ['date', new RegExp(`\\b(?:${monthNames})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'i')],
  ['date', new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${monthNames})\\b`, 'i')],
  ['record-identifier', /\b(?:MRN|medical record|chart (?:number|no\.?)|member id|patient id)\b/i],
  ['birth-date', /\b(?:DOB|date of birth|born on|birthday)\b/i],
  ['person-name', /\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Doctor|Nurse|Patient)\.?\s+[A-Z][a-z]+/],
  ['person-name', /\bmy name is\s+[A-Za-z]+/i],
  ['clinical-term', new RegExp(`\\b(?:${clinicalTerms.join('|')})\\b`, 'i')],
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
    public readonly code:
      | 'REVIEW_INVALID'
      | 'PHI_BLOCKED'
      | 'INVITE_UNKNOWN'
      | 'RESPONSE_CONFLICT'
      | 'APPROVAL_INVALID',
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
  readonly status: 'published';
  readonly tenantId: string;
  readonly responseRef: string;
  readonly inviteRef: string;
  readonly text: string;
  /** The human who approved publication, and when. There is no publish without both. */
  readonly approvedBy: string;
  readonly approvedAt: string;
}

/** A reply that passed the PHI pre-screen and waits for a recorded human approval. */
export interface PendingReply extends ReviewAttribution {
  readonly status: 'pending-approval';
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
  readonly phiClasses: readonly PhiClass[];
}

/**
 * The invite decision takes objective inputs only. There is no sentiment,
 * satisfaction, complaint or gating field (REQ-REP-005): whatever else a
 * caller attaches to the object is never read.
 */
export interface InviteRequest extends ReviewAttribution {
  readonly tenantId: string;
  readonly inviteRef: string;
  /** Objective eligibility decided upstream from visit completion, consent and frequency cap. */
  readonly eligible: boolean;
}

const assertAttribution = (input: ReviewAttribution): void => {
  if (
    !visitRefPattern.test(input.visitRef) ||
    !locationRefPattern.test(input.locationRef) ||
    !providerRefPattern.test(input.providerRef)
  ) {
    throw new ReviewsError('REVIEW_INVALID');
  }
};

/** Every PHI class found in the text, in detection order, without duplicates. */
export const detectPhi = (text: string): readonly PhiClass[] => [
  ...new Set(phiPatterns.filter(([, pattern]) => pattern.test(text)).map(([phiClass]) => phiClass)),
];

export const containsPhi = (text: string): boolean => detectPhi(text).length > 0;

type StoredResponse =
  | { readonly kind: 'pending'; readonly record: PendingReply }
  | { readonly kind: 'public'; readonly record: PublicReview }
  | { readonly kind: 'hold'; readonly record: PrivateReviewHold };

const approvalInstant =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export class Reviews {
  readonly #invites = new Map<string, ReviewInvite>();
  readonly #responses = new Map<string, StoredResponse>();
  readonly #publicReplies: PublicReview[] = [];
  readonly #privateHolds: PrivateReviewHold[] = [];

  public planInvite(input: InviteRequest): ReviewInvite | null {
    // Read only the objective fields; nothing else on the object is consulted.
    const { tenantId, inviteRef, eligible, visitRef, locationRef, providerRef } = input;
    assertAttribution({ visitRef, locationRef, providerRef });
    if (tenantId === '' || !inviteRefPattern.test(inviteRef) || typeof eligible !== 'boolean') {
      throw new ReviewsError('REVIEW_INVALID');
    }
    if (!eligible) return null;
    const invite: ReviewInvite = Object.freeze({
      tenantId,
      inviteRef,
      visitRef,
      locationRef,
      providerRef,
      sent: true as const,
      sourcePackageId: wp044ReviewInviteSource.packageId,
      sourceRef: wp044ReviewInviteSource.sourceRef,
    });
    const key = JSON.stringify([tenantId, inviteRef]);
    const prior = this.#invites.get(key);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(invite)) {
      throw new ReviewsError('REVIEW_INVALID');
    }
    this.#invites.set(key, invite);
    return invite;
  }

  /**
   * Submit a reply. Nothing publishes here: a reply the PHI pre-screen flags is
   * held privately, and every other reply waits for `approveResponse`. A
   * response reference is used once per tenant: an identical resubmission
   * returns the same outcome, a divergent one is refused.
   */
  public submitResponse(input: {
    readonly tenantId: string;
    readonly responseRef: string;
    readonly inviteRef: string;
    readonly text: string;
  }): PendingReply | PublicReview {
    if (!responseRefPattern.test(input.responseRef) || input.text === '') {
      throw new ReviewsError('REVIEW_INVALID');
    }
    const invite = this.#invites.get(JSON.stringify([input.tenantId, input.inviteRef]));
    if (invite === undefined) throw new ReviewsError('INVITE_UNKNOWN');
    const responseKey = JSON.stringify([input.tenantId, input.responseRef]);
    const prior = this.#responses.get(responseKey);
    if (prior !== undefined) {
      if (prior.record.inviteRef !== input.inviteRef || prior.record.text !== input.text) {
        throw new ReviewsError('RESPONSE_CONFLICT');
      }
      if (prior.kind === 'hold') throw new ReviewsError('PHI_BLOCKED');
      return prior.record;
    }
    const phiClasses = detectPhi(input.text);
    if (phiClasses.length > 0) {
      const held: PrivateReviewHold = Object.freeze({
        tenantId: input.tenantId,
        responseRef: input.responseRef,
        inviteRef: input.inviteRef,
        text: input.text,
        phiClasses,
      });
      this.#responses.set(responseKey, { kind: 'hold', record: held });
      this.#privateHolds.push(held);
      throw new ReviewsError('PHI_BLOCKED');
    }
    const pending: PendingReply = Object.freeze({
      status: 'pending-approval' as const,
      tenantId: input.tenantId,
      responseRef: input.responseRef,
      inviteRef: input.inviteRef,
      text: input.text,
      visitRef: invite.visitRef,
      locationRef: invite.locationRef,
      providerRef: invite.providerRef,
    });
    this.#responses.set(responseKey, { kind: 'pending', record: pending });
    return pending;
  }

  /**
   * The only publish path: a named human approves a pending reply at a
   * recorded instant. A held (PHI-flagged) reply can never be approved.
   */
  public approveResponse(input: {
    readonly tenantId: string;
    readonly responseRef: string;
    readonly approvedBy: string;
    readonly approvedAt: string;
  }): PublicReview {
    if (
      input.approvedBy.trim() === '' ||
      !approvalInstant.test(input.approvedAt) ||
      Number.isNaN(Date.parse(input.approvedAt))
    ) {
      throw new ReviewsError('APPROVAL_INVALID');
    }
    const responseKey = JSON.stringify([input.tenantId, input.responseRef]);
    const prior = this.#responses.get(responseKey);
    if (prior === undefined) throw new ReviewsError('REVIEW_INVALID');
    if (prior.kind === 'hold') throw new ReviewsError('PHI_BLOCKED');
    if (prior.kind === 'public') {
      if (
        prior.record.approvedBy !== input.approvedBy ||
        prior.record.approvedAt !== input.approvedAt
      ) {
        throw new ReviewsError('RESPONSE_CONFLICT');
      }
      return prior.record;
    }
    const published: PublicReview = Object.freeze({
      ...prior.record,
      status: 'published' as const,
      approvedBy: input.approvedBy,
      approvedAt: input.approvedAt,
    });
    this.#responses.set(responseKey, { kind: 'public', record: published });
    this.#publicReplies.push(published);
    return published;
  }

  /** Replies that passed the pre-screen and still wait for a human approval. */
  public pendingReplies(): readonly PendingReply[] {
    return Object.freeze(
      [...this.#responses.values()].flatMap((stored) =>
        stored.kind === 'pending' ? [stored.record] : [],
      ),
    );
  }

  public publicReplies(): readonly PublicReview[] {
    return Object.freeze([...this.#publicReplies]);
  }

  public privateHolds(): readonly PrivateReviewHold[] {
    return Object.freeze([...this.#privateHolds]);
  }
}

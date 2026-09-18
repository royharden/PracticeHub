export type MembershipStatus = 'active' | 'paused' | 'cancelled';

export type MembershipEventType = 'opened' | 'paused' | 'resumed' | 'cancelled' | 'winback';

export interface MembershipVintage {
  readonly tenantId: string;
  readonly vintageId: string;
  readonly accountId: string;
  readonly offerRef: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
}

export interface MembershipAccount {
  readonly tenantId: string;
  readonly accountId: string;
  readonly memberRef: string;
  readonly status: MembershipStatus;
  readonly currentVintageId: string | null;
}

export interface MembershipLifecycleEvent {
  readonly tenantId: string;
  readonly eventId: string;
  readonly eventType: MembershipEventType;
  readonly accountId: string;
  readonly vintageId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
}

export interface EntitlementCyclePort {
  grantForVintage(input: {
    readonly tenantId: string;
    readonly memberRef: string;
    readonly vintageId: string;
    readonly componentRefs: readonly string[];
    readonly authorityJournalId: string;
  }): void;
  reverseForVintage(input: {
    readonly tenantId: string;
    readonly memberRef: string;
    readonly vintageId: string;
    readonly authorityJournalId: string;
  }): void;
}

export type MembershipErrorCode =
  | 'ACCOUNT_EXISTS'
  | 'ACCOUNT_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EVENT_ID_CONFLICT'
  | 'PAUSE_REQUIRES_ACTIVE'
  | 'RESUME_REQUIRES_PAUSED'
  | 'CANCEL_REQUIRES_OPEN'
  | 'WINBACK_REQUIRES_CANCELLED'
  | 'PRICE_INVALID';

export class MembershipError extends Error {
  public constructor(public readonly code: MembershipErrorCode) {
    super(code);
    this.name = 'MembershipError';
  }
}

export type Channel = 'sms' | 'email' | 'voice';

export interface EquivalentOption {
  readonly optionId: string;
  readonly slotRef: string;
  readonly label: string;
}

export interface Offer {
  readonly offerId: string;
  readonly slotRef: string;
  readonly expiresAt: string;
  readonly channel: Channel;
}

export class SchRehearsalError extends Error {
  public constructor(
    public readonly code:
      'EMPTY_OPTIONS' | 'UNKNOWN_CHANNEL' | 'EXPIRED_OFFER' | 'NO_SAME_DAY' | 'DUPLICATE_SLOT',
  ) {
    super(code);
    this.name = 'SchRehearsalError';
  }
}

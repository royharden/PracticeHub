export const wp018CanSendDoubleV1 = {
  contract: 'practicehub.wp018-cansend-double',
  version: 1 as const,
  parity: 'versioned-double' as const,
};

export type CanSendState = 'opted_in' | 'opted_out' | 'pending' | 'expired' | 'blocked';

export interface CanSendDecision {
  readonly allow: boolean;
  readonly reason: string;
}

export function canSend(input: {
  readonly channel: 'sms' | 'voice' | 'ai_voice' | 'email' | 'fax' | 'portal';
  readonly state: { readonly currentState: CanSendState } | null;
  readonly ledgerAvailable: boolean;
}): CanSendDecision {
  if (input.channel !== 'ai_voice') {
    return { allow: false, reason: 'wrong-channel' };
  }
  if (input.ledgerAvailable !== true) {
    return { allow: false, reason: 'ledger-unavailable' };
  }
  if (input.state === null) {
    return { allow: false, reason: 'no-consent-on-record' };
  }
  if (input.state.currentState !== 'opted_in') {
    return { allow: false, reason: input.state.currentState };
  }
  return { allow: true, reason: 'allowed' };
}

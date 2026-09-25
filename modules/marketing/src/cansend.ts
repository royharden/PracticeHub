import { canSend as consentCanSend } from '@practicehub/consent';
import type { CanSendInput, ConsentDecision } from '@practicehub/consent';

export interface MarketingSendDecision {
  readonly allow: boolean;
  readonly reason: 'purpose-not-marketing' | ConsentDecision['reason'];
  readonly consent: ConsentDecision | null;
}

/** Marketing sends are purpose-gated before the frozen WP-018 canSend. */
export function canSend(input: CanSendInput): MarketingSendDecision {
  if (input.purpose !== 'marketing') {
    return { allow: false, reason: 'purpose-not-marketing', consent: null };
  }
  const consent = consentCanSend(input);
  return { allow: consent.allow, reason: consent.reason, consent };
}

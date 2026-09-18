import { canSend, type CanSendState } from './bindings/wp018-cansend-double-v1.js';
import { VoiceAgentError, type Direction } from './contracts.js';

export interface SponsorOutboundPolicy {
  readonly recorded: boolean;
  readonly decision: 'blocked' | 'enabled';
  readonly policyTask: string;
}

export const defaultSponsorPolicy: SponsorOutboundPolicy = {
  recorded: false,
  decision: 'blocked',
  policyTask: 'human-owned-outbound-ai-voice-policy',
};

export function assertOutboundAllowed(
  direction: Direction,
  policy: SponsorOutboundPolicy,
  consent: { readonly currentState: CanSendState } | null,
  ledgerAvailable: boolean,
): void {
  if (direction !== 'outbound') {
    return;
  }
  if (policy.recorded !== true || policy.decision !== 'enabled') {
    throw new VoiceAgentError('OUTBOUND_PLATFORM_BLOCKED', policy.policyTask);
  }
  const decision = canSend({ channel: 'ai_voice', state: consent, ledgerAvailable });
  if (decision.allow !== true) {
    throw new VoiceAgentError('OUTBOUND_AI_VOICE_BLOCKED', decision.reason);
  }
}

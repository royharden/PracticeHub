import { CertError } from './contracts.js';

export const wp047VoiceAiAgentDoubleV1 = {
  contract: 'practicehub.wp047-voice-ai-agent-double',
  version: 1 as const,
  parity: 'versioned-double' as const,
};

export interface DoubleSession {
  emergencyTransferred: boolean;
  advise911: boolean;
  qaRequired: boolean;
  qaReviewed: boolean;
  killSwitch: boolean;
  outboundBlocked: boolean;
  clinicalToolBlocked: boolean;
}

export function startInbound(): DoubleSession {
  return {
    emergencyTransferred: false,
    advise911: false,
    qaRequired: false,
    qaReviewed: false,
    killSwitch: false,
    outboundBlocked: false,
    clinicalToolBlocked: false,
  };
}

export function bargeInLifeThreat(session: DoubleSession, text: string): DoubleSession {
  if (session.killSwitch) {
    throw new CertError('KILL_SWITCH_ENGAGED', text);
  }
  if (/\b(911|chest pain|not breathing)\b/i.test(text)) {
    return { ...session, emergencyTransferred: true, advise911: true, qaRequired: true };
  }
  return session;
}

export function tryOutboundWithoutConsent(): DoubleSession {
  return {
    emergencyTransferred: false,
    advise911: false,
    qaRequired: false,
    qaReviewed: false,
    killSwitch: false,
    outboundBlocked: true,
    clinicalToolBlocked: false,
  };
}

export function tryClinicalTool(session: DoubleSession): DoubleSession {
  if (session.killSwitch) {
    throw new CertError('KILL_SWITCH_ENGAGED', 'diagnose');
  }
  return { ...session, clinicalToolBlocked: true };
}

export function engageKillSwitch(session: DoubleSession): DoubleSession {
  return { ...session, killSwitch: true };
}

export function completeQa(session: DoubleSession): DoubleSession {
  if (session.qaRequired !== true) {
    throw new CertError('QA_NOT_REQUIRED', 'unexpected');
  }
  return { ...session, qaReviewed: true };
}

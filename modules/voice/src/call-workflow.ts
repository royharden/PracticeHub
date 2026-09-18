import type { LegalHoldRegistryDouble, LocationPolicyDouble } from './ports.js';
import { decideRecording } from './recording-consent.js';
import type { CallSession, VoiceParty } from './types.js';
import { VoiceError, requireSynthetic } from './types.js';

export function openCall(input: {
  readonly tenantId: string;
  readonly callId: string;
  readonly direction: CallSession['direction'];
  readonly synthetic: boolean;
}): CallSession {
  requireSynthetic(input.synthetic);
  if (input.tenantId.trim() === '' || input.callId.trim() === '') {
    throw new VoiceError('tenantId and callId are required');
  }
  return {
    tenantId: input.tenantId,
    callId: input.callId,
    direction: input.direction,
    state: 'ringing',
    recording: null,
    workItemId: null,
    contextPackageRef: null,
    synthetic: true,
  };
}

export function answerCall(session: CallSession): CallSession {
  if (session.state !== 'ringing') {
    throw new VoiceError('only a ringing call can be answered');
  }
  return { ...session, state: 'in-progress' };
}

export function applyRecordingDecision(
  session: CallSession,
  input: {
    readonly parties: readonly VoiceParty[];
    readonly recordingBytesPresent: boolean;
    readonly location: LocationPolicyDouble;
    readonly jurisdiction: string;
    readonly legalHoldRegistry: LegalHoldRegistryDouble;
  },
): CallSession {
  if (session.state !== 'in-progress' && session.state !== 'voicemail') {
    throw new VoiceError('recording decisions apply to an in-progress or voicemail call');
  }
  const recording = decideRecording({
    tenantId: session.tenantId,
    callId: session.callId,
    parties: input.parties,
    recordingBytesPresent: input.recordingBytesPresent,
    location: input.location,
    jurisdiction: input.jurisdiction,
    legalHoldRegistry: input.legalHoldRegistry,
    synthetic: true,
  });
  return { ...session, recording };
}

export function sendToVoicemail(session: CallSession): CallSession {
  if (session.state !== 'ringing' && session.state !== 'in-progress') {
    throw new VoiceError('voicemail is only reachable from ringing or in-progress');
  }
  return { ...session, state: 'voicemail' };
}

export function completeCall(session: CallSession): CallSession {
  if (session.state === 'completed') {
    throw new VoiceError('call is already completed');
  }
  return { ...session, state: 'completed' };
}

export function failOpenToCallback(session: CallSession, workItemId: string): CallSession {
  if (session.state === 'completed') {
    throw new VoiceError('a completed call cannot fail open');
  }
  if (workItemId.trim() === '') {
    throw new VoiceError('callback WorkItem id is required');
  }
  return {
    ...session,
    state: 'failed-open-to-callback',
    workItemId,
  };
}

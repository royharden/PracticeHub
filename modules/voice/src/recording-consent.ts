import type { LocationPolicyDouble } from './ports.js';
import type { RecordingDecision, VoiceParty } from './types.js';
import { VoiceError, requireSynthetic } from './types.js';

function everyGranted(parties: readonly VoiceParty[]): boolean {
  return parties.length > 0 && parties.every((party) => party.consent === 'granted');
}

function anyUncertain(parties: readonly VoiceParty[]): boolean {
  return parties.some((party) => party.consent === 'uncertain' || party.consent === 'missing');
}

export function decideRecording(input: {
  readonly tenantId: string;
  readonly callId: string;
  readonly parties: readonly VoiceParty[];
  readonly recordingBytesPresent: boolean;
  readonly location: LocationPolicyDouble;
  readonly jurisdiction: string;
  readonly legalHoldRegistry: { hasHold(callId: string): boolean };
  readonly synthetic: boolean;
}): RecordingDecision {
  requireSynthetic(input.synthetic);
  if (input.tenantId.trim() === '' || input.callId.trim() === '') {
    throw new VoiceError('tenantId and callId are required');
  }
  if (input.parties.length === 0) {
    throw new VoiceError('at least one live party is required');
  }

  const resolved = input.location.recordingRule({
    tenantId: input.tenantId,
    jurisdiction: input.jurisdiction,
  });
  if (resolved.rule !== 'all-party') {
    throw new VoiceError('recording-consent floor is all-party and cannot relax');
  }
  const legalHold = input.legalHoldRegistry.hasHold(input.callId);

  if (input.recordingBytesPresent && anyUncertain(input.parties)) {
    return {
      tenantId: input.tenantId,
      callId: input.callId,
      rule: 'all-party',
      parties: input.parties,
      recordingBytesPresent: true,
      legalHold,
      outcome: 'hold-human-verify',
      workflowPermitted: true,
      transcriptPermitted: false,
      playbackPermitted: false,
      synthetic: true,
    };
  }

  if (input.recordingBytesPresent && !everyGranted(input.parties)) {
    if (legalHold) {
      return {
        tenantId: input.tenantId,
        callId: input.callId,
        rule: 'all-party',
        parties: input.parties,
        recordingBytesPresent: true,
        legalHold: true,
        outcome: 'legal-hold-retain',
        workflowPermitted: true,
        transcriptPermitted: false,
        playbackPermitted: false,
        synthetic: true,
      };
    }
    return {
      tenantId: input.tenantId,
      callId: input.callId,
      rule: 'all-party',
      parties: input.parties,
      recordingBytesPresent: true,
      legalHold: false,
      outcome: 'quarantined',
      workflowPermitted: true,
      transcriptPermitted: false,
      playbackPermitted: false,
      synthetic: true,
    };
  }

  if (!everyGranted(input.parties)) {
    return {
      tenantId: input.tenantId,
      callId: input.callId,
      rule: 'all-party',
      parties: input.parties,
      recordingBytesPresent: false,
      legalHold,
      outcome: 'unrecorded-service',
      workflowPermitted: true,
      transcriptPermitted: false,
      playbackPermitted: false,
      synthetic: true,
    };
  }

  return {
    tenantId: input.tenantId,
    callId: input.callId,
    rule: 'all-party',
    parties: input.parties,
    recordingBytesPresent: input.recordingBytesPresent,
    legalHold,
    outcome: 'recording-permitted',
    workflowPermitted: true,
    transcriptPermitted: true,
    playbackPermitted: true,
    synthetic: true,
  };
}

export function schedulePurge(decision: RecordingDecision): RecordingDecision {
  if (decision.outcome !== 'quarantined') {
    throw new VoiceError('purge is only scheduled from quarantine after hold check');
  }
  if (decision.legalHold) {
    return { ...decision, outcome: 'legal-hold-retain', playbackPermitted: false };
  }
  return {
    ...decision,
    outcome: 'purge-required',
    playbackPermitted: false,
    transcriptPermitted: false,
  };
}

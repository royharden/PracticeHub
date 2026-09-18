import type { RecordingDecision } from './types.js';
import { VoiceError } from './types.js';

export function playRecording(decision: RecordingDecision): { readonly played: true } {
  if (!decision.playbackPermitted) {
    throw new VoiceError('playback blocked: recording is quarantined or not permitted');
  }
  return { played: true };
}

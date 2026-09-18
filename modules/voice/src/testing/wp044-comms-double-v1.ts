import type { CommsThreadDouble } from '../ports.js';

export function wp044CommsDoubleV1(): CommsThreadDouble {
  return {
    doubleId: 'wp044-comms-double/v1',
    openVoiceShell(input) {
      return { threadId: `thread:voice:${input.callId}` };
    },
  };
}

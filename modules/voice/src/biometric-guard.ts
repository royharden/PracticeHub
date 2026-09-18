import { VoiceError } from './types.js';

export type BiometricAttempt = 'voiceprint' | 'speaker-embedding' | 'biometric-enrollment';

export function refuseBiometricEnrollment(attempt: BiometricAttempt): never {
  throw new VoiceError(
    `voice stack refuses ${attempt}: no-voiceprint / no-embedding default (R6-SR-090 / BIPA)`,
  );
}

import { describe, expect, it } from 'vitest';

import { refuseBiometricEnrollment } from './biometric-guard.js';
import { VoiceError } from './types.js';

describe('WP-046 compliance: no-voiceprint / no-embedding (R6-SR-090 / BIPA)', () => {
  it.each(['voiceprint', 'speaker-embedding', 'biometric-enrollment'] as const)(
    'fails closed on %s',
    (attempt) => {
      expect(() => refuseBiometricEnrollment(attempt)).toThrow(VoiceError);
      expect(() => refuseBiometricEnrollment(attempt)).toThrow(/no-voiceprint/);
    },
  );
});

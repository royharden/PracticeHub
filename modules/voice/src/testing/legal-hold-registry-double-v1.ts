import type { LegalHoldRegistryDouble } from '../ports.js';

export function legalHoldRegistryDoubleV1(
  heldCallIds: readonly string[] = [],
): LegalHoldRegistryDouble {
  const held = new Set(heldCallIds);
  return {
    doubleId: 'legal-hold-registry-double/v1',
    hasHold(callId) {
      return held.has(callId);
    },
  };
}

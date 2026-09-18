import type { UrgencyScreenDouble } from '../ports.js';

export function wp045UrgencyDoubleV1(
  urgency: 'routine' | 'urgent' | 'emergency' = 'routine',
): UrgencyScreenDouble {
  return {
    doubleId: 'wp045-urgency-double/v1',
    screen(input) {
      return {
        urgency,
        workItemId: `wi:voice:${input.callId}`,
      };
    },
  };
}

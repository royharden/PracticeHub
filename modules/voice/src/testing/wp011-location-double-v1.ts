import type { LocationPolicyDouble } from '../ports.js';

export function wp011LocationDoubleV1(counselReviewPending = false): LocationPolicyDouble {
  return {
    doubleId: 'wp011-location-double/v1',
    recordingRule() {
      return { rule: 'all-party', counselReviewPending };
    },
  };
}

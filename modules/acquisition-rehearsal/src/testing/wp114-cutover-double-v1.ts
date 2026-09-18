import { REHEARSAL_PANEL_SIZE } from '../types.js';
import type { CutoverHarnessPort } from '../ports.js';

export function wp114CutoverDoubleV1(failed = false): CutoverHarnessPort {
  return {
    doubleId: 'wp114-cutover-double/v1',
    cutOver(input) {
      if (failed) {
        return { cutOver: Math.max(0, input.imported - 1), failed: true };
      }
      return { cutOver: REHEARSAL_PANEL_SIZE, failed: false };
    },
    restoreAndRekey() {
      return { restored: true, rekeyed: true };
    },
  };
}

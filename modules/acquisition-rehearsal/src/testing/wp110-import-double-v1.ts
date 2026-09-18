import { REHEARSAL_PANEL_SIZE } from '../types.js';
import type { ImportWorkbenchPort } from '../ports.js';

export function wp110ImportWorkbenchDoubleV1(
  imported: number = REHEARSAL_PANEL_SIZE,
): ImportWorkbenchPort {
  return {
    doubleId: 'wp110-import-workbench-double/v1',
    importPanel() {
      return { imported };
    },
  };
}

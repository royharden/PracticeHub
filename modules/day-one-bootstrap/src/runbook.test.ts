import { describe, expect, it } from 'vitest';

import { DayOneError, RUNBOOK_IDENTITY, requiredSurfaces, type SurfaceRecord } from './contracts.js';
import { assertComplete, evaluateRunbook } from './runbook.js';

function ready(surface: SurfaceRecord['surface']): SurfaceRecord {
  return { surface, ready: true, synthetic: true };
}

describe('WP-118 day-one runbook', () => {
  it('passes when every required surface is ready and synthetic', () => {
    const result = evaluateRunbook(requiredSurfaces.map(ready));
    expect(result.identity).toBe(RUNBOOK_IDENTITY);
    expect(result.complete).toBe(true);
    assertComplete(result);
  });

  it('fails closed on a missing surface', () => {
    const result = evaluateRunbook([ready('staff'), ready('hours')]);
    expect(result.complete).toBe(false);
    expect(() => assertComplete(result)).toThrow(DayOneError);
  });

  it('rejects non-synthetic records', () => {
    expect(() =>
      evaluateRunbook([{ surface: 'staff', ready: true, synthetic: true }, { surface: 'fax', ready: true } as SurfaceRecord]),
    ).toThrow(DayOneError);
  });
});

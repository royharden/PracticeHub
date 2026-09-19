import { describe, expect, it } from 'vitest';

import { WaitlistRehearsalError, type ScheduleSnapshot, type WaitlistEntry } from './contracts.js';
import { assertNoLateMutation, rehearse } from './rehearsals.js';

const openSlot: ScheduleSnapshot = { slotId: 's1', bookedPatientId: null, version: 1 };

describe('WP-133 waitlist rehearsals', () => {
  it('offers on a freed slot', () => {
    const entry: WaitlistEntry = {
      patientId: 'p1',
      priority: 2,
      holdExpired: false,
      prerequisitePaused: false,
      synthetic: true,
    };
    const result = rehearse('offer', entry, openSlot);
    expect(result.ok).toBe(true);
    expect(result.priorityPreserved).toBe(true);
  });

  it('late accept after expiry does not mutate schedule', () => {
    const entry: WaitlistEntry = {
      patientId: 'p1',
      priority: 2,
      holdExpired: true,
      prerequisitePaused: false,
      synthetic: true,
    };
    const booked: ScheduleSnapshot = { slotId: 's1', bookedPatientId: 'p9', version: 4 };
    const result = rehearse('late-accept', entry, booked);
    expect(result.ok).toBe(false);
    expect(result.scheduleUnchanged).toBe(true);
    assertNoLateMutation(result);
  });

  it('preserves priority across a prerequisite pause', () => {
    const entry: WaitlistEntry = {
      patientId: 'p1',
      priority: 7,
      holdExpired: false,
      prerequisitePaused: true,
      synthetic: true,
    };
    expect(rehearse('priority-hold', entry, openSlot).priorityPreserved).toBe(true);
  });

  it('rejects non-synthetic entries', () => {
    expect(() =>
      rehearse(
        'offer',
        {
          patientId: 'p1',
          priority: 1,
          holdExpired: false,
          prerequisitePaused: false,
        } as WaitlistEntry,
        openSlot,
      ),
    ).toThrow(WaitlistRehearsalError);
  });
});

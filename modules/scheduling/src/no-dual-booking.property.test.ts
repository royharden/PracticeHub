import { describe, expect, it } from 'vitest';

import { SchedulingService } from './scheduling-service.js';
import { RecordingCapabilityPort } from './testing/recording-capability-port.js';
import { AthenaSchedulingDoubleV1 } from './testing/wp032-athena-scheduling-double-v1.js';
import type { HoldSlotCommand, SlotOffer } from './types.js';

function candidate(index: number, startMinute: number, durationMinutes: number): HoldSlotCommand {
  const start = new Date(Date.UTC(2026, 8, 14, 14, startMinute));
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const offer: SlotOffer = {
    slotId: `slot-${index}`,
    tenantId: 'tenant-1',
    locationId: index % 2 === 0 ? 'east' : 'west',
    providerId: 'provider-shared',
    resourceIds: [`room-${index}`],
    serviceId: 'routine',
    start: start.toISOString(),
    end: end.toISOString(),
    policy: {
      version: 'v1',
      acceptingNewPatients: true,
      capturedAt: '2026-09-12T00:00:00.000Z',
    },
    adapterId: 'wp032-athena-scheduling-double/v1',
    adapterMode: 'synthetic',
    sourceVersion: 1,
  };
  return {
    idempotencyKey: `hold-${index}`,
    offer,
    patientId: `patient-${index}`,
    authority: { mode: 'active', epoch: 1, sourceVersion: 1 },
    prerequisites: { state: 'complete' },
    now: '2026-09-12T00:00:00.000Z',
    holdDurationMinutes: 60,
  };
}

describe('no-dual-booking interval property', () => {
  it('never admits overlapping provider intervals across locations', async () => {
    for (let offset = -29; offset <= 30; offset += 1) {
      const service = new SchedulingService(
        new RecordingCapabilityPort(),
        new AthenaSchedulingDoubleV1(),
      );
      const first = candidate(1, 0, 30);
      await service.holdSlot(first);
      const second = candidate(2, offset, 30);
      const overlaps = Date.parse(second.offer.start) < Date.parse(first.offer.end);
      if (overlaps) {
        await expect(service.holdSlot(second)).rejects.toMatchObject({
          code: 'PROVIDER_CONFLICT',
        });
      } else {
        await expect(service.holdSlot(second)).resolves.toBeDefined();
      }
    }
  });
});

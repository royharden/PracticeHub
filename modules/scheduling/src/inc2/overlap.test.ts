import { describe, expect, it } from 'vitest';

import type { Appointment, CatalogSlot, WaitlistEntry } from '../types.js';
import { searchJointCatalog } from './catalog-search.js';
import { catalogRowToSlot, exceptionRowToException, pauseRowToPause } from './catalog-store.js';
import { Increment2Engine, memoryCatalogPort, memoryConstraintPort } from './engine.js';
import { intervalsOverlap, isVirtualService, travelBufferMinutes } from './overlap.js';
import { WaitlistSequence } from './waitlist-sequence.js';

const policy = {
  version: 'policy-v1',
  acceptingNewPatients: true,
  capturedAt: '2026-09-18T12:00:00.000Z',
} as const;

function slot(overrides: Partial<CatalogSlot> = {}): CatalogSlot {
  return {
    slotId: 'slot-1',
    tenantId: 'tenant-1',
    locationId: 'loc-a',
    providerId: 'provider-1',
    resourceIds: ['room-1'],
    serviceId: 'routine',
    start: '2026-09-18T14:00:00.000Z',
    end: '2026-09-18T14:30:00.000Z',
    policy,
    adapterId: 'wp032-athena-scheduling-double/v1',
    adapterMode: 'synthetic',
    sourceVersion: 1,
    setupMinutes: 10,
    cleanupMinutes: 15,
    outOfService: false,
    ...overrides,
  };
}

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    appointmentId: 'appt-1',
    tenantId: 'tenant-1',
    locationId: 'loc-a',
    providerId: 'provider-1',
    resourceIds: ['room-1'],
    serviceId: 'routine',
    start: '2026-09-18T14:00:00.000Z',
    end: '2026-09-18T14:30:00.000Z',
    patientId: 'patient-1',
    state: 'booked',
    version: 1,
    ...overrides,
  };
}

const bundle = {
  bundleId: 'access',
  version: 2,
  constraints: [],
};

describe('WP-040 increment 3 overlap and follow-on modules', () => {
  it('zeroes travel buffer when either leg is virtual and agrees real-time vs sweep', () => {
    expect(isVirtualService('telehealth-followup')).toBe(true);
    expect(travelBufferMinutes({ serviceId: 'routine' }, { serviceId: 'routine' }, 20)).toBe(20);
    expect(
      travelBufferMinutes({ serviceId: 'telehealth-followup' }, { serviceId: 'routine' }, 20),
    ).toBe(0);
    expect(
      intervalsOverlap(
        slot(),
        slot({ start: '2026-09-18T14:40:00.000Z', end: '2026-09-18T15:10:00.000Z' }),
        20,
      ),
    ).toBe(true);

    const engine = new Increment2Engine(memoryConstraintPort(bundle, null), memoryCatalogPort([]));
    const virtualExisting = [appointment({ serviceId: 'telehealth-followup' })];
    const inPersonNew = slot({
      slotId: 'near',
      locationId: 'loc-b',
      start: '2026-09-18T14:40:00.000Z',
      end: '2026-09-18T15:10:00.000Z',
    });
    const realtime = engine.checkPatientOverlap(virtualExisting, inPersonNew, 20);
    const swept = engine.sweepOverlaps(
      [
        appointment({ serviceId: 'telehealth-followup' }),
        appointment({
          appointmentId: 'appt-2',
          locationId: 'loc-b',
          start: '2026-09-18T14:40:00.000Z',
          end: '2026-09-18T15:10:00.000Z',
        }),
      ],
      20,
    );
    expect(realtime.blocked).toBe(swept.length > 0);
    expect(realtime.blocked).toBe(false);
  });

  it('joint catalog search is all-or-none and offers an alternate location', () => {
    const engine = new Increment2Engine(memoryConstraintPort(bundle, null), memoryCatalogPort([]));
    const candidate = slot();
    const miss = searchJointCatalog({
      locationId: 'loc-a',
      interval: { start: '2026-09-18T00:00:00.000Z', end: '2026-09-19T00:00:00.000Z' },
      slots: [candidate],
      catalog: [
        {
          catalogId: 'c1',
          locationId: 'loc-a',
          resourceId: 'provider-1',
          resourceKind: 'provider',
          setupMinutes: 10,
          cleanupMinutes: 15,
          outOfService: false,
          nearestAlternateLocationId: 'loc-b',
        },
        {
          catalogId: 'c2',
          locationId: 'loc-a',
          resourceId: 'room-1',
          resourceKind: 'room',
          setupMinutes: 10,
          cleanupMinutes: 15,
          outOfService: false,
          nearestAlternateLocationId: 'loc-b',
        },
      ],
      occupied: [
        {
          resourceId: 'room-1',
          start: '2026-09-18T13:50:00.000Z',
          end: '2026-09-18T14:40:00.000Z',
        },
      ],
      required: [
        { kind: 'provider', id: 'provider-1' },
        { kind: 'room', id: 'room-1' },
      ],
      engine,
    });
    expect(miss.committed).toBe(false);
    expect(miss.alternateLocationId).toBe('loc-b');
  });

  it('waitlist sequence writes recallDue and never lockouts', () => {
    const engine = new Increment2Engine(memoryConstraintPort(bundle, null), memoryCatalogPort([]));
    const seq = new WaitlistSequence(engine);
    const waiting: WaitlistEntry = {
      waitlistEntryId: 'wl-2',
      tenantId: 'tenant-1',
      patientId: 'patient-2',
      requestedInterval: { start: '2026-09-18T14:00:00.000Z', end: '2026-09-18T14:30:00.000Z' },
      state: 'waiting',
    };
    seq.handle(
      {
        type: 'slot-freed',
        recall: true,
        patientId: 'patient-2',
        dueAt: '2026-09-18T16:00:00.000Z',
        nowIso: '2026-09-18T14:00:00.000Z',
      },
      [waiting],
      '2026-09-18T15:00:00.000Z',
    );
    expect(engine.recallDue).toEqual([
      { patientId: 'patient-2', dueAt: '2026-09-18T16:00:00.000Z' },
    ]);
    expect(() =>
      seq.handle(
        { type: 'no-show', patientId: 'patient-2', at: '2026-09-18T14:00:00.000Z', lockout: true },
        [],
        '',
      ),
    ).toThrow();
  });

  it('maps 0034-shaped rows without a new migration', () => {
    const mapped = pauseRowToPause({
      tenant_id: 'tenant-1',
      waitlist_entry_id: 'wl-1',
      reason: 'labs',
      owner_ref: 'clinician-1',
      original_priority: 4,
      reevaluation_deadline: '2026-09-19T00:00:00.000Z',
      state: 'restored',
      synthetic: true,
    });
    expect(mapped.state).toBe('restored');
    expect(mapped.originalPriority).toBe(4);
    const slotMapped = catalogRowToSlot(
      {
        tenant_id: 'tenant-1',
        catalog_id: 'c1',
        location_id: 'loc-a',
        resource_id: 'room-2',
        resource_kind: 'room',
        setup_minutes: 5,
        cleanup_minutes: 5,
        out_of_service: false,
        nearest_alternate_location_id: null,
        synthetic: true,
      },
      slot(),
    );
    expect(slotMapped.setupMinutes).toBe(5);
    expect(
      exceptionRowToException({
        tenant_id: 'tenant-1',
        exception_id: 'ex-1',
        rationale: 'ok',
        scope: 'provider-1',
        exception_range: { start: '2026-09-18T14:00:00.000Z', end: '2026-09-18T15:00:00.000Z' },
        impacted_resource_ids: ['provider-1'],
        approved_by: 'pm-1',
        synthetic: true,
      }).approvedBy,
    ).toBe('pm-1');
  });

  it('restoreWaitlist returns restored and interpreter modality failure is not confirmed', () => {
    const engine = new Increment2Engine(memoryConstraintPort(bundle, null), memoryCatalogPort([]));
    engine.pauseWaitlist(
      {
        waitlistEntryId: 'wl-1',
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        requestedInterval: { start: '2026-09-18T14:00:00.000Z', end: '2026-09-18T14:30:00.000Z' },
        state: 'waiting',
      },
      'labs',
      'clinician-1',
      4,
      '2026-09-19T00:00:00.000Z',
    );
    expect(engine.restoreWaitlist('wl-1')?.state).toBe('restored');
    const tasked = engine.attachInterpreter('appt-1', {
      resourceId: 'interp-1',
      qualified: true,
      available: true,
      modalityOk: false,
    });
    expect(tasked.status).toBe('tasked');
  });
});

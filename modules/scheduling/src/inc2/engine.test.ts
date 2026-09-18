import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { Appointment, CatalogSlot, SlotOffer, WaitlistEntry } from '../types.js';
import {
  Increment2Engine,
  Increment2Error,
  memoryCatalogPort,
  memoryConstraintPort,
} from './engine.js';
import { APP_ROLE_WRITE_PATH } from './app-role-write-path.js';

const policy = {
  version: 'policy-v1',
  acceptingNewPatients: true,
  capturedAt: '2026-09-17T12:00:00.000Z',
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

function offer(
  overrides: Partial<SlotOffer> & {
    constraintBundleId?: string;
    constraintBundleVersion?: number;
  } = {},
): SlotOffer & {
  constraintBundleId: string;
  constraintBundleVersion: number;
} {
  return {
    ...slot(),
    constraintBundleId: 'access',
    constraintBundleVersion: 2,
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
  constraints: [
    {
      constraintId: 'hard-lang',
      kind: 'hard' as const,
      dimension: 'language',
      requiredValue: 'es',
    },
    { constraintId: 'soft-time', kind: 'soft' as const, dimension: 'tod', requiredValue: 'am' },
  ],
};

describe('WP-040 increment 2 engine', () => {
  it('REQ-SCH-001: satisfies hard constraints, withdraws on version change, routes missing data', () => {
    const engine = new Increment2Engine(
      memoryConstraintPort(bundle, {
        providerId: 'provider-1',
        bundleId: 'access',
        version: 2,
        values: { language: 'es', tod: 'pm' },
        stale: false,
      }),
      memoryCatalogPort([]),
    );
    expect(engine.evaluateConstraints(offer(), 'tenant-1')).toMatchObject({
      outcome: 'satisfied',
    });
    expect(
      engine.evaluateConstraints(offer({ constraintBundleVersion: 1 }), 'tenant-1').outcome,
    ).toBe('withdrawn');
    const missing = new Increment2Engine(memoryConstraintPort(bundle, null), memoryCatalogPort([]));
    expect(missing.evaluateConstraints(offer(), 'tenant-1').outcome).toBe('human-scheduler');
    const unsatisfied = new Increment2Engine(
      memoryConstraintPort(bundle, {
        providerId: 'provider-1',
        bundleId: 'access',
        version: 2,
        values: { language: 'en', tod: 'pm' },
        stale: false,
      }),
      memoryCatalogPort([]),
    );
    expect(unsatisfied.evaluateConstraints(offer(), 'tenant-1')).toMatchObject({
      outcome: 'unsatisfied',
      failedHard: ['hard-lang'],
    });
  });

  it('REQ-SCH-002 AC3: equivalent options are current catalog slots, never a fake booking', () => {
    const current = slot({
      slotId: 'open-now',
      start: '2026-09-18T16:00:00.000Z',
      end: '2026-09-18T16:30:00.000Z',
    });
    const engine = new Increment2Engine(
      memoryConstraintPort(bundle, null),
      memoryCatalogPort([current, slot({ slotId: 'down', outOfService: true })]),
    );
    const options = engine.equivalentOffers(offer(), 'tenant-1', '2026-09-17T12:00:00.000Z');
    expect(options.map((row) => row.slotId)).toEqual(['open-now']);
  });

  it('REQ-SCH-006: all-or-none resource commit raises an owned task when a resource is missing', () => {
    const engine = new Increment2Engine(memoryConstraintPort(bundle, null), memoryCatalogPort([]));
    const failed = engine.commitLinkedResources(
      [
        { resourceId: 'room-1', resourceType: 'room', required: true, available: true },
        { resourceId: 'interp-1', resourceType: 'interpreter', required: true, available: false },
      ],
      'resource-desk',
      '15m',
    );
    expect(failed.committed).toBe(false);
    expect(failed.task).toMatchObject({ owner: 'resource-desk', state: 'open' });
    const ok = engine.commitLinkedResources(
      [{ resourceId: 'room-1', resourceType: 'room', required: true, available: true }],
      'resource-desk',
      '15m',
    );
    expect(ok.committed).toBe(true);
    expect(ok.receipts).toEqual(['receipt:room-1']);
  });

  it('REQ-SCH-007: transport/setup conflict is detected and exceptions are auditable', () => {
    const engine = new Increment2Engine(memoryConstraintPort(bundle, null), memoryCatalogPort([]));
    const first = slot({
      locationId: 'loc-a',
      start: '2026-09-18T14:00:00.000Z',
      end: '2026-09-18T14:30:00.000Z',
    });
    const second = slot({
      slotId: 'slot-2',
      locationId: 'loc-b',
      start: '2026-09-18T14:35:00.000Z',
      end: '2026-09-18T15:00:00.000Z',
    });
    expect(engine.detectTransportConflict(first, second, 20)).toBe(true);
    const recorded = engine.recordException({
      exceptionId: 'ex-1',
      rationale: 'manager approved travel exception',
      scope: 'provider-1',
      duration: { start: first.start, end: second.end },
      impactedResourceIds: ['provider-1'],
      approvedBy: 'pm-1',
    });
    expect(engine.exceptions).toEqual([recorded]);
  });

  it('REQ-SCH-015: interpreter is a first-class resource and is never confirmed on request alone', () => {
    const engine = new Increment2Engine(memoryConstraintPort(bundle, null), memoryCatalogPort([]));
    const requested = engine.attachInterpreter('appt-1', {
      resourceId: 'interp-1',
      qualified: true,
      available: false,
    });
    expect(requested.status).toBe('tasked');
    expect(engine.interpreterAttachments.get('appt-1')?.status).toBe('requested');
    const confirmed = engine.attachInterpreter('appt-2', {
      resourceId: 'interp-2',
      qualified: true,
      available: true,
    });
    expect(confirmed.status).toBe('confirmed');
  });

  it('REQ-SCH-019: waitlist pause preserves original priority across restore', () => {
    const engine = new Increment2Engine(memoryConstraintPort(bundle, null), memoryCatalogPort([]));
    const entry: WaitlistEntry = {
      waitlistEntryId: 'wl-1',
      tenantId: 'tenant-1',
      patientId: 'patient-1',
      requestedInterval: { start: '2026-09-18T14:00:00.000Z', end: '2026-09-18T14:30:00.000Z' },
      state: 'waiting',
    };
    const paused = engine.pauseWaitlist(
      entry,
      'labs-pending',
      'clinician-1',
      4,
      '2026-09-19T00:00:00.000Z',
    );
    expect(paused.originalPriority).toBe(4);
    const restored = engine.restoreWaitlist('wl-1');
    expect(restored?.originalPriority).toBe(4);
    expect(engine.pauses.size).toBe(0);
  });

  it('REQ-SCH-021: same-day backfill books one ready candidate and never bypasses readiness', () => {
    const engine = new Increment2Engine(memoryConstraintPort(bundle, null), memoryCatalogPort([]));
    const result = engine.sameDayBackfill([
      {
        patientId: 'unready',
        prerequisiteReady: false,
        authorizationReady: true,
        travelReady: true,
        interpreterReady: true,
        equipmentReady: true,
        consentedChannel: true,
        predictedNoShow: false,
        member: true,
        staffPreferred: true,
      },
      {
        patientId: 'ready',
        prerequisiteReady: true,
        authorizationReady: true,
        travelReady: true,
        interpreterReady: true,
        equipmentReady: true,
        consentedChannel: true,
        predictedNoShow: true,
        member: true,
        staffPreferred: true,
      },
    ]);
    expect(result.bookedPatientId).toBe('ready');
    expect(result.declined).toEqual(['unready']);
  });

  it('REQ-SCH-022: a late click after expiry does not mutate the schedule', () => {
    const engine = new Increment2Engine(memoryConstraintPort(bundle, null), memoryCatalogPort([]));
    const late = engine.acceptLateWaitlist({
      authoritativeSlotMoved: true,
      holdExpired: true,
      existingAppointmentId: 'appt-keep',
      waitlistPriority: 3,
    });
    expect(late.mutated).toBe(false);
    expect(late.originalAppointmentId).toBe('appt-keep');
    expect(late.priority).toBe(3);
    expect(late.declineCounted).toBe(false);
  });

  it('REQ-SCH-028: catalog search respects out-of-service and offers alternate locations', () => {
    const engine = new Increment2Engine(
      memoryConstraintPort(bundle, null),
      memoryCatalogPort([
        slot({ slotId: 'here', locationId: 'loc-a' }),
        slot({ slotId: 'down', locationId: 'loc-a', outOfService: true }),
        slot({ slotId: 'other', locationId: 'loc-b' }),
      ]),
    );
    const found = engine.searchCatalog('tenant-1', 'loc-a', {
      start: '2026-09-18T00:00:00.000Z',
      end: '2026-09-19T00:00:00.000Z',
    });
    expect(found.slots.map((row) => row.slotId)).toEqual(['here']);
    expect(found.alternateLocations).toEqual(['loc-b']);
  });

  it('REQ-SCH-031: freed slots offer the next waiting patient and no-show does not lock out', () => {
    const engine = new Increment2Engine(memoryConstraintPort(bundle, null), memoryCatalogPort([]));
    const waiting: WaitlistEntry = {
      waitlistEntryId: 'wl-2',
      tenantId: 'tenant-1',
      patientId: 'patient-2',
      requestedInterval: { start: '2026-09-18T14:00:00.000Z', end: '2026-09-18T14:30:00.000Z' },
      state: 'waiting',
    };
    expect(
      engine.offerFreedSlot([waiting], '2026-09-18T15:00:00.000Z', '2026-09-18T14:00:00.000Z')
        .offered?.waitlistEntryId,
    ).toBe('wl-2');
    engine.recordNoShow('patient-2', '2026-09-18T14:00:00.000Z');
    expect(() => engine.recordNoShow('patient-2', '2026-09-18T14:00:00.000Z', true)).toThrow(
      Increment2Error,
    );
    expect(engine.reverseNoShowIfArrived('patient-2', false)).toBe(true);
    expect(engine.noShowPatterns).toHaveLength(0);
  });

  it('REQ-SCH-038: patient overlap uses travel buffer except on a virtual leg, and sweep catches misses', () => {
    const engine = new Increment2Engine(memoryConstraintPort(bundle, null), memoryCatalogPort([]));
    const existing = [appointment()];
    const nearby = slot({
      slotId: 'near',
      locationId: 'loc-b',
      start: '2026-09-18T14:40:00.000Z',
      end: '2026-09-18T15:10:00.000Z',
    });
    expect(engine.checkPatientOverlap(existing, nearby, 20).blocked).toBe(true);
    const virtual = slot({
      slotId: 'virt',
      serviceId: 'telehealth-followup',
      start: '2026-09-18T14:40:00.000Z',
      end: '2026-09-18T15:10:00.000Z',
    });
    expect(engine.checkPatientOverlap(existing, virtual, 20).blocked).toBe(false);
    const swept = engine.sweepOverlaps(
      [
        appointment(),
        appointment({
          appointmentId: 'appt-2',
          locationId: 'loc-b',
          start: '2026-09-18T14:40:00.000Z',
          end: '2026-09-18T15:10:00.000Z',
        }),
      ],
      20,
    );
    expect(swept).toHaveLength(2);
  });

  it('keeps calibration/WP-032 override out of this increment', () => {
    const engine = new Increment2Engine(memoryConstraintPort(bundle, null), memoryCatalogPort([]));
    expect(() => engine.refuseCalibrationOverride()).toThrow(Increment2Error);
  });

  it('names the app-role write-path grant for NR-074', () => {
    expect(APP_ROLE_WRITE_PATH.grant).toBe('UPDATE');
    expect(APP_ROLE_WRITE_PATH.migration).toContain('0034-scheduling-inc2.sql');
  });

  it('loads increment-2 fixtures that keep the increment-1 corpus keys', () => {
    for (const name of [
      'REQ-SCH-040-INC2.HAPPY.json',
      'REQ-SCH-040-INC2.BOUNDARY.json',
      'REQ-SCH-040-INC2.FAILURE.json',
      'REQ-SCH-040-INC2.RECOVERY.json',
    ]) {
      const body = JSON.parse(
        readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8'),
      ) as { synthetic: boolean; class: string; expected: Record<string, unknown> };
      expect(body.synthetic).toBe(true);
      expect(
        body.expected.appointmentDelta ??
          body.expected.warningDelta ??
          body.expected.providerCallDelta ??
          body.expected.reconciliationDelta,
      ).toBeDefined();
    }
  });
});

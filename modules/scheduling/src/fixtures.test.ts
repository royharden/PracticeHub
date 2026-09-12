import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { SchedulingService } from './scheduling-service.js';
import { RecordingCapabilityPort } from './testing/recording-capability-port.js';
import { RecordingReceiptPort } from './testing/recording-receipt-port.js';
import { AthenaSchedulingDoubleV1 } from './testing/wp032-athena-scheduling-double-v1.js';
import type { HoldSlotCommand } from './types.js';

interface Fixture {
  class: string;
  requirements: string[];
  scenario: string;
  expected: Record<string, unknown>;
  bugClass: string;
}

function command(idempotencyKey = 'fixture-hold'): HoldSlotCommand {
  return {
    idempotencyKey,
    offer: {
      slotId: 'fixture-slot',
      tenantId: 'tenant-1',
      locationId: 'location-1',
      providerId: 'provider-1',
      resourceIds: ['room-1'],
      serviceId: 'routine',
      start: '2026-09-13T14:00:00.000Z',
      end: '2026-09-13T14:30:00.000Z',
      policy: {
        version: 'policy-v1',
        acceptingNewPatients: true,
        capturedAt: '2026-09-12T00:00:00.000Z',
      },
      adapterId: 'wp032-athena-scheduling-double/v1',
      adapterMode: 'synthetic',
      sourceVersion: 1,
    },
    patientId: 'patient-1',
    authority: { mode: 'active', epoch: 1, sourceVersion: 1 },
    prerequisites: { state: 'complete' },
    now: '2026-09-12T00:00:00.000Z',
    holdDurationMinutes: 30,
  };
}

describe('WP-040 executable fixture corpus', () => {
  it('contains exactly the canonical four fixture classes with traceability', async () => {
    const directory = new URL('../fixtures/', import.meta.url);
    const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
    const fixtures = names.map(
      (name) => JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as Fixture,
    );
    expect(new Set(fixtures.map((fixture) => fixture.class))).toEqual(
      new Set(['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY']),
    );
    for (const fixture of fixtures) {
      expect(fixture.requirements.length).toBeGreaterThan(0);
      expect(fixture.scenario).not.toHaveLength(0);
      expect(Object.keys(fixture.expected).length).toBeGreaterThan(0);
      expect(fixture.bugClass).not.toHaveLength(0);
    }

    for (const fixture of fixtures) {
      const provider = new AthenaSchedulingDoubleV1();
      if (fixture.class === 'HAPPY') {
        const service = new SchedulingService(new RecordingCapabilityPort(), provider);
        const held = await service.holdSlot(command());
        await service.commitBooking({
          idempotencyKey: 'fixture-book',
          holdId: held.hold.holdId,
          scope: held.hold,
          expectedSourceVersion: 1,
          authority: { mode: 'active', epoch: 1, sourceVersion: 1 },
          currentPolicy: held.hold.policy,
          now: '2026-09-12T00:05:00.000Z',
        });
        expect(service.appointments.size).toBe(fixture.expected.appointmentDelta);
        expect(provider.calls).toHaveLength(fixture.expected.receiptDelta as number);
      } else if (fixture.class === 'BOUNDARY') {
        const service = new SchedulingService(new RecordingCapabilityPort(), provider);
        const held = await service.holdSlot(command());
        const booked = await service.commitBooking({
          idempotencyKey: 'fixture-book',
          holdId: held.hold.holdId,
          scope: held.hold,
          expectedSourceVersion: 1,
          authority: { mode: 'active', epoch: 1, sourceVersion: 1 },
          currentPolicy: {
            version: 'policy-v2',
            acceptingNewPatients: false,
            capturedAt: '2026-09-12T00:05:00.000Z',
          },
          now: '2026-09-12T00:05:00.000Z',
        });
        expect(booked.warnings).toHaveLength(fixture.expected.warningDelta as number);
      } else if (fixture.class === 'FAILURE') {
        const service = new SchedulingService(
          new RecordingCapabilityPort([{ allowed: true }, { allowed: false }]),
          provider,
        );
        await expect(service.holdSlot(command())).rejects.toMatchObject({
          code: 'CAPABILITY_DENIED',
        });
        expect(provider.attempts).toHaveLength(fixture.expected.providerCallDelta as number);
      } else if (fixture.class === 'RECOVERY') {
        provider.failNextWith('ambiguous');
        const service = new SchedulingService(new RecordingCapabilityPort(), provider);
        await expect(service.holdSlot(command())).rejects.toThrow('synthetic-provider-ambiguous');
        expect(service.reconciliation).toHaveLength(fixture.expected.reconciliationDelta as number);
        const receiptPort = new RecordingReceiptPort();
        const stale = {
          receiptId: 'stale',
          tenantId: 'tenant-1',
          effectIdentity: 'stale-effect',
          adapterId: provider.adapterId,
          adapterMode: provider.adapterMode,
          authorityEpoch: 1,
          sourceVersion: 1,
        };
        receiptPort.ingest(stale, {
          tenantId: 'tenant-1',
          effectIdentity: 'stale-effect',
          authorityEpoch: 1,
          adapterId: provider.adapterId,
          adapterMode: provider.adapterMode,
          currentSourceVersion: 2,
        });
        expect(receiptPort.quarantined).toHaveLength(fixture.expected.quarantineDelta as number);
      }
    }
  });
});

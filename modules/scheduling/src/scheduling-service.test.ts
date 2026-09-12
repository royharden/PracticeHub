import { describe, expect, it } from 'vitest';

import type { SchedulingProviderPort } from './ports.js';
import { SchedulingService } from './scheduling-service.js';
import { SchedulingError, type HoldSlotCommand, type SlotOffer } from './types.js';
import { RecordingCapabilityPort } from './testing/recording-capability-port.js';
import { RecordingAuthorityPort } from './testing/recording-authority-port.js';
import { AthenaSchedulingDoubleV1 } from './testing/wp032-athena-scheduling-double-v1.js';

const policy = {
  version: 'policy-v1',
  acceptingNewPatients: true,
  capturedAt: '2026-09-12T12:00:00.000Z',
} as const;

function offer(overrides: Partial<SlotOffer> = {}): SlotOffer {
  return {
    slotId: 'slot-1',
    tenantId: 'tenant-1',
    locationId: 'location-1',
    providerId: 'provider-1',
    resourceIds: ['room-1', 'device-1'],
    serviceId: 'service-1',
    start: '2026-09-13T14:00:00.000Z',
    end: '2026-09-13T14:30:00.000Z',
    policy,
    adapterId: 'wp032-athena-scheduling-double/v1',
    adapterMode: 'synthetic',
    sourceVersion: 7,
    ...overrides,
  };
}

function holdCommand(overrides: Partial<HoldSlotCommand> = {}): HoldSlotCommand {
  return {
    idempotencyKey: 'hold-key-1',
    offer: offer(),
    patientId: 'patient-1',
    authority: { mode: 'active', epoch: 3, sourceVersion: 7 },
    prerequisites: { state: 'complete' },
    now: '2026-09-12T12:00:00.000Z',
    holdDurationMinutes: 30,
    ...overrides,
  };
}

describe('SchedulingService authority and conflict boundaries', () => {
  it('serializes simultaneous overlapping holds before provider dispatch', async () => {
    const provider = new AthenaSchedulingDoubleV1();
    const service = new SchedulingService(new RecordingCapabilityPort(), provider);
    const outcomes = await Promise.allSettled([
      service.holdSlot(holdCommand({ idempotencyKey: 'race-a' })),
      service.holdSlot(
        holdCommand({
          idempotencyKey: 'race-b',
          patientId: 'patient-2',
          offer: offer({ locationId: 'location-2', resourceIds: ['room-2'] }),
        }),
      ),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect([...service.holds.values()].filter(({ state }) => state === 'live')).toHaveLength(1);
    expect(provider.calls.filter(({ operation }) => operation === 'hold')).toHaveLength(1);
  });

  it('checks the exact tenant/location/provider/resource scope at enqueue and drain', async () => {
    const capability = new RecordingCapabilityPort();
    const service = new SchedulingService(capability, new AthenaSchedulingDoubleV1());

    await service.holdSlot(holdCommand());

    expect(capability.requests).toEqual([
      {
        capability: 'scheduling.booking',
        operation: 'hold-slot',
        phase: 'enqueue',
        scope: offer(),
      },
      {
        capability: 'scheduling.booking',
        operation: 'hold-slot',
        phase: 'drain',
        scope: offer(),
      },
    ]);
  });

  it('scopes identical raw idempotency keys to their tenant', async () => {
    const provider = new AthenaSchedulingDoubleV1();
    const service = new SchedulingService(new RecordingCapabilityPort(), provider);

    const first = await service.holdSlot(holdCommand({ idempotencyKey: 'shared-key' }));
    const second = await service.holdSlot(
      holdCommand({
        idempotencyKey: 'shared-key',
        offer: offer({ tenantId: 'tenant-2' }),
      }),
    );

    expect(first.hold.tenantId).toBe('tenant-1');
    expect(second.hold.tenantId).toBe('tenant-2');
    expect(provider.calls.filter(({ operation }) => operation === 'hold')).toHaveLength(2);
  });

  it('blocks a command revoked at drain before provider effects', async () => {
    const capability = new RecordingCapabilityPort([
      { allowed: true },
      { allowed: false, reason: 'revoked' },
    ]);
    const provider = new AthenaSchedulingDoubleV1();
    const service = new SchedulingService(capability, provider);

    await expect(service.holdSlot(holdCommand())).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
      details: { phase: 'drain' },
    });
    expect(provider.calls).toHaveLength(0);
    expect(service.holds).toHaveLength(0);
  });

  it('re-evaluates authority at drain and blocks mode lowering before provider effects', async () => {
    const provider = new AthenaSchedulingDoubleV1();
    const authority = new RecordingAuthorityPort([
      { mode: 'active', epoch: 3, sourceVersion: 7 },
      { mode: 'retiring', epoch: 3, sourceVersion: 7 },
    ]);
    const service = new SchedulingService(new RecordingCapabilityPort(), provider, authority);
    await expect(service.holdSlot(holdCommand())).rejects.toMatchObject({
      code: 'AUTHORITY_NOT_ACTIVE',
      details: { phase: 'drain', mode: 'retiring' },
    });
    expect(provider.attempts).toHaveLength(0);
  });

  it('re-evaluates authority epoch at drain before provider effects', async () => {
    const provider = new AthenaSchedulingDoubleV1();
    const authority = new RecordingAuthorityPort([
      { mode: 'active', epoch: 3, sourceVersion: 7 },
      { mode: 'active', epoch: 4, sourceVersion: 8 },
    ]);
    const service = new SchedulingService(new RecordingCapabilityPort(), provider, authority);
    await expect(service.holdSlot(holdCommand())).rejects.toMatchObject({
      code: 'AUTHORITY_EPOCH_STALE',
      details: { phase: 'drain', expectedEpoch: 3, observedEpoch: 4 },
    });
    expect(provider.attempts).toHaveLength(0);
  });

  it.each(['shadow', 'read-only', 'retiring'] as const)(
    'prevents %s authority from creating holds',
    async (mode) => {
      const provider = new AthenaSchedulingDoubleV1();
      const service = new SchedulingService(new RecordingCapabilityPort(), provider);
      await expect(
        service.holdSlot(holdCommand({ authority: { mode, epoch: 3, sourceVersion: 7 } })),
      ).rejects.toMatchObject({ code: 'AUTHORITY_NOT_ACTIVE' });
      expect(provider.calls).toHaveLength(0);
    },
  );

  it('validates command time and bounded TTL before provider dispatch', async () => {
    const provider = new AthenaSchedulingDoubleV1();
    const service = new SchedulingService(new RecordingCapabilityPort(), provider);
    await expect(service.holdSlot(holdCommand({ now: 'not-a-time' }))).rejects.toMatchObject({
      code: 'SLOT_NO_LONGER_AVAILABLE',
    });
    await expect(service.holdSlot(holdCommand({ holdDurationMinutes: 0 }))).rejects.toMatchObject({
      code: 'SLOT_NO_LONGER_AVAILABLE',
    });
    expect(provider.attempts).toHaveLength(0);
  });

  it('rejects forged provider receipt provenance before storing a hold', async () => {
    const honest = new AthenaSchedulingDoubleV1();
    const forged: SchedulingProviderPort = {
      adapterId: honest.adapterId,
      adapterMode: honest.adapterMode,
      hold: async () => ({
        receiptId: 'forged',
        tenantId: 'other-tenant',
        effectIdentity: 'other-effect',
        adapterId: 'untrusted',
        adapterMode: 'real',
        authorityEpoch: 99,
        sourceVersion: -1,
      }),
      commit: (request) => honest.commit(request),
      release: (request) => honest.release(request),
      cancel: (request) => honest.cancel(request),
    };
    const service = new SchedulingService(new RecordingCapabilityPort(), forged);
    await expect(service.holdSlot(holdCommand())).rejects.toMatchObject({
      code: 'RECONCILIATION_REQUIRED',
    });
    expect(service.holds).toHaveLength(0);
  });

  it('detects provider conflicts across locations', async () => {
    const service = new SchedulingService(
      new RecordingCapabilityPort(),
      new AthenaSchedulingDoubleV1(),
    );
    await service.holdSlot(holdCommand());

    await expect(
      service.holdSlot(
        holdCommand({
          idempotencyKey: 'hold-key-2',
          patientId: 'patient-2',
          offer: offer({ slotId: 'slot-2', locationId: 'location-2', resourceIds: ['room-2'] }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' });
  });

  it('treats adjacent half-open intervals as non-overlapping', async () => {
    const service = new SchedulingService(
      new RecordingCapabilityPort(),
      new AthenaSchedulingDoubleV1(),
    );
    await service.holdSlot(holdCommand());
    const adjacent = await service.holdSlot(
      holdCommand({
        idempotencyKey: 'hold-key-2',
        patientId: 'patient-2',
        offer: offer({
          slotId: 'slot-2',
          start: '2026-09-13T14:30:00.000Z',
          end: '2026-09-13T15:00:00.000Z',
        }),
      }),
    );
    expect(adjacent.hold.state).toBe('live');
  });

  it('emits the WP-022 obligation without creating a hold', async () => {
    const service = new SchedulingService(
      new RecordingCapabilityPort(),
      new AthenaSchedulingDoubleV1(),
    );
    await expect(
      service.holdSlot(
        holdCommand({ prerequisites: { state: 'needs-verification', reason: 'referral' } }),
      ),
    ).rejects.toMatchObject({ code: 'CLINICAL_PREREQUISITE_UNMET' });
    await expect(
      service.holdSlot(
        holdCommand({ prerequisites: { state: 'needs-verification', reason: 'referral' } }),
      ),
    ).rejects.toMatchObject({ code: 'CLINICAL_PREREQUISITE_UNMET' });
    expect(service.obligations).toEqual([
      {
        obligationId: 'wp022:tenant-1:hold-key-1',
        type: 'WP-022',
        reason: 'needs-verification',
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        ownerRef: 'scheduler-verification',
        state: 'open',
      },
    ]);
    service.takeVerificationObligation('wp022:tenant-1:hold-key-1');
    service.resolveVerificationObligation('wp022:tenant-1:hold-key-1');
    expect(service.obligations[0]?.state).toBe('resolved');
    expect(service.holds).toHaveLength(0);
  });
});

describe('SchedulingService booking lifecycle', () => {
  it('serializes simultaneous conversion of one hold to exactly one appointment', async () => {
    const provider = new AthenaSchedulingDoubleV1();
    const service = new SchedulingService(new RecordingCapabilityPort(), provider);
    const held = await service.holdSlot(holdCommand());
    const base = {
      holdId: held.hold.holdId,
      scope: held.hold,
      expectedSourceVersion: 7,
      authority: { mode: 'active' as const, epoch: 3, sourceVersion: 7 },
      currentPolicy: policy,
      now: '2026-09-12T12:05:00.000Z',
    };
    const outcomes = await Promise.allSettled([
      service.commitBooking({ ...base, idempotencyKey: 'commit-race-a' }),
      service.commitBooking({ ...base, idempotencyKey: 'commit-race-b' }),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(service.appointments).toHaveLength(1);
    expect(provider.calls.filter(({ operation }) => operation === 'commit')).toHaveLength(1);
  });

  it('grandfathers a live hold across policy change and emits an audit warning', async () => {
    const service = new SchedulingService(
      new RecordingCapabilityPort(),
      new AthenaSchedulingDoubleV1(),
    );
    const held = await service.holdSlot(holdCommand());
    const result = await service.commitBooking({
      idempotencyKey: 'book-key-1',
      holdId: held.hold.holdId,
      scope: held.hold,
      expectedSourceVersion: 7,
      authority: { mode: 'active', epoch: 3, sourceVersion: 7 },
      currentPolicy: {
        version: 'policy-v2',
        acceptingNewPatients: false,
        capturedAt: '2026-09-12T12:05:00.000Z',
      },
      now: '2026-09-12T12:05:00.000Z',
    });
    expect(result.appointment.state).toBe('booked');
    expect(result.warnings).toEqual([
      'policy-changed-after-authoritative-hold:policy-v1->policy-v2',
    ]);
  });

  it('supports idempotent replay but rejects key reuse for another command', async () => {
    const service = new SchedulingService(
      new RecordingCapabilityPort(),
      new AthenaSchedulingDoubleV1(),
    );
    const command = holdCommand();
    const first = await service.holdSlot(command);
    const replay = await service.holdSlot(structuredClone(command));
    expect(replay).toEqual(first);
    await expect(
      service.holdSlot({ ...command, patientId: 'different-patient' }),
    ).rejects.toBeInstanceOf(SchedulingError);
    await expect(
      service.holdSlot({ ...command, patientId: 'different-patient' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('keeps protective release available after authority lowering', async () => {
    const provider = new AthenaSchedulingDoubleV1();
    const service = new SchedulingService(new RecordingCapabilityPort(), provider);
    const held = await service.holdSlot(holdCommand());
    const authority = { mode: 'retiring' as const, epoch: 4, sourceVersion: 8 };
    const receipt = await service.releaseHold(
      held.hold.holdId,
      held.hold,
      authority,
      'release-key-1',
    );
    const replay = await service.releaseHold(
      held.hold.holdId,
      held.hold,
      authority,
      'release-key-1',
    );
    expect(receipt.adapterMode).toBe('synthetic');
    expect(replay).toEqual(receipt);
    expect(provider.attempts.filter(({ operation }) => operation === 'release')).toHaveLength(1);
    expect(service.holds.get(held.hold.holdId)?.state).toBe('released');
  });

  it('validates and deduplicates protective callback reconciliation', async () => {
    const service = new SchedulingService(
      new RecordingCapabilityPort(),
      new AthenaSchedulingDoubleV1(),
    );
    const scope = offer();
    const receipt = {
      receiptId: 'callback-1',
      tenantId: 'tenant-1',
      effectIdentity: 'expected-effect',
      adapterId: 'wp032-athena-scheduling-double/v1',
      adapterMode: 'synthetic' as const,
      authorityEpoch: 3,
      sourceVersion: 8,
    };
    const base = {
      receipt,
      expectedEffectIdentity: 'expected-effect',
      expectedAuthorityEpoch: 3,
      currentSourceVersion: 8,
      patientId: 'patient-1',
      scope,
      authority: { mode: 'retiring' as const, epoch: 3, sourceVersion: 8 },
    };
    await expect(
      service.reconcileReceipt({ ...base, idempotencyKey: 'reconcile-1' }),
    ).resolves.toBe('accepted');
    await expect(
      service.reconcileReceipt({ ...base, idempotencyKey: 'reconcile-2' }),
    ).resolves.toBe('duplicate');
    await expect(
      service.reconcileReceipt({
        ...base,
        idempotencyKey: 'reconcile-bad',
        receipt: { ...receipt, receiptId: 'callback-2', effectIdentity: 'wrong-effect' },
      }),
    ).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
  });

  it('records ambiguous provider outcomes for reconciliation', async () => {
    const provider = new AthenaSchedulingDoubleV1();
    provider.failNextWith('ambiguous');
    const service = new SchedulingService(new RecordingCapabilityPort(), provider);
    await expect(service.holdSlot(holdCommand())).rejects.toThrow('synthetic-provider-ambiguous');
    expect(service.reconciliation).toHaveLength(1);
    expect(service.holds).toHaveLength(0);
    await expect(service.holdSlot(holdCommand())).rejects.toMatchObject({
      code: 'RECONCILIATION_REQUIRED',
    });
    await expect(
      service.holdSlot(holdCommand({ idempotencyKey: 'different-key-same-scope' })),
    ).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
    expect(provider.attempts).toHaveLength(1);
  });

  it('preserves the original appointment when waitlist replacement commit fails', async () => {
    const provider = new AthenaSchedulingDoubleV1();
    const service = new SchedulingService(new RecordingCapabilityPort(), provider);
    const originalHold = await service.holdSlot(holdCommand());
    const original = await service.commitBooking({
      idempotencyKey: 'book-original',
      holdId: originalHold.hold.holdId,
      scope: originalHold.hold,
      expectedSourceVersion: 7,
      authority: { mode: 'active', epoch: 3, sourceVersion: 7 },
      currentPolicy: policy,
      now: '2026-09-12T12:05:00.000Z',
    });
    service.addWaitlistEntry({
      waitlistEntryId: 'wait-1',
      tenantId: 'tenant-1',
      patientId: 'patient-1',
      requestedInterval: {
        start: '2026-09-14T14:00:00.000Z',
        end: '2026-09-14T14:30:00.000Z',
      },
      originalAppointmentId: original.appointment.appointmentId,
      originalAppointmentVersion: original.appointment.version,
      offerExpiresAt: '2099-01-01T00:00:00.000Z',
      state: 'offered',
    });
    provider.failNextCommitWith('conflict');

    await expect(
      service.acceptWaitlistReplacement(
        'wait-1',
        holdCommand({
          idempotencyKey: 'replacement-hold',
          offer: offer({
            slotId: 'slot-replacement',
            start: '2026-09-14T14:00:00.000Z',
            end: '2026-09-14T14:30:00.000Z',
          }),
        }),
        {
          idempotencyKey: 'replacement-book',
          holdId: 'resolved-by-service',
          scope: offer({
            slotId: 'slot-replacement',
            start: '2026-09-14T14:00:00.000Z',
            end: '2026-09-14T14:30:00.000Z',
          }),
          expectedSourceVersion: 7,
          authority: { mode: 'active', epoch: 3, sourceVersion: 7 },
          currentPolicy: policy,
          now: '2026-09-12T12:10:00.000Z',
        },
      ),
    ).rejects.toThrow('synthetic-provider-conflict');
    expect(service.appointments.get(original.appointment.appointmentId)?.state).toBe('booked');
    expect(service.waitlist.get('wait-1')?.state).toBe('offered');
    expect(
      [...service.holds.values()].find((candidate) => candidate.slotId === 'slot-replacement')
        ?.state,
    ).toBe('released');
  });

  it('compensates the replacement when cancellation of the original fails', async () => {
    const provider = new AthenaSchedulingDoubleV1();
    const service = new SchedulingService(new RecordingCapabilityPort(), provider);
    const originalHold = await service.holdSlot(holdCommand());
    const original = await service.commitBooking({
      idempotencyKey: 'book-original-compensation',
      holdId: originalHold.hold.holdId,
      scope: originalHold.hold,
      expectedSourceVersion: 7,
      authority: { mode: 'active', epoch: 3, sourceVersion: 7 },
      currentPolicy: policy,
      now: '2026-09-12T12:05:00.000Z',
    });
    service.addWaitlistEntry({
      waitlistEntryId: 'wait-compensation',
      tenantId: 'tenant-1',
      patientId: 'patient-1',
      requestedInterval: {
        start: '2026-09-14T14:00:00.000Z',
        end: '2026-09-14T14:30:00.000Z',
      },
      originalAppointmentId: original.appointment.appointmentId,
      originalAppointmentVersion: original.appointment.version,
      offerExpiresAt: '2099-01-01T00:00:00.000Z',
      state: 'offered',
    });
    const replacementOffer = offer({
      slotId: 'slot-compensation',
      start: '2026-09-14T14:00:00.000Z',
      end: '2026-09-14T14:30:00.000Z',
    });
    const replacementHold = holdCommand({
      idempotencyKey: 'replacement-hold-compensation',
      offer: replacementOffer,
    });
    const replacementCommit = {
      idempotencyKey: 'replacement-book-compensation',
      holdId: 'resolved-by-service',
      scope: replacementOffer,
      expectedSourceVersion: 7,
      authority: { mode: 'active' as const, epoch: 3, sourceVersion: 7 },
      currentPolicy: policy,
      now: '2026-09-12T12:10:00.000Z',
    };
    provider.failNextCancelWith('conflict');

    await expect(
      service.acceptWaitlistReplacement('wait-compensation', replacementHold, replacementCommit),
    ).rejects.toThrow('synthetic-provider-conflict');
    expect(service.appointments.get(original.appointment.appointmentId)?.state).toBe('booked');
    expect(
      [...service.appointments.values()].find(
        (candidate) => candidate.appointmentId !== original.appointment.appointmentId,
      )?.state,
    ).toBe('cancelled');
    expect(service.waitlist.get('wait-compensation')?.state).toBe('offered');
    expect(provider.attempts.filter(({ operation }) => operation === 'cancel')).toHaveLength(2);
    await expect(
      service.acceptWaitlistReplacement('wait-compensation', replacementHold, replacementCommit),
    ).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
    expect(
      [...service.appointments.values()].find(
        (candidate) => candidate.appointmentId !== original.appointment.appointmentId,
      )?.state,
    ).toBe('cancelled');
    expect(provider.attempts.filter(({ operation }) => operation === 'cancel')).toHaveLength(2);
  });

  it('replays a successfully fulfilled waitlist replacement without new provider effects', async () => {
    const provider = new AthenaSchedulingDoubleV1();
    const service = new SchedulingService(new RecordingCapabilityPort(), provider);
    service.addWaitlistEntry({
      waitlistEntryId: 'wait-success-replay',
      tenantId: 'tenant-1',
      patientId: 'patient-1',
      requestedInterval: { start: offer().start, end: offer().end },
      offerExpiresAt: '2099-01-01T00:00:00.000Z',
      state: 'offered',
    });
    const replacementHold = holdCommand({ idempotencyKey: 'replay-hold' });
    const replacementCommit = {
      idempotencyKey: 'replay-book',
      holdId: 'resolved-by-service',
      scope: offer(),
      expectedSourceVersion: 7,
      authority: { mode: 'active' as const, epoch: 3, sourceVersion: 7 },
      currentPolicy: policy,
      now: '2026-09-12T12:10:00.000Z',
    };

    const first = await service.acceptWaitlistReplacement(
      'wait-success-replay',
      replacementHold,
      replacementCommit,
    );
    const second = await service.acceptWaitlistReplacement(
      'wait-success-replay',
      replacementHold,
      replacementCommit,
    );

    expect(second).toEqual(first);
    expect(service.waitlist.get('wait-success-replay')?.state).toBe('fulfilled');
    expect(provider.attempts.filter(({ operation }) => operation === 'hold')).toHaveLength(1);
    expect(provider.attempts.filter(({ operation }) => operation === 'commit')).toHaveLength(1);
  });

  it('rejects withdrawn and cross-identity waitlist replacements before a hold', async () => {
    const provider = new AthenaSchedulingDoubleV1();
    const service = new SchedulingService(new RecordingCapabilityPort(), provider);
    service.addWaitlistEntry({
      waitlistEntryId: 'waiting',
      tenantId: 'tenant-1',
      patientId: 'patient-1',
      requestedInterval: { start: offer().start, end: offer().end },
      state: 'waiting',
    });
    service.addWaitlistEntry({
      waitlistEntryId: 'withdrawn',
      tenantId: 'tenant-1',
      patientId: 'patient-1',
      requestedInterval: { start: offer().start, end: offer().end },
      state: 'withdrawn',
    });
    service.addWaitlistEntry({
      waitlistEntryId: 'other-patient',
      tenantId: 'tenant-1',
      patientId: 'patient-other',
      requestedInterval: { start: offer().start, end: offer().end },
      offerExpiresAt: '2099-01-01T00:00:00.000Z',
      state: 'offered',
    });
    const commit = {
      idempotencyKey: 'replacement-book',
      holdId: 'resolved-by-service',
      scope: offer(),
      expectedSourceVersion: 7,
      authority: { mode: 'active' as const, epoch: 3, sourceVersion: 7 },
      currentPolicy: policy,
      now: '2026-09-12T12:10:00.000Z',
    };
    await expect(
      service.acceptWaitlistReplacement('waiting', holdCommand(), commit),
    ).rejects.toMatchObject({ code: 'SLOT_NO_LONGER_AVAILABLE' });
    await expect(
      service.acceptWaitlistReplacement('withdrawn', holdCommand(), commit),
    ).rejects.toMatchObject({ code: 'SLOT_NO_LONGER_AVAILABLE' });
    await expect(
      service.acceptWaitlistReplacement('other-patient', holdCommand(), commit),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    expect(provider.attempts).toHaveLength(0);
  });

  it('rejects an invalid trusted waitlist clock before provider dispatch', async () => {
    const provider = new AthenaSchedulingDoubleV1();
    const service = new SchedulingService(
      new RecordingCapabilityPort(),
      provider,
      new RecordingAuthorityPort(),
      { now: () => 'not-an-instant' },
    );
    service.addWaitlistEntry({
      waitlistEntryId: 'invalid-clock',
      tenantId: 'tenant-1',
      patientId: 'patient-1',
      requestedInterval: { start: offer().start, end: offer().end },
      offerExpiresAt: '2099-01-01T00:00:00.000Z',
      state: 'offered',
    });

    await expect(
      service.acceptWaitlistReplacement('invalid-clock', holdCommand(), {
        idempotencyKey: 'invalid-clock-book',
        holdId: 'resolved-by-service',
        scope: offer(),
        expectedSourceVersion: 7,
        authority: { mode: 'active', epoch: 3, sourceVersion: 7 },
        currentPolicy: policy,
        now: '2026-09-12T12:10:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'SLOT_NO_LONGER_AVAILABLE' });
    expect(provider.attempts).toHaveLength(0);
  });
});

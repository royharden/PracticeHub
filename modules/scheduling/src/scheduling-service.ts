import type {
  AuthorityRequest,
  SchedulingAuthorityPort,
  SchedulingCapabilityPort,
  SchedulingClock,
  SchedulingProviderPort,
} from './ports.js';
import { ScopedAsyncLock } from './scoped-async-lock.js';
import {
  SchedulingError,
  type Appointment,
  type AuthorityContext,
  type BookingReceipt,
  type CommitBookingCommand,
  type Hold,
  type HoldSlotCommand,
  type PolicySnapshot,
  type SchedulingOperation,
  type SchedulingScope,
  type SlotOffer,
  type TimeInterval,
  type WaitlistEntry,
  type WorkItemObligation,
} from './types.js';

type CommandOutcome<T> =
  | { state: 'complete'; fingerprint: string; result: T }
  | { state: 'indeterminate'; fingerprint: string; effectIdentity: string };

class CommandAuthorityPort implements SchedulingAuthorityPort {
  async evaluate(request: AuthorityRequest): Promise<AuthorityContext> {
    return structuredClone(request.expected);
  }
}

class SystemSchedulingClock implements SchedulingClock {
  now(): string {
    return new Date().toISOString();
  }
}

export interface HoldResult {
  hold: Hold;
  receipt: BookingReceipt;
}

export interface BookingResult {
  appointment: Appointment;
  receipt: BookingReceipt;
  warnings: readonly string[];
}

export interface ReconcileReceiptCommand {
  idempotencyKey: string;
  receipt: BookingReceipt;
  expectedEffectIdentity: string;
  expectedAuthorityEpoch: number;
  currentSourceVersion: number;
  patientId: string;
  scope: SchedulingScope;
  authority: AuthorityContext;
}

export class SchedulingService {
  readonly holds = new Map<string, Hold>();
  readonly appointments = new Map<string, Appointment>();
  readonly waitlist = new Map<string, WaitlistEntry>();
  readonly obligations: WorkItemObligation[] = [];
  readonly reconciliation: Array<{ effectIdentity: string; reason: string }> = [];

  private readonly idempotentResults = new Map<string, CommandOutcome<unknown>>();
  private readonly receiptEffects = new Set<string>();
  private readonly indeterminateScopeKeys = new Set<string>();
  private readonly locks = new ScopedAsyncLock();
  private sequence = 0;

  constructor(
    private readonly capability: SchedulingCapabilityPort,
    private readonly provider: SchedulingProviderPort,
    private readonly authority: SchedulingAuthorityPort = new CommandAuthorityPort(),
    private readonly clock: SchedulingClock = new SystemSchedulingClock(),
  ) {}

  searchAvailability(offers: readonly SlotOffer[], patientId: string): SlotOffer[] {
    return offers.filter((offer) => {
      try {
        this.assertFiniteInterval(offer);
        this.assertNoConflict(offer, patientId);
        return true;
      } catch (error) {
        if (error instanceof SchedulingError) return false;
        throw error;
      }
    });
  }

  async holdSlot(command: HoldSlotCommand): Promise<HoldResult> {
    const snapshot = structuredClone(command);
    this.validateHoldCommand(snapshot);
    return this.locks.run(this.scopeLockKeys(snapshot.offer, snapshot.patientId), () =>
      this.holdSlotLocked(snapshot),
    );
  }

  private async holdSlotLocked(command: HoldSlotCommand): Promise<HoldResult> {
    const fingerprint = JSON.stringify(command);
    const mapKey = this.idempotencyMapKey(command.offer.tenantId, command.idempotencyKey);
    const replay = this.replay<HoldResult>(mapKey, fingerprint);
    if (replay !== undefined) return replay;
    this.assertScopeNotIndeterminate(command.offer, command.patientId);

    this.assertFiniteInterval(command.offer);
    if (!command.offer.policy.acceptingNewPatients) {
      throw new SchedulingError(
        'POLICY_REVALIDATION_REQUIRED',
        'The offer policy does not allow a new patient hold.',
        { policyVersion: command.offer.policy.version },
      );
    }
    if (command.prerequisites.state !== 'complete') {
      if (command.prerequisites.state === 'needs-verification') {
        const obligationId = `wp022:${command.offer.tenantId}:${command.idempotencyKey}`;
        if (!this.obligations.some((obligation) => obligation.obligationId === obligationId)) {
          this.obligations.push({
            obligationId,
            type: 'WP-022',
            reason: 'needs-verification',
            tenantId: command.offer.tenantId,
            patientId: command.patientId,
            ownerRef: 'scheduler-verification',
            state: 'open',
          });
        }
      }
      throw new SchedulingError(
        'CLINICAL_PREREQUISITE_UNMET',
        'Clinical prerequisites are not complete.',
        { state: command.prerequisites.state, reason: command.prerequisites.reason },
      );
    }

    await this.authorize('scheduling.booking', 'hold-slot', command.offer, command.authority, true);
    const observedAt = this.clock.now();
    this.assertStrictInstant(observedAt);
    this.expireHolds(command.offer.tenantId, observedAt);
    this.assertNoConflict(command.offer, command.patientId);
    const effectIdentity = this.effectIdentity('hold-slot', command.offer, command.idempotencyKey);
    let receipt: BookingReceipt;
    try {
      receipt = await this.provider.hold({
        effectIdentity,
        offer: command.offer,
        patientId: command.patientId,
        authorityEpoch: command.authority.epoch,
      });
      this.assertReceipt(receipt, {
        tenantId: command.offer.tenantId,
        effectIdentity,
        authorityEpoch: command.authority.epoch,
        minimumSourceVersion: command.offer.sourceVersion,
      });
    } catch (error) {
      this.recordProviderFailure(
        mapKey,
        fingerprint,
        effectIdentity,
        error,
        command.offer,
        command.patientId,
      );
      throw error;
    }
    this.sequence += 1;
    const hold: Hold = {
      ...command.offer,
      holdId: `hold-${this.sequence}`,
      patientId: command.patientId,
      expiresAt: new Date(
        Date.parse(observedAt) + command.holdDurationMinutes * 60_000,
      ).toISOString(),
      authorityEpoch: command.authority.epoch,
      state: 'live',
    };
    const result = { hold, receipt };
    this.holds.set(hold.holdId, hold);
    this.remember(mapKey, fingerprint, result);
    return structuredClone(result);
  }

  async commitBooking(command: CommitBookingCommand): Promise<BookingResult> {
    const snapshot = structuredClone(command);
    this.validateAuthority(snapshot.authority);
    this.validateScope(snapshot.scope);
    this.assertStrictInstant(snapshot.now);
    if (
      !Number.isSafeInteger(snapshot.expectedSourceVersion) ||
      snapshot.expectedSourceVersion < 0
    ) {
      throw new SchedulingError(
        'SOURCE_VERSION_STALE',
        'Source version must be a nonnegative integer.',
      );
    }
    const hold = this.holds.get(snapshot.holdId);
    const keys = [
      `hold:${snapshot.scope.tenantId}:${snapshot.holdId}`,
      ...this.scopeLockKeys(snapshot.scope, hold?.patientId ?? 'unknown-patient'),
    ];
    return this.locks.run(keys, () => this.commitBookingLocked(snapshot));
  }

  private async commitBookingLocked(command: CommitBookingCommand): Promise<BookingResult> {
    const fingerprint = JSON.stringify(command);
    const mapKey = this.idempotencyMapKey(command.scope.tenantId, command.idempotencyKey);
    const replay = this.replay<BookingResult>(mapKey, fingerprint);
    if (replay !== undefined) return replay;

    const hold = this.holds.get(command.holdId);
    if (hold !== undefined) this.assertScopeNotIndeterminate(command.scope, hold.patientId);
    if (hold === undefined || hold.state !== 'live') {
      throw new SchedulingError('SLOT_NO_LONGER_AVAILABLE', 'The hold is not live.');
    }
    this.assertSameScope(command.scope, hold);
    if (command.authority.epoch !== hold.authorityEpoch) {
      throw new SchedulingError('AUTHORITY_EPOCH_STALE', 'The hold authority epoch is stale.');
    }
    if (command.expectedSourceVersion !== hold.sourceVersion) {
      throw new SchedulingError('SOURCE_VERSION_STALE', 'The expected source version is stale.');
    }
    const observedAt = this.clock.now();
    this.assertStrictInstant(observedAt);
    if (Date.parse(observedAt) >= Date.parse(hold.expiresAt)) {
      hold.state = 'expired';
      throw new SchedulingError('HOLD_EXPIRED', 'The hold has expired.');
    }

    await this.authorize('scheduling.booking', 'commit-booking', hold, command.authority, true);
    const effectIdentity = this.effectIdentity('commit-booking', hold, command.idempotencyKey);
    let receipt: BookingReceipt;
    try {
      receipt = await this.provider.commit({
        effectIdentity,
        holdId: hold.holdId,
        tenantId: hold.tenantId,
        authorityEpoch: command.authority.epoch,
        expectedSourceVersion: command.expectedSourceVersion,
      });
      this.assertReceipt(receipt, {
        tenantId: hold.tenantId,
        effectIdentity,
        authorityEpoch: command.authority.epoch,
        minimumSourceVersion: command.expectedSourceVersion,
      });
    } catch (error) {
      this.recordProviderFailure(mapKey, fingerprint, effectIdentity, error, hold, hold.patientId);
      if (this.isIndeterminateProviderError(error)) hold.state = 'indeterminate';
      throw error;
    }

    this.sequence += 1;
    const appointment: Appointment = {
      appointmentId: `appointment-${this.sequence}`,
      tenantId: hold.tenantId,
      locationId: hold.locationId,
      providerId: hold.providerId,
      resourceIds: [...hold.resourceIds],
      patientId: hold.patientId,
      serviceId: hold.serviceId,
      start: hold.start,
      end: hold.end,
      state: 'booked',
      version: 1,
    };
    const warnings = this.policyWarnings(hold.policy, command.currentPolicy);
    hold.state = 'converted';
    receipt.appointmentId = appointment.appointmentId;
    this.appointments.set(appointment.appointmentId, appointment);
    const result = { appointment, receipt, warnings };
    this.remember(mapKey, fingerprint, result);
    return structuredClone(result);
  }

  async releaseHold(
    holdId: string,
    scope: SchedulingScope,
    authority: AuthorityContext,
    idempotencyKey: string,
  ): Promise<BookingReceipt> {
    const trustedScope = structuredClone(scope);
    this.validateScope(trustedScope);
    this.validateAuthority(authority);
    return this.locks.run(
      [`hold:${trustedScope.tenantId}:${holdId}`, ...this.scopeLockKeys(trustedScope)],
      () => this.releaseHoldLocked(holdId, trustedScope, authority, idempotencyKey),
    );
  }

  private async releaseHoldLocked(
    holdId: string,
    scope: SchedulingScope,
    authority: AuthorityContext,
    idempotencyKey: string,
  ): Promise<BookingReceipt> {
    const fingerprint = JSON.stringify({ holdId, scope, authority, idempotencyKey });
    const mapKey = this.idempotencyMapKey(scope.tenantId, idempotencyKey);
    const replay = this.replay<BookingReceipt>(mapKey, fingerprint);
    if (replay !== undefined) return replay;
    const hold = this.holds.get(holdId);
    if (hold === undefined || hold.state !== 'live') {
      throw new SchedulingError('SLOT_NO_LONGER_AVAILABLE', 'The hold is not live.');
    }
    this.assertSameScope(scope, hold);
    await this.authorize('scheduling.protective', 'release-hold', hold, authority, false);
    const effectIdentity = this.effectIdentity('release-hold', hold, idempotencyKey);
    let receipt: BookingReceipt;
    try {
      receipt = await this.provider.release({
        effectIdentity,
        tenantId: hold.tenantId,
        targetId: holdId,
        authorityEpoch: authority.epoch,
      });
      this.assertReceipt(receipt, {
        tenantId: hold.tenantId,
        effectIdentity,
        authorityEpoch: authority.epoch,
        minimumSourceVersion: 0,
      });
    } catch (error) {
      this.recordProviderFailure(mapKey, fingerprint, effectIdentity, error, hold, hold.patientId);
      throw error;
    }
    hold.state = 'released';
    this.remember(mapKey, fingerprint, receipt);
    return structuredClone(receipt);
  }

  async cancelAppointment(
    appointmentId: string,
    scope: SchedulingScope,
    authority: AuthorityContext,
    idempotencyKey: string,
  ): Promise<BookingReceipt> {
    const trustedScope = structuredClone(scope);
    this.validateScope(trustedScope);
    this.validateAuthority(authority);
    const appointment = this.appointments.get(appointmentId);
    return this.locks.run(
      [
        `appointment:${trustedScope.tenantId}:${appointmentId}`,
        ...this.scopeLockKeys(trustedScope, appointment?.patientId),
      ],
      () => this.cancelAppointmentLocked(appointmentId, trustedScope, authority, idempotencyKey),
    );
  }

  private async cancelAppointmentLocked(
    appointmentId: string,
    scope: SchedulingScope,
    authority: AuthorityContext,
    idempotencyKey: string,
  ): Promise<BookingReceipt> {
    const fingerprint = JSON.stringify({ appointmentId, scope, authority, idempotencyKey });
    const mapKey = this.idempotencyMapKey(scope.tenantId, idempotencyKey);
    const replay = this.replay<BookingReceipt>(mapKey, fingerprint);
    if (replay !== undefined) return replay;
    const appointment = this.appointments.get(appointmentId);
    if (appointment === undefined || appointment.state !== 'booked') {
      throw new SchedulingError('SLOT_NO_LONGER_AVAILABLE', 'The appointment is not booked.');
    }
    this.assertSameScope(scope, appointment);
    await this.authorize(
      'scheduling.protective',
      'cancel-appointment',
      appointment,
      authority,
      false,
    );
    const effectIdentity = this.effectIdentity('cancel-appointment', appointment, idempotencyKey);
    let receipt: BookingReceipt;
    try {
      receipt = await this.provider.cancel({
        effectIdentity,
        tenantId: appointment.tenantId,
        targetId: appointmentId,
        authorityEpoch: authority.epoch,
      });
      this.assertReceipt(receipt, {
        tenantId: appointment.tenantId,
        effectIdentity,
        authorityEpoch: authority.epoch,
        minimumSourceVersion: 0,
      });
    } catch (error) {
      this.recordProviderFailure(
        mapKey,
        fingerprint,
        effectIdentity,
        error,
        appointment,
        appointment.patientId,
      );
      throw error;
    }
    appointment.state = 'cancelled';
    appointment.version += 1;
    receipt.appointmentId = appointmentId;
    this.remember(mapKey, fingerprint, receipt);
    return structuredClone(receipt);
  }

  async reconcileReceipt(
    command: ReconcileReceiptCommand,
  ): Promise<'accepted' | 'duplicate' | 'quarantined'> {
    const fingerprint = JSON.stringify(command);
    const mapKey = this.idempotencyMapKey(command.scope.tenantId, command.idempotencyKey);
    this.validateScope(command.scope);
    this.validateAuthority(command.authority);
    if (
      !Number.isSafeInteger(command.expectedAuthorityEpoch) ||
      command.expectedAuthorityEpoch < 0 ||
      !Number.isSafeInteger(command.currentSourceVersion) ||
      command.currentSourceVersion < 0
    ) {
      throw new SchedulingError(
        'SOURCE_VERSION_STALE',
        'Receipt versions must be nonnegative integers.',
      );
    }
    const replay = this.replay<'accepted' | 'duplicate' | 'quarantined'>(mapKey, fingerprint);
    if (replay !== undefined) return replay;
    await this.authorize(
      'scheduling.protective',
      'reconcile-receipt',
      command.scope,
      command.authority,
      false,
    );
    this.assertReceipt(command.receipt, {
      tenantId: command.scope.tenantId,
      effectIdentity: command.expectedEffectIdentity,
      authorityEpoch: command.expectedAuthorityEpoch,
      minimumSourceVersion: 0,
    });
    if (command.receipt.sourceVersion < command.currentSourceVersion) {
      this.reconciliation.push({
        effectIdentity: command.receipt.effectIdentity,
        reason: 'SOURCE_VERSION_STALE',
      });
      this.remember(mapKey, fingerprint, 'quarantined');
      return 'quarantined';
    }
    if (this.receiptEffects.has(command.receipt.effectIdentity)) {
      this.remember(mapKey, fingerprint, 'duplicate');
      return 'duplicate';
    }
    this.receiptEffects.add(command.receipt.effectIdentity);
    for (const key of this.scopeLockKeys(command.scope, command.patientId)) {
      this.indeterminateScopeKeys.delete(key);
    }
    this.remember(mapKey, fingerprint, 'accepted');
    return 'accepted';
  }

  addWaitlistEntry(entry: WaitlistEntry): void {
    this.assertFiniteInterval(entry.requestedInterval);
    if (entry.state === 'offered') {
      if (entry.offerExpiresAt === undefined) {
        throw new SchedulingError(
          'SLOT_NO_LONGER_AVAILABLE',
          'Offered waitlist entry needs expiry.',
        );
      }
      this.assertStrictInstant(entry.offerExpiresAt);
    }
    if (
      (entry.originalAppointmentId === undefined) !==
      (entry.originalAppointmentVersion === undefined)
    ) {
      throw new SchedulingError(
        'CAPABILITY_DENIED',
        'Waitlist original identity and version must be supplied together.',
      );
    }
    this.waitlist.set(entry.waitlistEntryId, structuredClone(entry));
  }

  takeVerificationObligation(obligationId: string): void {
    const obligation = this.obligations.find(
      (candidate) => candidate.obligationId === obligationId,
    );
    if (obligation === undefined || obligation.state !== 'open') {
      throw new SchedulingError('SLOT_NO_LONGER_AVAILABLE', 'Verification obligation is not open.');
    }
    obligation.state = 'taken';
  }

  resolveVerificationObligation(obligationId: string): void {
    const obligation = this.obligations.find(
      (candidate) => candidate.obligationId === obligationId,
    );
    if (obligation === undefined || obligation.state !== 'taken') {
      throw new SchedulingError(
        'SLOT_NO_LONGER_AVAILABLE',
        'Verification obligation is not taken.',
      );
    }
    obligation.state = 'resolved';
  }

  async acceptWaitlistReplacement(
    waitlistEntryId: string,
    holdCommand: HoldSlotCommand,
    commitCommand: CommitBookingCommand,
  ): Promise<BookingResult> {
    const heldInput = structuredClone(holdCommand);
    const commitInput = structuredClone(commitCommand);
    this.validateHoldCommand(heldInput);
    this.validateScope(commitInput.scope);
    this.validateAuthority(commitInput.authority);
    const sagaFingerprint = JSON.stringify({ waitlistEntryId, heldInput, commitInput });
    const sagaMapKey = this.idempotencyMapKey(
      heldInput.offer.tenantId,
      `waitlist:${waitlistEntryId}:${commitInput.idempotencyKey}`,
    );
    return this.locks.run(
      [
        `waitlist:${heldInput.offer.tenantId}:${waitlistEntryId}`,
        ...this.scopeLockKeys(heldInput.offer, heldInput.patientId),
      ],
      () =>
        this.acceptWaitlistReplacementLocked(
          waitlistEntryId,
          heldInput,
          commitInput,
          sagaMapKey,
          sagaFingerprint,
        ),
    );
  }

  private async acceptWaitlistReplacementLocked(
    waitlistEntryId: string,
    holdCommand: HoldSlotCommand,
    commitCommand: CommitBookingCommand,
    sagaMapKey: string,
    sagaFingerprint: string,
  ): Promise<BookingResult> {
    const replay = this.replay<BookingResult>(sagaMapKey, sagaFingerprint);
    if (replay !== undefined) return replay;
    const entry = this.waitlist.get(waitlistEntryId);
    if (entry === undefined || entry.state !== 'offered') {
      throw new SchedulingError('SLOT_NO_LONGER_AVAILABLE', 'The waitlist entry is not active.');
    }
    const observedAt = this.clock.now();
    this.assertStrictInstant(observedAt);
    if (
      entry.offerExpiresAt === undefined ||
      Date.parse(observedAt) >= Date.parse(entry.offerExpiresAt)
    ) {
      throw new SchedulingError('HOLD_EXPIRED', 'The waitlist offer has expired.');
    }
    if (
      entry.tenantId !== holdCommand.offer.tenantId ||
      entry.patientId !== holdCommand.patientId
    ) {
      throw new SchedulingError(
        'CAPABILITY_DENIED',
        'Waitlist replacement identity does not match the offered booking.',
      );
    }
    const original =
      entry.originalAppointmentId === undefined
        ? undefined
        : this.appointments.get(entry.originalAppointmentId);
    if (
      entry.originalAppointmentId !== undefined &&
      (original === undefined ||
        original.tenantId !== entry.tenantId ||
        original.patientId !== entry.patientId ||
        original.state !== 'booked' ||
        original.version !== entry.originalAppointmentVersion)
    ) {
      throw new SchedulingError(
        'CAPABILITY_DENIED',
        'Waitlist replacement original appointment does not match the entry.',
      );
    }
    if (
      Date.parse(holdCommand.offer.start) < Date.parse(entry.requestedInterval.start) ||
      Date.parse(holdCommand.offer.end) > Date.parse(entry.requestedInterval.end)
    ) {
      throw new SchedulingError(
        'CAPABILITY_DENIED',
        'Replacement offer does not satisfy the waitlist interval.',
      );
    }
    const held = await this.holdSlotLocked(holdCommand);
    let result: BookingResult;
    try {
      result = await this.commitBookingLocked({ ...commitCommand, holdId: held.hold.holdId });
    } catch (error) {
      if (!this.isIndeterminateProviderError(error)) {
        const storedHold = this.holds.get(held.hold.holdId);
        if (storedHold?.state === 'live') storedHold.state = 'released';
      }
      throw error;
    }
    if (original !== undefined) {
      try {
        await this.cancelAppointmentLocked(
          original.appointmentId,
          original,
          commitCommand.authority,
          `${commitCommand.idempotencyKey}:cancel-original`,
        );
      } catch (cancellationError) {
        try {
          await this.cancelAppointmentLocked(
            result.appointment.appointmentId,
            result.appointment,
            commitCommand.authority,
            `${commitCommand.idempotencyKey}:compensate-replacement`,
          );
        } catch (compensationError) {
          this.reconciliation.push({
            effectIdentity: `${entry.tenantId}|${waitlistEntryId}|partial-replacement`,
            reason: `original-cancel:${this.errorMessage(cancellationError)};replacement-compensation:${this.errorMessage(compensationError)}`,
          });
        }
        const compensatedEffectIdentity = `${entry.tenantId}|${waitlistEntryId}|compensated-replacement`;
        this.idempotentResults.set(sagaMapKey, {
          state: 'indeterminate',
          fingerprint: sagaFingerprint,
          effectIdentity: compensatedEffectIdentity,
        });
        this.reconciliation.push({
          effectIdentity: compensatedEffectIdentity,
          reason: `waitlist-replacement-terminal-after-original-cancel:${this.errorMessage(cancellationError)}`,
        });
        throw cancellationError;
      }
      original.state = 'superseded';
      result.appointment.predecessorAppointmentId = original.appointmentId;
      this.appointments.set(result.appointment.appointmentId, result.appointment);
    }
    entry.state = 'fulfilled';
    this.remember(sagaMapKey, sagaFingerprint, result);
    return result;
  }

  private async authorize(
    capability: 'scheduling.booking' | 'scheduling.protective',
    operation: SchedulingOperation,
    scope: SchedulingScope,
    expectedAuthority: AuthorityContext,
    requireActive: boolean,
  ): Promise<void> {
    for (const phase of ['enqueue', 'drain'] as const) {
      const decision = await this.capability.evaluate({ capability, operation, phase, scope });
      if (decision.allowed !== true) {
        throw new SchedulingError('CAPABILITY_DENIED', 'Scheduling capability denied.', {
          phase,
          reason: decision.reason,
        });
      }
      const authority = await this.authority.evaluate({
        operation,
        phase,
        scope,
        expected: expectedAuthority,
      });
      if (requireActive && authority.mode !== 'active') {
        throw new SchedulingError(
          'AUTHORITY_NOT_ACTIVE',
          'Only active scheduling authority may create holds or bookings.',
          { phase, mode: authority.mode },
        );
      }
      if (authority.epoch !== expectedAuthority.epoch) {
        throw new SchedulingError(
          'AUTHORITY_EPOCH_STALE',
          'Authority epoch changed before effect.',
          {
            phase,
            expectedEpoch: expectedAuthority.epoch,
            observedEpoch: authority.epoch,
          },
        );
      }
    }
  }

  private validateHoldCommand(command: HoldSlotCommand): void {
    this.validateScope(command.offer);
    this.validateAuthority(command.authority);
    this.assertStrictInstant(command.now);
    this.assertStrictInstant(command.offer.policy.capturedAt);
    if (
      command.idempotencyKey.trim().length === 0 ||
      command.patientId.trim().length === 0 ||
      command.offer.slotId.trim().length === 0 ||
      command.offer.serviceId.trim().length === 0 ||
      command.offer.policy.version.trim().length === 0 ||
      !Number.isSafeInteger(command.offer.sourceVersion) ||
      command.offer.sourceVersion < 0
    ) {
      throw new SchedulingError(
        'SOURCE_VERSION_STALE',
        'Hold identity and source version are invalid.',
      );
    }
    if (
      !Number.isSafeInteger(command.holdDurationMinutes) ||
      command.holdDurationMinutes <= 0 ||
      command.holdDurationMinutes > 24 * 60
    ) {
      throw new SchedulingError(
        'SLOT_NO_LONGER_AVAILABLE',
        'Hold duration must be a positive whole number no greater than 24 hours.',
      );
    }
  }

  private validateAuthority(authority: AuthorityContext): void {
    if (
      !Number.isSafeInteger(authority.epoch) ||
      authority.epoch < 0 ||
      !Number.isSafeInteger(authority.sourceVersion) ||
      authority.sourceVersion < 0
    ) {
      throw new SchedulingError(
        'AUTHORITY_EPOCH_STALE',
        'Authority versions must be nonnegative integers.',
      );
    }
  }

  private validateScope(scope: SchedulingScope): void {
    const identities = [scope.tenantId, scope.locationId, scope.providerId];
    if (
      identities.some((identity) => identity.trim().length === 0) ||
      scope.resourceIds.length === 0 ||
      scope.resourceIds.some((identity) => identity.trim().length === 0) ||
      new Set(scope.resourceIds).size !== scope.resourceIds.length
    ) {
      throw new SchedulingError(
        'CAPABILITY_DENIED',
        'Scheduling scope is incomplete or ambiguous.',
      );
    }
  }

  private assertSameScope(expected: SchedulingScope, actual: SchedulingScope): void {
    const expectedResources = [...expected.resourceIds].sort();
    const actualResources = [...actual.resourceIds].sort();
    if (
      expected.tenantId !== actual.tenantId ||
      expected.locationId !== actual.locationId ||
      expected.providerId !== actual.providerId ||
      JSON.stringify(expectedResources) !== JSON.stringify(actualResources)
    ) {
      throw new SchedulingError(
        'CAPABILITY_DENIED',
        'Scheduling scope does not match stored state.',
      );
    }
  }

  private scopeLockKeys(scope: SchedulingScope, patientId?: string): string[] {
    return [
      `provider:${scope.tenantId}:${scope.providerId}`,
      ...(patientId === undefined ? [] : [`patient:${scope.tenantId}:${patientId}`]),
      ...scope.resourceIds.map((resourceId) => `resource:${scope.tenantId}:${resourceId}`),
    ];
  }

  private assertNoConflict(interval: SlotOffer, patientId: string): void {
    const active: Array<{
      tenantId: string;
      providerId: string;
      patientId: string;
      resourceIds: readonly string[];
      start: string;
      end: string;
    }> = [
      ...[...this.holds.values()].filter((hold) => hold.state === 'live'),
      ...[...this.appointments.values()].filter((appointment) => appointment.state === 'booked'),
    ];
    for (const candidate of active) {
      if (candidate.tenantId !== interval.tenantId || !this.overlaps(candidate, interval)) continue;
      if (candidate.patientId === patientId) {
        throw new SchedulingError(
          'PATIENT_CONFLICT',
          'Patient already has an overlapping reservation.',
        );
      }
      if (candidate.providerId === interval.providerId) {
        throw new SchedulingError(
          'PROVIDER_CONFLICT',
          'Provider already has an overlapping reservation.',
        );
      }
      if (candidate.resourceIds.some((resourceId) => interval.resourceIds.includes(resourceId))) {
        throw new SchedulingError(
          'RESOURCE_CONFLICT',
          'Resource already has an overlapping reservation.',
        );
      }
    }
  }

  private assertFiniteInterval(interval: TimeInterval): void {
    this.assertStrictInstant(interval.start);
    this.assertStrictInstant(interval.end);
    const start = Date.parse(interval.start);
    const end = Date.parse(interval.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new SchedulingError(
        'SLOT_NO_LONGER_AVAILABLE',
        'Interval must be finite and nonempty.',
      );
    }
  }

  private assertStrictInstant(value: string): void {
    const parsed = Date.parse(value);
    const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
    if (!Number.isFinite(parsed) || !rfc3339.test(value)) {
      throw new SchedulingError(
        'SLOT_NO_LONGER_AVAILABLE',
        'Timestamp must be a finite RFC 3339 instant.',
      );
    }
  }

  private overlaps(left: TimeInterval, right: TimeInterval): boolean {
    return (
      Date.parse(left.start) < Date.parse(right.end) &&
      Date.parse(right.start) < Date.parse(left.end)
    );
  }

  private expireHolds(tenantId: string, now: string): void {
    for (const hold of this.holds.values()) {
      if (
        hold.tenantId === tenantId &&
        hold.state === 'live' &&
        Date.parse(now) >= Date.parse(hold.expiresAt)
      ) {
        hold.state = 'expired';
      }
    }
  }

  private policyWarnings(held: PolicySnapshot, current: PolicySnapshot): string[] {
    if (held.version === current.version) return [];
    return [`policy-changed-after-authoritative-hold:${held.version}->${current.version}`];
  }

  private effectIdentity(
    operation: SchedulingOperation,
    scope: SchedulingScope & Partial<TimeInterval>,
    idempotencyKey: string,
  ): string {
    return [
      scope.tenantId,
      scope.providerId,
      [...scope.resourceIds].sort().join(','),
      scope.start ?? '',
      scope.end ?? '',
      operation,
      idempotencyKey,
    ].join('|');
  }

  private idempotencyMapKey(tenantId: string, idempotencyKey: string): string {
    return `${tenantId}|${idempotencyKey}`;
  }

  private replay<T>(key: string, fingerprint: string): T | undefined {
    const existing = this.idempotentResults.get(key);
    if (existing === undefined) return undefined;
    if (existing.fingerprint !== fingerprint) {
      throw new SchedulingError(
        'IDEMPOTENCY_CONFLICT',
        'The idempotency key was reused for a different command.',
      );
    }
    if (existing.state === 'indeterminate') {
      throw new SchedulingError(
        'RECONCILIATION_REQUIRED',
        'The prior provider outcome is indeterminate; reconcile before retry.',
        { effectIdentity: existing.effectIdentity },
      );
    }
    return structuredClone(existing.result as T);
  }

  private remember<T>(key: string, fingerprint: string, result: T): void {
    this.idempotentResults.set(key, {
      state: 'complete',
      fingerprint,
      result: structuredClone(result),
    });
  }

  private recordProviderFailure(
    key: string,
    fingerprint: string,
    effectIdentity: string,
    error: unknown,
    scope: SchedulingScope,
    patientId?: string,
  ): void {
    this.reconciliation.push({ effectIdentity, reason: this.errorMessage(error) });
    if (this.isIndeterminateProviderError(error)) {
      this.idempotentResults.set(key, { state: 'indeterminate', fingerprint, effectIdentity });
      for (const lockKey of this.scopeLockKeys(scope, patientId)) {
        this.indeterminateScopeKeys.add(lockKey);
      }
    }
  }

  private assertScopeNotIndeterminate(scope: SchedulingScope, patientId?: string): void {
    const blocked = this.scopeLockKeys(scope, patientId).find((key) =>
      this.indeterminateScopeKeys.has(key),
    );
    if (blocked !== undefined) {
      throw new SchedulingError(
        'RECONCILIATION_REQUIRED',
        'A prior effect on this scheduling scope is indeterminate.',
        { blockedScope: blocked },
      );
    }
  }

  private isIndeterminateProviderError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('outcomeIndeterminate' in error)) {
      return true;
    }
    return error.outcomeIndeterminate !== false;
  }

  private assertReceipt(
    receipt: BookingReceipt,
    expected: {
      tenantId: string;
      effectIdentity: string;
      authorityEpoch: number;
      minimumSourceVersion: number;
    },
  ): void {
    if (
      receipt.tenantId !== expected.tenantId ||
      receipt.effectIdentity !== expected.effectIdentity ||
      receipt.authorityEpoch !== expected.authorityEpoch ||
      receipt.sourceVersion < expected.minimumSourceVersion ||
      receipt.adapterId !== this.provider.adapterId ||
      receipt.adapterMode !== this.provider.adapterMode
    ) {
      throw new SchedulingError(
        'RECONCILIATION_REQUIRED',
        'Provider receipt does not match the requested effect boundary.',
      );
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown-provider-failure';
  }
}

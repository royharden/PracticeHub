import type { ConstraintProviderPort, ResourceCatalogPort } from '../ports.js';
import type {
  Appointment,
  CatalogSlot,
  ConstraintBundleSnapshot,
  ConstraintEvaluation,
  ConstraintProviderRecord,
  Hold,
  LinkedResourceNeed,
  ManagerSchedulingException,
  ResourceUnavailableTask,
  SlotOffer,
  TimeInterval,
  WaitlistEntry,
  WaitlistPriorityPause,
} from '../types.js';

export class Increment2Error extends Error {
  constructor(
    readonly code:
      | 'HARD_CONSTRAINT_UNSATISFIED'
      | 'CONSTRAINT_VERSION_CHANGED'
      | 'CONSTRAINT_DATA_MISSING'
      | 'RESOURCE_UNAVAILABLE'
      | 'LATE_WAITLIST_NO_MUTATION'
      | 'READINESS_BYPASS_REFUSED'
      | 'CALIBRATION_NOT_THIS_INCREMENT'
      | 'OVERLAP_BLOCKED',
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'Increment2Error';
  }
}

function overlaps(left: TimeInterval, right: TimeInterval, bufferMinutes = 0): boolean {
  const bufferMs = bufferMinutes * 60_000;
  const leftStart = Date.parse(left.start) - bufferMs;
  const leftEnd = Date.parse(left.end) + bufferMs;
  const rightStart = Date.parse(right.start);
  const rightEnd = Date.parse(right.end);
  return leftStart < rightEnd && rightStart < leftEnd;
}

function isVirtual(slot: Pick<SlotOffer, 'serviceId'>): boolean {
  return slot.serviceId.startsWith('telehealth') || slot.serviceId.startsWith('virtual');
}

export class Increment2Engine {
  readonly pauses = new Map<string, WaitlistPriorityPause>();
  readonly exceptions: ManagerSchedulingException[] = [];
  readonly tasks: ResourceUnavailableTask[] = [];
  readonly interpreterAttachments = new Map<
    string,
    { resourceId: string; status: 'requested' | 'confirmed' }
  >();
  readonly noShowPatterns: Array<{ patientId: string; at: string }> = [];
  readonly recallDue: Array<{ patientId: string; dueAt: string }> = [];
  readonly closedWaitlist: string[] = [];

  constructor(
    private readonly constraints: ConstraintProviderPort,
    private readonly catalog: ResourceCatalogPort,
  ) {}

  evaluateConstraints(
    offer: SlotOffer & { constraintBundleId: string; constraintBundleVersion: number },
    tenantId: string,
  ): ConstraintEvaluation {
    const bundle = this.constraints.currentBundle(tenantId, offer.constraintBundleId);
    const record = this.constraints.providerRecord(
      tenantId,
      offer.providerId,
      offer.constraintBundleId,
    );
    if (!bundle || !record || record.stale) {
      return { outcome: 'human-scheduler', reason: 'missing-or-stale-provider-data' };
    }
    if (bundle.version !== offer.constraintBundleVersion) {
      return {
        outcome: 'withdrawn',
        reason: 'constraint-version-changed',
        offerVersion: offer.constraintBundleVersion,
        currentVersion: bundle.version,
      };
    }
    const failedHard: string[] = [];
    const softTradeoffs: string[] = [];
    for (const constraint of bundle.constraints) {
      const actual = record.values[constraint.dimension];
      if (constraint.kind === 'hard' && actual !== constraint.requiredValue) {
        failedHard.push(constraint.constraintId);
      }
      if (constraint.kind === 'soft' && actual !== constraint.requiredValue) {
        softTradeoffs.push(
          `${constraint.dimension}:${actual ?? 'none'}!=${constraint.requiredValue}`,
        );
      }
    }
    if (failedHard.length > 0) {
      return { outcome: 'unsatisfied', failedHard, softTradeoffs };
    }
    return { outcome: 'satisfied', bundleVersion: bundle.version };
  }

  equivalentOffers(failed: SlotOffer, tenantId: string, nowIso: string): CatalogSlot[] {
    const now = Date.parse(nowIso);
    return this.catalog.list(tenantId).filter((slot) => {
      if (slot.outOfService) return false;
      if (Date.parse(slot.start) < now) return false;
      if (slot.serviceId !== failed.serviceId) return false;
      return true;
    });
  }

  commitLinkedResources(
    needs: readonly LinkedResourceNeed[],
    owner: string,
    sla: string,
  ): {
    committed: boolean;
    receipts: readonly string[];
    task?: ResourceUnavailableTask;
  } {
    const missing = needs.filter((need) => need.required && !need.available);
    if (missing.length > 0) {
      const task: ResourceUnavailableTask = {
        taskId: `task:${missing[0]?.resourceId}`,
        owner,
        sla,
        resourceId: missing[0]?.resourceId ?? 'unknown',
        state: 'open',
      };
      this.tasks.push(task);
      return { committed: false, receipts: [], task };
    }
    return {
      committed: true,
      receipts: needs.map((need) => `receipt:${need.resourceId}`),
    };
  }

  detectTransportConflict(
    first: CatalogSlot,
    second: CatalogSlot,
    travelBufferMinutes: number,
  ): boolean {
    if (first.locationId === second.locationId) return false;
    const padded: TimeInterval = {
      start: new Date(Date.parse(first.start) - first.setupMinutes * 60_000).toISOString(),
      end: new Date(Date.parse(first.end) + first.cleanupMinutes * 60_000).toISOString(),
    };
    return overlaps(padded, second, travelBufferMinutes);
  }

  recordException(exception: ManagerSchedulingException): ManagerSchedulingException {
    this.exceptions.push(exception);
    return exception;
  }

  attachInterpreter(
    appointmentId: string,
    interpreter: { resourceId: string; qualified: boolean; available: boolean },
  ): { status: 'confirmed' | 'requested' | 'tasked'; task?: ResourceUnavailableTask } {
    if (!interpreter.qualified || !interpreter.available) {
      const task: ResourceUnavailableTask = {
        taskId: `interp:${appointmentId}`,
        owner: 'accessibility-desk',
        sla: 'same-day-replacement',
        resourceId: interpreter.resourceId,
        state: 'open',
      };
      this.tasks.push(task);
      this.interpreterAttachments.set(appointmentId, {
        resourceId: interpreter.resourceId,
        status: 'requested',
      });
      return { status: 'tasked', task };
    }
    this.interpreterAttachments.set(appointmentId, {
      resourceId: interpreter.resourceId,
      status: 'confirmed',
    });
    return { status: 'confirmed' };
  }

  pauseWaitlist(
    entry: WaitlistEntry,
    reason: string,
    owner: string,
    originalPriority: number,
    reevaluationDeadline: string,
  ): WaitlistPriorityPause {
    const pause: WaitlistPriorityPause = {
      waitlistEntryId: entry.waitlistEntryId,
      reason,
      owner,
      originalPriority,
      reevaluationDeadline,
      state: 'paused',
    };
    this.pauses.set(entry.waitlistEntryId, pause);
    return pause;
  }

  restoreWaitlist(waitlistEntryId: string): WaitlistPriorityPause | undefined {
    const pause = this.pauses.get(waitlistEntryId);
    if (!pause) return undefined;
    this.pauses.delete(waitlistEntryId);
    return { ...pause, state: 'paused' };
  }

  sameDayBackfill(
    candidates: readonly {
      patientId: string;
      prerequisiteReady: boolean;
      authorizationReady: boolean;
      travelReady: boolean;
      interpreterReady: boolean;
      equipmentReady: boolean;
      consentedChannel: boolean;
      predictedNoShow: boolean;
      member: boolean;
      staffPreferred: boolean;
    }[],
  ): { bookedPatientId: string | null; declined: readonly string[] } {
    const ready = candidates.filter(
      (candidate) =>
        candidate.prerequisiteReady &&
        candidate.authorizationReady &&
        candidate.travelReady &&
        candidate.interpreterReady &&
        candidate.equipmentReady &&
        candidate.consentedChannel,
    );
    const winner = ready[0];
    if (!winner) {
      return {
        bookedPatientId: null,
        declined: candidates.map((candidate) => candidate.patientId),
      };
    }
    if (winner.predictedNoShow || winner.member || winner.staffPreferred) {
      if (
        !winner.prerequisiteReady ||
        !winner.authorizationReady ||
        !winner.travelReady ||
        !winner.interpreterReady ||
        !winner.equipmentReady ||
        !winner.consentedChannel
      ) {
        throw new Increment2Error(
          'READINESS_BYPASS_REFUSED',
          'Predicted no-show, membership, or staff preference cannot bypass readiness.',
          { patientId: winner.patientId },
        );
      }
    }
    return {
      bookedPatientId: winner.patientId,
      declined: candidates
        .filter((candidate) => candidate.patientId !== winner.patientId)
        .map((c) => c.patientId),
    };
  }

  acceptLateWaitlist(input: {
    authoritativeSlotMoved: boolean;
    holdExpired: boolean;
    existingAppointmentId?: string;
    waitlistPriority: number;
  }): {
    mutated: boolean;
    originalAppointmentId?: string;
    priority: number;
    declineCounted: boolean;
  } {
    const result: {
      mutated: boolean;
      originalAppointmentId?: string;
      priority: number;
      declineCounted: boolean;
    } = {
      mutated: !(input.authoritativeSlotMoved || input.holdExpired),
      priority: input.waitlistPriority,
      declineCounted: false,
    };
    if (input.existingAppointmentId !== undefined) {
      result.originalAppointmentId = input.existingAppointmentId;
    }
    return result;
  }

  searchCatalog(
    tenantId: string,
    locationId: string,
    interval: TimeInterval,
  ): { slots: CatalogSlot[]; alternateLocations: readonly string[] } {
    const all = this.catalog.list(tenantId);
    const here = all.filter(
      (slot) =>
        slot.locationId === locationId &&
        !slot.outOfService &&
        Date.parse(slot.start) >= Date.parse(interval.start) &&
        Date.parse(slot.end) <= Date.parse(interval.end),
    );
    const alternates = [
      ...new Set(
        all
          .filter((slot) => slot.locationId !== locationId && !slot.outOfService)
          .map((slot) => slot.locationId),
      ),
    ];
    return { slots: here, alternateLocations: alternates };
  }

  offerFreedSlot(
    ranked: readonly WaitlistEntry[],
    responseDeadline: string,
    nowIso: string,
  ): { offered?: WaitlistEntry; revertedToOpen: boolean } {
    const next = ranked.find((entry) => entry.state === 'waiting');
    if (!next) {
      return { revertedToOpen: Date.parse(nowIso) > Date.parse(responseDeadline) };
    }
    return { offered: next, revertedToOpen: false };
  }

  recordNoShow(patientId: string, at: string, lockout = false): void {
    if (lockout) {
      throw new Increment2Error(
        'READINESS_BYPASS_REFUSED',
        'No-show recording must not lock the patient out of scheduling.',
        { patientId },
      );
    }
    this.noShowPatterns.push({ patientId, at });
  }

  reverseNoShowIfArrived(patientId: string, reassigned: boolean): boolean {
    if (reassigned) return false;
    const index = this.noShowPatterns.findIndex((row) => row.patientId === patientId);
    if (index >= 0) this.noShowPatterns.splice(index, 1);
    return true;
  }

  checkPatientOverlap(
    existing: readonly (Appointment | Hold)[],
    candidate: SlotOffer,
    travelBufferMinutes: number,
  ): { blocked: boolean; requiresIntentionalConfirm: boolean } {
    const buffer = isVirtual(candidate) ? 0 : travelBufferMinutes;
    const hit = existing.some((row) => overlaps(row, candidate, buffer));
    return { blocked: hit, requiresIntentionalConfirm: hit };
  }

  sweepOverlaps(appointments: readonly Appointment[], travelBufferMinutes: number): Appointment[] {
    const hits: Appointment[] = [];
    for (let i = 0; i < appointments.length; i += 1) {
      for (let j = i + 1; j < appointments.length; j += 1) {
        const left = appointments[i];
        const right = appointments[j];
        if (!left || !right) continue;
        if (left.patientId !== right.patientId) continue;
        const buffer = isVirtual(left) || isVirtual(right) ? 0 : travelBufferMinutes;
        if (overlaps(left, right, buffer)) {
          hits.push(left, right);
        }
      }
    }
    return hits;
  }

  refuseCalibrationOverride(): never {
    throw new Increment2Error(
      'CALIBRATION_NOT_THIS_INCREMENT',
      'Calibration source and override parity stay with WP-065/WP-032.',
    );
  }
}

export function memoryConstraintPort(
  bundle: ConstraintBundleSnapshot,
  record: ConstraintProviderRecord | null,
): ConstraintProviderPort {
  return {
    currentBundle: () => bundle,
    providerRecord: () => record,
  };
}

export function memoryCatalogPort(slots: readonly CatalogSlot[]): ResourceCatalogPort {
  return {
    list: () => slots,
  };
}

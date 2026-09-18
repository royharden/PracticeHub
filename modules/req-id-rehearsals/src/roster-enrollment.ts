export class RehearsalError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RehearsalError';
  }
}

export interface RosterEntry {
  readonly tenantId: string;
  readonly legalEntityId: string;
  readonly employeeRef: string;
  readonly employerContact: string;
}

export interface Enrollment {
  readonly employeeRef: string;
  readonly status: 'invited' | 'active' | 'declined' | 'roster-removed';
  readonly identityVerified: boolean;
  readonly consentCompleted: boolean;
  readonly contactPref: string;
  readonly employerView: 'invited' | 'declined' | 'enrolled' | 'removed';
  readonly declineReason: string | null;
}

/**
 * Simulated REQ-ID-022 rehearsal. Does not write modules/identity.
 */
export class RosterEnrollment {
  private readonly enrollments = new Map<string, Enrollment>();

  public upload(entry: RosterEntry): Enrollment {
    const enrollment: Enrollment = {
      employeeRef: entry.employeeRef,
      status: 'invited',
      identityVerified: false,
      consentCompleted: false,
      contactPref: entry.employerContact,
      employerView: 'invited',
      declineReason: null,
    };
    this.enrollments.set(entry.employeeRef, enrollment);
    return enrollment;
  }

  public verifyAndConsent(employeeRef: string, contactPref: string): Enrollment {
    const current = this.require(employeeRef);
    if (current.status !== 'invited') {
      throw new RehearsalError('enrollment is not awaiting consent');
    }
    const next: Enrollment = {
      ...current,
      status: 'active',
      identityVerified: true,
      consentCompleted: true,
      contactPref,
      employerView: 'enrolled',
    };
    this.enrollments.set(employeeRef, next);
    return next;
  }

  public decline(employeeRef: string, reason: string): Enrollment {
    const current = this.require(employeeRef);
    const next: Enrollment = {
      ...current,
      status: 'declined',
      employerView: 'declined',
      declineReason: reason,
    };
    this.enrollments.set(employeeRef, next);
    return next;
  }

  public employerSees(employeeRef: string): {
    readonly employerView: Enrollment['employerView'];
    readonly declineReason: null;
    readonly contactPref: null;
  } {
    const current = this.require(employeeRef);
    return {
      employerView: current.employerView,
      declineReason: null,
      contactPref: null,
    };
  }

  public selfCorrectContact(employeeRef: string, contactPref: string): Enrollment {
    const current = this.require(employeeRef);
    const next: Enrollment = { ...current, contactPref };
    this.enrollments.set(employeeRef, next);
    return next;
  }

  public removeFromRoster(employeeRef: string): Enrollment {
    const current = this.require(employeeRef);
    const next: Enrollment = {
      ...current,
      status: 'roster-removed',
      employerView: 'removed',
    };
    this.enrollments.set(employeeRef, next);
    return next;
  }

  public get(employeeRef: string): Enrollment {
    return this.require(employeeRef);
  }

  private require(employeeRef: string): Enrollment {
    const enrollment = this.enrollments.get(employeeRef);
    if (enrollment === undefined) {
      throw new RehearsalError(`unknown employee ${employeeRef}`);
    }
    return enrollment;
  }
}

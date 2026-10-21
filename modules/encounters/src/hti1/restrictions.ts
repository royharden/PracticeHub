/**
 * Patient-directed restrictions honored in the access layer (WP-096).
 *
 * A patient may ask to restrict use or disclosure of a data class to one or
 * more recipient classes. Each recipient carries its own decision. The
 * health-plan recipient of a restriction on an item paid out of pocket in full
 * must be accepted and is agreed at intake; every other recipient waits for a
 * provider decision. A restriction id is immutable: a replay is refused, and a
 * change happens only through an attributed agree / decline / terminate step.
 * The patient's own access is never restricted. Emergency treatment may
 * override with a recorded reason.
 */

export class RestrictionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RestrictionError';
  }
}

export const recipientClasses = [
  'self',
  'treating-clinician',
  'care-team-staff',
  'health-plan',
  'personal-representative',
  'third-party',
] as const;
export type RecipientClass = (typeof recipientClasses)[number];

export type RestrictionStatus = 'requested' | 'agreed' | 'declined' | 'terminated';

export const mandatorySelfPayDecider = 'mandatory:self-paid-in-full';

export interface RestrictionRequest {
  readonly restrictionId: string;
  readonly tenantId: string;
  readonly personId: string;
  readonly dataClass: string;
  readonly encounterIds: readonly string[] | 'all';
  readonly restrictedRecipients: readonly RecipientClass[];
  readonly selfPaidInFull: boolean;
  readonly requestedAt: string;
}

export interface RecipientDecision {
  readonly recipient: RecipientClass;
  readonly status: RestrictionStatus;
  readonly mandatory: boolean;
  readonly decidedBy: string | null;
  readonly reason: string | null;
  /** Evidence of the patient's own request, recorded when a mandatory restriction ends. */
  readonly patientRequestEvidenceRef?: string;
}

export interface Restriction extends RestrictionRequest {
  readonly decisions: readonly RecipientDecision[];
}

export interface AccessRequest {
  readonly tenantId: string;
  readonly personId: string;
  readonly dataClass: string;
  readonly encounterId: string;
  readonly recipient: RecipientClass;
  readonly actorRef: string;
  readonly emergencyTreatmentReason?: string;
}

export type AccessDecision =
  | { readonly allowed: true; readonly basis: 'no-restriction' | 'patient-self' }
  | {
      readonly allowed: true;
      readonly basis: 'emergency-override';
      readonly restrictionId: string;
      readonly reason: string;
    }
  | { readonly allowed: false; readonly restrictionId: string; readonly reason: string };

export function statusFor(
  restriction: Restriction,
  recipient: RecipientClass,
): RestrictionStatus | null {
  return restriction.decisions.find((d) => d.recipient === recipient)?.status ?? null;
}

export class RestrictionRegistry {
  private readonly restrictions = new Map<string, Restriction>();
  private readonly overrideLog: { restrictionId: string; actorRef: string; reason: string }[] = [];

  public request(input: RestrictionRequest): Restriction {
    if (this.restrictions.has(input.restrictionId)) {
      throw new RestrictionError(
        `restriction ${input.restrictionId} already exists; ids are immutable`,
      );
    }
    if (input.restrictedRecipients.length === 0 || input.dataClass.trim() === '') {
      throw new RestrictionError('a restriction names a data class and at least one recipient');
    }
    if (input.restrictedRecipients.includes('self')) {
      throw new RestrictionError("a restriction cannot block the patient's own access");
    }
    if (new Set(input.restrictedRecipients).size !== input.restrictedRecipients.length) {
      throw new RestrictionError('a recipient is listed twice');
    }
    const decisions = input.restrictedRecipients.map((recipient): RecipientDecision => {
      const mandatory = input.selfPaidInFull && recipient === 'health-plan';
      return {
        recipient,
        status: mandatory ? 'agreed' : 'requested',
        mandatory,
        decidedBy: mandatory ? mandatorySelfPayDecider : null,
        reason: null,
      };
    });
    const restriction: Restriction = {
      ...input,
      restrictedRecipients: [...input.restrictedRecipients],
      decisions,
    };
    this.restrictions.set(input.restrictionId, restriction);
    return restriction;
  }

  /** Agree the named recipients (default: every recipient still requested). */
  public agree(
    restrictionId: string,
    decidedBy: string,
    recipients?: readonly RecipientClass[],
  ): Restriction {
    return this.decide(restrictionId, recipients, 'requested', (d) => {
      if (d.status !== 'requested') {
        throw new RestrictionError(`${d.recipient} is already ${d.status}`);
      }
      return { ...d, status: 'agreed', decidedBy, reason: null };
    });
  }

  public decline(
    restrictionId: string,
    decidedBy: string,
    reason: string,
    recipients?: readonly RecipientClass[],
  ): Restriction {
    if (reason.trim() === '') {
      throw new RestrictionError('declining a restriction requires a reason');
    }
    return this.decide(restrictionId, recipients, 'requested', (d) => {
      if (d.mandatory) {
        throw new RestrictionError(
          'a self-paid-in-full health-plan restriction cannot be declined',
        );
      }
      if (d.status !== 'requested') {
        throw new RestrictionError(`${d.recipient} is already ${d.status}`);
      }
      return { ...d, status: 'declined', decidedBy, reason };
    });
  }

  /**
   * End an agreed restriction. A mandatory self-pay restriction ends only at the
   * patient's own request, evidenced by a reference to that request (a signed
   * form, a portal message); the caller's flag alone is not enough.
   */
  public terminate(
    restrictionId: string,
    terminatedBy: string,
    reason: string,
    options: {
      readonly patientRequested: boolean;
      readonly patientRequestEvidenceRef?: string;
      readonly recipients?: readonly RecipientClass[];
    },
  ): Restriction {
    if (reason.trim() === '' || terminatedBy.trim() === '') {
      throw new RestrictionError('termination requires an actor and a reason');
    }
    const evidenceRef = options.patientRequestEvidenceRef?.trim() ?? '';
    return this.decide(restrictionId, options.recipients, 'agreed', (d) => {
      if (d.status !== 'agreed') {
        throw new RestrictionError(`${d.recipient} is ${d.status}, not agreed`);
      }
      if (d.mandatory && !options.patientRequested) {
        throw new RestrictionError(
          'a self-paid-in-full health-plan restriction ends only at the patient request',
        );
      }
      if (d.mandatory && evidenceRef === '') {
        throw new RestrictionError(
          'ending a self-paid-in-full health-plan restriction needs evidence of the patient request',
        );
      }
      return {
        ...d,
        status: 'terminated',
        decidedBy: terminatedBy,
        reason,
        ...(d.mandatory ? { patientRequestEvidenceRef: evidenceRef } : {}),
      };
    });
  }

  public decideAccess(req: AccessRequest): AccessDecision {
    if (req.recipient === 'self') {
      return { allowed: true, basis: 'patient-self' };
    }
    const hit = [...this.restrictions.values()].find(
      (r) =>
        r.tenantId === req.tenantId &&
        r.personId === req.personId &&
        r.dataClass === req.dataClass &&
        statusFor(r, req.recipient) === 'agreed' &&
        (r.encounterIds === 'all' || r.encounterIds.includes(req.encounterId)),
    );
    if (hit === undefined) {
      return { allowed: true, basis: 'no-restriction' };
    }
    const emergency = req.emergencyTreatmentReason?.trim() ?? '';
    if (emergency !== '' && req.recipient === 'treating-clinician') {
      this.overrideLog.push({
        restrictionId: hit.restrictionId,
        actorRef: req.actorRef,
        reason: emergency,
      });
      return {
        allowed: true,
        basis: 'emergency-override',
        restrictionId: hit.restrictionId,
        reason: emergency,
      };
    }
    return {
      allowed: false,
      restrictionId: hit.restrictionId,
      reason: `patient-directed restriction on ${hit.dataClass} to ${req.recipient}`,
    };
  }

  public get(restrictionId: string): Restriction {
    return this.require(restrictionId);
  }

  public overrides(): readonly { restrictionId: string; actorRef: string; reason: string }[] {
    return [...this.overrideLog];
  }

  private decide(
    restrictionId: string,
    recipients: readonly RecipientClass[] | undefined,
    defaultStatus: RestrictionStatus,
    step: (decision: RecipientDecision) => RecipientDecision,
  ): Restriction {
    const current = this.require(restrictionId);
    const targets =
      recipients ??
      current.decisions.filter((d) => d.status === defaultStatus).map((d) => d.recipient);
    if (targets.length === 0) {
      throw new RestrictionError(
        `restriction ${restrictionId} has no ${defaultStatus} recipient to decide`,
      );
    }
    for (const recipient of targets) {
      if (!current.decisions.some((d) => d.recipient === recipient)) {
        throw new RestrictionError(`${recipient} is not on restriction ${restrictionId}`);
      }
    }
    const next: Restriction = {
      ...current,
      decisions: current.decisions.map((d) => (targets.includes(d.recipient) ? step(d) : d)),
    };
    this.restrictions.set(restrictionId, next);
    return next;
  }

  private require(restrictionId: string): Restriction {
    const restriction = this.restrictions.get(restrictionId);
    if (restriction === undefined) {
      throw new RestrictionError(`unknown restriction ${restrictionId}`);
    }
    return restriction;
  }
}

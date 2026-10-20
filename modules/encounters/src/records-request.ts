import {
  addDays,
  computeClockStatus,
  resolveClosurePolicy,
  type ClockStatus,
  type RecordsClosurePolicy,
} from './records-clock.double.js';

/**
 * Right-of-access records request as a WorkItem with a tracked closure clock
 * (WP-063; R6-REQ-010, co-owned with WP-019). The clock starts on intake and
 * is protective: it cannot be refused. Closure needs evidence of fulfilment.
 */

export class RecordsRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RecordsRequestError';
  }
}

export interface RecordsRequestIntake {
  readonly tenantId: string;
  readonly personId: string;
  readonly requestId: string;
  readonly receivedAt: string;
  readonly jurisdictions: readonly string[];
}

export interface RecordsRequestWorkItem {
  readonly intake: RecordsRequestIntake;
  readonly workItemClass: 'records-request';
  readonly obligationType: 'records-request-closure';
  readonly owner: 'health-information-management';
  readonly dueAt: string;
  readonly escalateAt: string;
  readonly policyProvenance: readonly string[];
  readonly terminal: 'satisfied' | 'cancelled' | null;
  readonly evidenceRef: string | null;
  readonly evidenceHash: string | null;
  readonly cancelReason: string | null;
  readonly closedAt: string | null;
}

export interface WorklistEntry {
  readonly requestId: string;
  readonly status: ClockStatus;
  readonly dueAt: string;
}

export class RecordsRequestDesk {
  private readonly items = new Map<string, RecordsRequestWorkItem>();

  public constructor(private readonly policies: readonly RecordsClosurePolicy[]) {}

  public open(intake: RecordsRequestIntake): RecordsRequestWorkItem {
    if (this.items.has(intake.requestId)) {
      throw new RecordsRequestError(`request ${intake.requestId} already open`);
    }
    const policy = resolveClosurePolicy(this.policies, intake.jurisdictions);
    const dueAt = addDays(intake.receivedAt, policy.durationDays);
    const item: RecordsRequestWorkItem = {
      intake,
      workItemClass: 'records-request',
      obligationType: 'records-request-closure',
      owner: 'health-information-management',
      dueAt,
      escalateAt: addDays(dueAt, -policy.escalationLeadDays),
      policyProvenance: policy.provenance,
      terminal: null,
      evidenceRef: null,
      evidenceHash: null,
      cancelReason: null,
      closedAt: null,
    };
    this.items.set(intake.requestId, item);
    return item;
  }

  public status(requestId: string, asOf: string): ClockStatus {
    return computeClockStatus(this.require(requestId), asOf);
  }

  public fulfil(
    requestId: string,
    evidenceRef: string,
    evidenceHash: string,
    at: string,
  ): RecordsRequestWorkItem {
    const item = this.requireOpen(requestId);
    if (evidenceRef.trim() === '' || evidenceHash.trim() === '') {
      throw new RecordsRequestError('closure requires evidence of fulfilment');
    }
    return this.close(item, { terminal: 'satisfied', evidenceRef, evidenceHash, closedAt: at });
  }

  public withdraw(requestId: string, reason: string, at: string): RecordsRequestWorkItem {
    const item = this.requireOpen(requestId);
    if (reason.trim() === '') {
      throw new RecordsRequestError('withdrawal requires a reason');
    }
    return this.close(item, { terminal: 'cancelled', cancelReason: reason, closedAt: at });
  }

  /** Open requests at or past their escalation point, most urgent first. */
  public worklist(asOf: string): readonly WorklistEntry[] {
    return [...this.items.values()]
      .map((item) => ({
        requestId: item.intake.requestId,
        status: computeClockStatus(item, asOf),
        dueAt: item.dueAt,
      }))
      .filter((entry) => entry.status === 'escalated' || entry.status === 'overdue')
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  }

  public get(requestId: string): RecordsRequestWorkItem {
    return this.require(requestId);
  }

  private close(
    item: RecordsRequestWorkItem,
    patch: Partial<
      Pick<
        RecordsRequestWorkItem,
        'terminal' | 'evidenceRef' | 'evidenceHash' | 'cancelReason' | 'closedAt'
      >
    >,
  ): RecordsRequestWorkItem {
    const next: RecordsRequestWorkItem = { ...item, ...patch };
    this.items.set(item.intake.requestId, next);
    return next;
  }

  private requireOpen(requestId: string): RecordsRequestWorkItem {
    const item = this.require(requestId);
    if (item.terminal !== null) {
      throw new RecordsRequestError(`request ${requestId} is already ${item.terminal}`);
    }
    return item;
  }

  private require(requestId: string): RecordsRequestWorkItem {
    const item = this.items.get(requestId);
    if (item === undefined) {
      throw new RecordsRequestError(`unknown request ${requestId}`);
    }
    return item;
  }
}

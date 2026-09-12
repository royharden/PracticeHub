import { appendEvents, openWorkItem, type Queryable, type WorkItemOpen } from '@practicehub/events';

export type ReconciliationReason =
  | 'IDENTITY_CONFLICT'
  | 'DUPLICATE_HELD'
  | 'PAYMENT_UNKNOWN'
  | 'LANDED_WITHOUT_RECEIPT'
  | 'PARTIAL_COMMIT'
  | 'REFUND_REVIEW';

export interface PaidServiceWorkItemInput {
  readonly tenantId: string;
  readonly workItemId: string;
  readonly subjectRef: string;
  readonly ownerRef: string;
  readonly reason: ReconciliationReason;
  readonly responseDueAt: string;
  readonly occurredAt: string;
  readonly correlationId: string;
}

export interface PaidServiceWorkItemPort {
  open(input: PaidServiceWorkItemInput): Promise<{ readonly workItemId: string }>;
}

/** Real WP-022 provider binding: opening and explicit assignment occur in the caller's transaction. */
export class EventsWorkItemPort implements PaidServiceWorkItemPort {
  public constructor(private readonly exec: Queryable) {}

  public async open(input: PaidServiceWorkItemInput): Promise<{ readonly workItemId: string }> {
    const open: WorkItemOpen = {
      workItemId: input.workItemId,
      origin:
        input.reason === 'IDENTITY_CONFLICT' || input.reason === 'DUPLICATE_HELD'
          ? 'identity-recon'
          : 'fulfillment',
      subjectRef: input.subjectRef,
      purpose: `paid-service-reconciliation:${input.reason.toLowerCase().replaceAll('_', '-')}`,
      risk: input.reason === 'PAYMENT_UNKNOWN' ? 'urgent' : 'elevated',
      serviceTier: 'paid-service',
      slaPolicyId: null,
      policyVersion: null,
      responseDueAt: input.responseDueAt,
      poolId: null,
      openedAt: input.occurredAt,
    };
    const queued = await openWorkItem(this.exec, {
      tenantId: input.tenantId,
      open,
      actorRef: 'system:paid-service-loop',
    });
    const assigned = await appendEvents(this.exec, input.tenantId, input.workItemId, [
      {
        workItemId: input.workItemId,
        eventSeq: queued.lastEventSeq + 1,
        eventType: 'assigned',
        occurredAt: input.occurredAt,
        actorRef: 'system:paid-service-loop',
        toOwnerRef: input.ownerRef,
        reason: 'assignment',
      },
    ]);
    if (assigned.ownerRef !== input.ownerRef) throw new Error('WORKITEM_OWNER_NOT_ASSIGNED');
    return { workItemId: assigned.workItemId };
  }
}

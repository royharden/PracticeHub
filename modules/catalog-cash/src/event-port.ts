import { runOutboxCommit, type Queryable } from '@practicehub/events';
import { buildEventEnvelope } from '@practicehub/platform';

export interface PaidServiceEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly type: 'payment.reconciled' | 'paid-service.refunded';
  readonly orderRef: string;
  readonly journalRef: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly externalReceiptRef: string;
}

export interface PaidServiceEventPort {
  publish(event: PaidServiceEvent): Promise<void>;
}

/** Real WP-021 outbox binding; the caller controls the surrounding database transaction. */
export class EventSpinePaidServicePort implements PaidServiceEventPort {
  public constructor(private readonly exec: Queryable) {}

  public async publish(event: PaidServiceEvent): Promise<void> {
    const envelope = buildEventEnvelope({
      eventId: event.eventId,
      tenantId: event.tenantId,
      type: event.type,
      aggregate: { type: 'paid-service-order', id: event.orderRef, version: 1 },
      occurredAt: event.occurredAt,
      recordedAt: event.occurredAt,
      source: { module: 'catalog-cash' },
      correlationId: event.correlationId,
      idempotencyKey: event.idempotencyKey,
      dataClassification: 'none',
      retentionClass: 'financial-ledger',
      externalReceiptRef: event.externalReceiptRef,
      payload: { orderRef: event.orderRef, journalRef: event.journalRef },
      synthetic: true,
    });
    await runOutboxCommit(this.exec, { envelope });
  }
}

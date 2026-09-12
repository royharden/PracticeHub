import type { Queryable } from '@practicehub/events';
import { tenantBindingSql } from '@practicehub/platform-core';

import type { PaidServiceOrder } from './paid-service-loop.js';

export interface PersistedPaidServiceOrder {
  readonly tenantId: string;
  readonly purchaseKey: string;
  readonly requestHash: string;
  readonly occurredAt: string;
  readonly refundKey?: string;
  readonly refundHash?: string;
  readonly order: PaidServiceOrder;
}

export interface PaidServiceOrderPort {
  load(tenantId: string, purchaseKey: string): Promise<PersistedPaidServiceOrder | undefined>;
  save(record: PersistedPaidServiceOrder): Promise<void>;
}

const orderKey = (tenantId: string, purchaseKey: string): string =>
  JSON.stringify([tenantId, purchaseKey]);

export class InMemoryPaidServiceOrderStore implements PaidServiceOrderPort {
  readonly #orders = new Map<string, PersistedPaidServiceOrder>();

  public load(
    tenantId: string,
    purchaseKey: string,
  ): Promise<PersistedPaidServiceOrder | undefined> {
    return Promise.resolve(this.#orders.get(orderKey(tenantId, purchaseKey)));
  }

  public save(record: PersistedPaidServiceOrder): Promise<void> {
    const key = orderKey(record.tenantId, record.purchaseKey);
    const prior = this.#orders.get(key);
    if (prior !== undefined && prior.requestHash !== record.requestHash)
      throw new Error('IDEMPOTENCY_CONFLICT');
    this.#orders.set(key, record);
    return Promise.resolve();
  }
}

export class PgPaidServiceOrderStore implements PaidServiceOrderPort {
  #serial: Promise<void> = Promise.resolve();

  /** `exec` must be one dedicated transaction-capable client, not a pool facade. */
  public constructor(private readonly exec: Queryable) {}

  public load(
    tenantId: string,
    purchaseKey: string,
  ): Promise<PersistedPaidServiceOrder | undefined> {
    return this.#committed(tenantId, async () => {
      const result = await this.exec.query(
        `SELECT tenant_id, idempotency_key, canonical_payload_hash,
                to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at,
                refund_idempotency_key, refund_request_hash, order_snapshot
           FROM catalog_cash.paid_service_order
          WHERE tenant_id=$1 AND idempotency_key=$2`,
        [tenantId, purchaseKey],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        tenantId: String(row['tenant_id']),
        purchaseKey: String(row['idempotency_key']),
        requestHash: String(row['canonical_payload_hash']),
        occurredAt: String(row['occurred_at']),
        ...(row['refund_idempotency_key'] === null
          ? {}
          : { refundKey: String(row['refund_idempotency_key']) }),
        ...(row['refund_request_hash'] === null
          ? {}
          : { refundHash: String(row['refund_request_hash']) }),
        order: row['order_snapshot'] as unknown as PaidServiceOrder,
      };
    });
  }

  public async save(record: PersistedPaidServiceOrder): Promise<void> {
    await this.#committed(record.tenantId, async () => {
      const result = await this.exec.query(
        `INSERT INTO catalog_cash.paid_service_order
          (tenant_id,order_id,buyer_ref,member_ref,offer_version_ref,idempotency_key,
           canonical_payload_hash,state,payment_journal_ref,work_item_ref,occurred_at,synthetic,
           refund_idempotency_key,refund_request_hash,order_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13,$14::jsonb)
         ON CONFLICT (tenant_id,idempotency_key) DO UPDATE
           SET state=EXCLUDED.state,
               payment_journal_ref=EXCLUDED.payment_journal_ref,
               work_item_ref=EXCLUDED.work_item_ref,
               refund_idempotency_key=EXCLUDED.refund_idempotency_key,
               refund_request_hash=EXCLUDED.refund_request_hash,
               order_snapshot=EXCLUDED.order_snapshot
         WHERE catalog_cash.paid_service_order.canonical_payload_hash=EXCLUDED.canonical_payload_hash
         RETURNING order_id`,
        [
          record.tenantId,
          record.order.orderId,
          record.order.buyerRef,
          record.order.memberRef,
          record.order.offer.offerVersionRef,
          record.purchaseKey,
          record.requestHash,
          record.order.state,
          record.order.ledgerReceipt?.journalId ?? null,
          record.order.workItemId ?? null,
          record.occurredAt,
          record.refundKey ?? null,
          record.refundHash ?? null,
          JSON.stringify(record.order),
        ],
      );
      if (result.rowCount !== 1) throw new Error('IDEMPOTENCY_CONFLICT');
    });
  }

  async #committed<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
    const run = this.#serial.then(() => this.#runCommitted(tenantId, operation));
    this.#serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #runCommitted<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
    await this.exec.query('BEGIN');
    try {
      await this.exec.query(tenantBindingSql(tenantId));
      const result = await operation();
      await this.exec.query('COMMIT');
      return result;
    } catch (error) {
      await this.exec.query('ROLLBACK');
      throw error;
    }
  }
}

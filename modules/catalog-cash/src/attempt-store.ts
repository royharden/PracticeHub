import type { Queryable } from '@practicehub/events';
import type { RailEffectObservation } from '@practicehub/payments-ledger';
import { tenantBindingSql } from '@practicehub/platform-core';

export type PaidServiceOperation = 'purchase' | 'refund';

export interface PaidServiceAttempt {
  readonly tenantId: string;
  readonly operation: PaidServiceOperation;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly authorityHash: string;
  readonly orderRef: string;
  readonly effect?: RailEffectObservation;
  readonly workItemId?: string;
  readonly submitted: boolean;
  readonly completed: boolean;
}

export interface PaidServiceAttemptPort {
  reserve(
    input: Omit<PaidServiceAttempt, 'effect' | 'workItemId' | 'submitted' | 'completed'>,
  ): Promise<PaidServiceAttempt>;
  load(
    tenantId: string,
    operation: PaidServiceOperation,
    idempotencyKey: string,
  ): Promise<PaidServiceAttempt | undefined>;
  markSubmitted(input: {
    readonly tenantId: string;
    readonly operation: PaidServiceOperation;
    readonly idempotencyKey: string;
  }): Promise<void>;
  recordEffect(input: {
    readonly tenantId: string;
    readonly operation: PaidServiceOperation;
    readonly idempotencyKey: string;
    readonly effect: RailEffectObservation;
  }): Promise<void>;
  recordWorkItem(input: {
    readonly tenantId: string;
    readonly operation: PaidServiceOperation;
    readonly idempotencyKey: string;
    readonly workItemId: string;
  }): Promise<void>;
  complete(input: {
    readonly tenantId: string;
    readonly operation: PaidServiceOperation;
    readonly idempotencyKey: string;
  }): Promise<void>;
}

const keyOf = (tenantId: string, operation: PaidServiceOperation, idempotencyKey: string): string =>
  JSON.stringify([tenantId, operation, idempotencyKey]);

export class InMemoryPaidServiceAttemptStore implements PaidServiceAttemptPort {
  readonly #attempts = new Map<string, PaidServiceAttempt>();
  readonly #refundByOrder = new Map<string, string>();

  public reserve(
    input: Omit<PaidServiceAttempt, 'effect' | 'workItemId' | 'submitted' | 'completed'>,
  ): Promise<PaidServiceAttempt> {
    const key = keyOf(input.tenantId, input.operation, input.idempotencyKey);
    const prior = this.#attempts.get(key);
    if (prior !== undefined) {
      if (
        prior.requestHash !== input.requestHash ||
        prior.authorityHash !== input.authorityHash ||
        prior.orderRef !== input.orderRef
      )
        throw new Error('IDEMPOTENCY_CONFLICT');
      return Promise.resolve(prior);
    }
    if (input.operation === 'refund') {
      const orderKey = JSON.stringify([input.tenantId, input.orderRef]);
      const reserved = this.#refundByOrder.get(orderKey);
      if (reserved !== undefined && reserved !== key) throw new Error('REFUND_ALREADY_RESERVED');
      this.#refundByOrder.set(orderKey, key);
    }
    const attempt: PaidServiceAttempt = { ...input, submitted: false, completed: false };
    this.#attempts.set(key, attempt);
    return Promise.resolve(attempt);
  }

  public markSubmitted(input: {
    readonly tenantId: string;
    readonly operation: PaidServiceOperation;
    readonly idempotencyKey: string;
  }): Promise<void> {
    this.#update(input, (attempt) => {
      if (attempt.submitted) throw new Error('ATTEMPT_NOT_RESERVABLE');
      return { ...attempt, submitted: true };
    });
    return Promise.resolve();
  }

  public load(
    tenantId: string,
    operation: PaidServiceOperation,
    idempotencyKey: string,
  ): Promise<PaidServiceAttempt | undefined> {
    return Promise.resolve(this.#attempts.get(keyOf(tenantId, operation, idempotencyKey)));
  }

  public recordEffect(input: {
    readonly tenantId: string;
    readonly operation: PaidServiceOperation;
    readonly idempotencyKey: string;
    readonly effect: RailEffectObservation;
  }): Promise<void> {
    this.#update(input, (attempt) => {
      if (!attempt.submitted || attempt.completed) throw new Error('ATTEMPT_STATE_CONFLICT');
      return { ...attempt, effect: input.effect };
    });
    return Promise.resolve();
  }

  public recordWorkItem(input: {
    readonly tenantId: string;
    readonly operation: PaidServiceOperation;
    readonly idempotencyKey: string;
    readonly workItemId: string;
  }): Promise<void> {
    this.#update(input, (attempt) => {
      if (attempt.completed) throw new Error('ATTEMPT_STATE_CONFLICT');
      return { ...attempt, workItemId: input.workItemId };
    });
    return Promise.resolve();
  }

  public complete(input: {
    readonly tenantId: string;
    readonly operation: PaidServiceOperation;
    readonly idempotencyKey: string;
  }): Promise<void> {
    this.#update(input, (attempt) => {
      if (attempt.effect === undefined) throw new Error('ATTEMPT_STATE_CONFLICT');
      if (attempt.completed) return attempt;
      return { ...attempt, completed: true };
    });
    return Promise.resolve();
  }

  #update(
    input: {
      readonly tenantId: string;
      readonly operation: PaidServiceOperation;
      readonly idempotencyKey: string;
    },
    change: (attempt: PaidServiceAttempt) => PaidServiceAttempt,
  ): void {
    const key = keyOf(input.tenantId, input.operation, input.idempotencyKey);
    const attempt = this.#attempts.get(key);
    if (attempt === undefined) throw new Error('ATTEMPT_NOT_RESERVED');
    this.#attempts.set(key, change(attempt));
  }
}

export class PgPaidServiceAttemptStore implements PaidServiceAttemptPort {
  #serial: Promise<void> = Promise.resolve();

  /** `exec` must be one dedicated transaction-capable client, not a pool-level query facade. */
  public constructor(private readonly exec: Queryable) {}

  public async reserve(
    input: Omit<PaidServiceAttempt, 'effect' | 'workItemId' | 'submitted' | 'completed'>,
  ): Promise<PaidServiceAttempt> {
    try {
      await this.#committed(input.tenantId, async () => {
        await this.exec.query(
          `INSERT INTO catalog_cash.paid_service_attempt
          (tenant_id, operation, idempotency_key, request_hash, authority_hash, order_ref, state, synthetic)
         VALUES ($1,$2,$3,$4,$5,$6,'reserved',true)
         ON CONFLICT (tenant_id, operation, idempotency_key) DO NOTHING`,
          [
            input.tenantId,
            input.operation,
            input.idempotencyKey,
            input.requestHash,
            input.authorityHash,
            input.orderRef,
          ],
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505' && input.operation === 'refund') {
        throw new Error('REFUND_ALREADY_RESERVED', { cause: error });
      }
      throw error;
    }
    const attempt = await this.load(input.tenantId, input.operation, input.idempotencyKey);
    if (attempt === undefined) throw new Error('ATTEMPT_RESERVATION_FAILED');
    if (
      attempt.requestHash !== input.requestHash ||
      attempt.authorityHash !== input.authorityHash ||
      attempt.orderRef !== input.orderRef
    )
      throw new Error('IDEMPOTENCY_CONFLICT');
    return attempt;
  }

  public async load(
    tenantId: string,
    operation: PaidServiceOperation,
    idempotencyKey: string,
  ): Promise<PaidServiceAttempt | undefined> {
    return this.#committed(tenantId, async () => {
      const result = await this.exec.query(
        `SELECT tenant_id, operation, idempotency_key, request_hash, authority_hash, order_ref, rail_effect_ref,
              rail_outcome, external_receipt_ref,
              to_char(effect_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS observed_at,
              work_item_ref, rail_submitted, state
         FROM catalog_cash.paid_service_attempt
        WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3`,
        [tenantId, operation, idempotencyKey],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      const effectRef = row['rail_effect_ref'];
      return {
        tenantId: String(row['tenant_id']),
        operation: row['operation'] as PaidServiceOperation,
        idempotencyKey: String(row['idempotency_key']),
        requestHash: String(row['request_hash']),
        authorityHash: String(row['authority_hash']),
        orderRef: String(row['order_ref']),
        ...(effectRef === null
          ? {}
          : {
              effect: {
                effectRef: String(effectRef),
                outcome: row['rail_outcome'] as RailEffectObservation['outcome'],
                ...(row['external_receipt_ref'] === null
                  ? {}
                  : { receiptRef: String(row['external_receipt_ref']) }),
                observedAt: String(row['observed_at']),
              },
            }),
        ...(row['work_item_ref'] === null ? {} : { workItemId: String(row['work_item_ref']) }),
        completed: row['state'] === 'completed',
        submitted: row['rail_submitted'] === true,
      };
    });
  }

  public async markSubmitted(input: {
    readonly tenantId: string;
    readonly operation: PaidServiceOperation;
    readonly idempotencyKey: string;
  }): Promise<void> {
    await this.#committed(input.tenantId, async () => {
      const result = await this.exec.query(
        `UPDATE catalog_cash.paid_service_attempt SET state='submitted', rail_submitted=true
        WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3 AND state='reserved'`,
        [input.tenantId, input.operation, input.idempotencyKey],
      );
      if (result.rowCount !== 1) throw new Error('ATTEMPT_NOT_RESERVABLE');
    });
  }

  public async recordEffect(input: {
    readonly tenantId: string;
    readonly operation: PaidServiceOperation;
    readonly idempotencyKey: string;
    readonly effect: RailEffectObservation;
  }): Promise<void> {
    await this.#committed(input.tenantId, async () => {
      const result = await this.exec.query(
        `UPDATE catalog_cash.paid_service_attempt SET rail_effect_ref=$4, rail_outcome=$5,
          external_receipt_ref=$6, effect_observed_at=$7, state='effect_observed'
        WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3
          AND rail_submitted AND state IN ('submitted','effect_observed','reconciliation_held')`,
        [
          input.tenantId,
          input.operation,
          input.idempotencyKey,
          input.effect.effectRef,
          input.effect.outcome,
          input.effect.receiptRef ?? null,
          input.effect.observedAt,
        ],
      );
      if (result.rowCount !== 1) throw new Error('ATTEMPT_STATE_CONFLICT');
    });
  }

  public async recordWorkItem(input: {
    readonly tenantId: string;
    readonly operation: PaidServiceOperation;
    readonly idempotencyKey: string;
    readonly workItemId: string;
  }): Promise<void> {
    await this.#committed(input.tenantId, async () => {
      const result = await this.exec.query(
        `UPDATE catalog_cash.paid_service_attempt SET work_item_ref=$4, state='reconciliation_held'
        WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3 AND state <> 'completed'`,
        [input.tenantId, input.operation, input.idempotencyKey, input.workItemId],
      );
      if (result.rowCount !== 1) throw new Error('ATTEMPT_STATE_CONFLICT');
    });
  }

  public async complete(input: {
    readonly tenantId: string;
    readonly operation: PaidServiceOperation;
    readonly idempotencyKey: string;
  }): Promise<void> {
    await this.#committed(input.tenantId, async () => {
      const result = await this.exec.query(
        `UPDATE catalog_cash.paid_service_attempt SET state='completed'
        WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3
          AND state IN ('effect_observed','completed') AND rail_effect_ref IS NOT NULL`,
        [input.tenantId, input.operation, input.idempotencyKey],
      );
      if (result.rowCount !== 1) throw new Error('ATTEMPT_STATE_CONFLICT');
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

/**
 * Event-spine repository (WP-021, M05). Contract: docs/contracts/event-spine.md
 * (FROZEN). Architecture: ADR-009 Decision 2/3.
 *
 * Binds the pure substrate primitives (`@practicehub/platform`) to the `events`
 * schema over a minimal `Queryable` (a `pg` client, or any transaction-bound
 * executor — so callers own the transaction boundary and the DB suite can inject
 * a crash mid-transaction). Two obligations ride here:
 *
 * - `runOutboxCommit` — the SAME-COMMIT helper (FWD-AUD-021-OUTBOX / R6-REQ-001
 *   wiring): a command's side effect, its outbox enqueue, AND its audit emit
 *   land in ONE transaction on the live spine, or none do. The audit input is
 *   validated FIRST — an operation that cannot be audited never runs.
 * - the drain step — claims pending deliveries with `FOR UPDATE SKIP LOCKED` and
 *   advances each through `planDrainAction`: a first sighting publishes (inbox
 *   `INSERT ... ON CONFLICT DO NOTHING` is the exactly-once gate), a redelivery
 *   skips, a capability denied AT DRAIN parks (FWD-CAP-QUEUE: drain authoritative).
 */

import type { EventEnvelope } from '@practicehub/contracts';
import {
  chainDayOf,
  chainKeyFor,
  emitAuditEvent,
  emptyChainState,
  type AuditChainState,
  type AuditEmitInput,
  type AuditRecord,
} from '@practicehub/audit-evidence';
import {
  inboxDedupDecision,
  planDrainAction,
  planFailureAction,
  type DrainAction,
  type OutboxDelivery,
  type RetryPolicy,
} from '@practicehub/platform';

import {
  envelopeFromClaim,
  outboxColumns,
  outboxInsertParams,
  type ClaimedDeliveryRow,
} from './spine.js';

/** Minimal async query executor — `pg`'s Client/Pool satisfy it. */
export interface Queryable {
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

const placeholders = (count: number, from = 1): string =>
  Array.from({ length: count }, (_unused, index) => `$${index + from}`).join(', ');

/**
 * Enqueue one envelope: the immutable outbox row plus its `pending` delivery.
 * Runs on the caller's transaction so it shares the command's commit.
 */
export async function enqueueEnvelope<TPayload>(
  exec: Queryable,
  envelope: EventEnvelope<TPayload>,
): Promise<void> {
  await exec.query(
    `INSERT INTO events.outbox (${outboxColumns.join(', ')}) VALUES (${placeholders(outboxColumns.length)})`,
    outboxInsertParams(envelope),
  );
  await exec.query(
    `INSERT INTO events.outbox_delivery (tenant_id, event_id, status, attempts, synthetic)
     VALUES ($1, $2, 'pending', 0, true)`,
    [envelope.tenantId, envelope.eventId],
  );
}

async function nextAuditChainState(
  exec: Queryable,
  tenantId: string,
  chainDay: string,
): Promise<AuditChainState> {
  // No FOR UPDATE: the audit log is append-only (UPDATE is revoked), and the
  // UNIQUE (tenant, chain_day, chain_seq) constraint already serializes the
  // chain — a racing same-commit conflicts on that key and fails closed.
  const result = await exec.query(
    `SELECT chain_seq, entry_hash FROM audit_evidence.audit_event
      WHERE tenant_id = $1 AND chain_day = $2::date
      ORDER BY chain_seq DESC LIMIT 1`,
    [tenantId, chainDay],
  );
  const head = result.rows[0];
  if (head === undefined) {
    return emptyChainState;
  }
  return new Map([
    [
      chainKeyFor(tenantId, chainDay),
      { seq: Number(head['chain_seq']), head: String(head['entry_hash']) },
    ],
  ]);
}

const auditColumns = [
  'tenant_id',
  'audit_id',
  'stream',
  'action',
  'actor_ref',
  'occurred_at',
  'subject_ref',
  'decision',
  'reason',
  'source_ref',
  'correlation_ref',
  'recipient_ref',
  'purpose',
  'model_ref',
  'model_version',
  'prompt_ref',
  'prompt_hash',
  'output_ref',
  'output_hash',
  'detail',
  'partition_tags',
  'chain_day',
  'chain_seq',
  'prev_hash',
  'entry_hash',
  'synthetic',
] as const;

async function insertAuditRecord(exec: Queryable, record: AuditRecord): Promise<void> {
  const params: unknown[] = [
    record.tenantId,
    record.auditId,
    record.stream,
    record.action,
    record.actorRef,
    record.occurredAt,
    record.subjectRef ?? null,
    record.decision ?? null,
    record.reason ?? null,
    record.sourceRef ?? null,
    record.correlationRef ?? null,
    record.recipientRef ?? null,
    record.purpose ?? null,
    record.modelRef ?? null,
    record.modelVersion ?? null,
    record.promptRef ?? null,
    record.promptHash ?? null,
    record.outputRef ?? null,
    record.outputHash ?? null,
    // detail and partition_tags are NOT NULL DEFAULT '{}' in the schema — pass
    // the empty forms rather than null when the record omits them.
    record.detail === undefined ? '{}' : JSON.stringify(record.detail),
    record.partitionTags === undefined ? '{}' : `{${record.partitionTags.join(',')}}`,
    record.chainDay,
    record.chainSeq,
    record.prevHash,
    record.entryHash,
    true,
  ];
  await exec.query(
    `INSERT INTO audit_evidence.audit_event (${auditColumns.join(', ')})
     VALUES (${placeholders(auditColumns.length)})`,
    params,
  );
}

export interface OutboxCommitInput<TPayload> {
  readonly envelope: EventEnvelope<TPayload>;
  /**
   * The command's domain mutation, run inside the same transaction BEFORE the
   * enqueue. Omit for a pure event.
   */
  readonly sideEffect?: (exec: Queryable) => Promise<void>;
  /**
   * The authority-bearing write's audit emit (an authority-decision/access/etc.
   * input). Omit for a domain event that is not itself audit (ADR-008 Decision
   * 2). Validated FIRST — an operation that cannot be audited never runs.
   */
  readonly auditInput?: AuditEmitInput;
}

export interface OutboxCommitResult<TPayload> {
  readonly envelope: EventEnvelope<TPayload>;
  readonly auditRecord?: AuditRecord;
}

/**
 * Same-commit helper (FWD-AUD-021-OUTBOX). Emits the audit record's link FIRST
 * (which validates the audit input — fail closed: an unauditable operation
 * never touches the database), then, on the caller's transaction: runs the
 * domain mutation, enqueues the outbox event + delivery, and inserts the audit
 * record. The caller's COMMIT lands all three atomically; a crash (ROLLBACK)
 * leaves none — proven by the DB-suite crash test.
 */
export async function runOutboxCommit<TPayload>(
  exec: Queryable,
  input: OutboxCommitInput<TPayload>,
): Promise<OutboxCommitResult<TPayload>> {
  let auditRecord: AuditRecord | undefined;
  if (input.auditInput !== undefined) {
    const chainDay = chainDayOf(input.auditInput.occurredAt);
    const chainState = await nextAuditChainState(exec, input.auditInput.tenantId, chainDay);
    // emitAuditEvent validates the input and computes the chain link (throws
    // before any write if the operation cannot be audited).
    auditRecord = emitAuditEvent(chainState, input.auditInput).record;
  }
  if (input.sideEffect !== undefined) {
    await input.sideEffect(exec);
  }
  await enqueueEnvelope(exec, input.envelope);
  if (auditRecord !== undefined) {
    await insertAuditRecord(exec, auditRecord);
  }
  return auditRecord !== undefined
    ? { envelope: input.envelope, auditRecord }
    : { envelope: input.envelope };
}

const claimSelect = `
  SELECT o.tenant_id, o.event_id, o.legal_entity_id, o.type, o.aggregate_type, o.aggregate_id,
         o.aggregate_version,
         to_char(o.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at_iso,
         to_char(o.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS recorded_at_iso,
         CASE WHEN o.effective_at IS NULL THEN NULL
              ELSE to_char(o.effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END
           AS effective_at_iso,
         o.source_module, o.source_actor_ref, o.correlation_id, o.causation_id, o.idempotency_key,
         o.data_classification, o.retention_class, o.supersedes_event_id, o.reversal_of_event_id,
         o.external_receipt_ref, o.payload, d.status, d.attempts
    FROM events.outbox o
    JOIN events.outbox_delivery d ON d.tenant_id = o.tenant_id AND d.event_id = o.event_id
   WHERE d.status IN ('pending', 'failed') AND d.next_attempt_at <= $1::timestamptz
   ORDER BY o.event_id
     FOR UPDATE OF d SKIP LOCKED
   LIMIT $2`;

export interface ClaimedEvent {
  readonly envelope: EventEnvelope<unknown>;
  readonly delivery: OutboxDelivery;
}

/**
 * Claim up to `limit` due deliveries (pending or failed-and-retryable) with
 * `FOR UPDATE OF d SKIP LOCKED`, so concurrent drainers never claim the same
 * event. Runs on a tenant-bound session (RLS scopes the read).
 */
export async function claimPendingDeliveries(
  exec: Queryable,
  options: { readonly nowIso: string; readonly limit: number },
): Promise<readonly ClaimedEvent[]> {
  const result = await exec.query(claimSelect, [options.nowIso, options.limit]);
  return result.rows.map((row) => {
    const claimed = row as unknown as ClaimedDeliveryRow;
    return {
      envelope: envelopeFromClaim(claimed),
      delivery: { status: claimed.status as OutboxDelivery['status'], attempts: claimed.attempts },
    };
  });
}

async function markPublished(exec: Queryable, eventId: string, ranEffect: boolean): Promise<void> {
  await exec.query(
    `UPDATE events.outbox_delivery
        SET status = 'published', published_at = now(),
            attempts = attempts + CASE WHEN $2 THEN 1 ELSE 0 END, last_error = NULL
      WHERE event_id = $1`,
    [eventId, ranEffect],
  );
}

export interface DeliverInput {
  readonly claimed: ClaimedEvent;
  readonly consumer: string;
  /** requireCapability re-evaluated at checkpoint 'drain' (drain authoritative). */
  readonly capabilityAllowed: boolean;
  /** Consumer keys already recorded (from a pre-read); the DB INSERT is the gate. */
  readonly seen: ReadonlySet<string>;
  readonly retryPolicy: RetryPolicy;
  /** The consumer's transactional side effect (runs only when the inbox INSERT wins). */
  readonly sideEffect?: (exec: Queryable, event: EventEnvelope<unknown>) => Promise<void>;
}

export interface DeliverOutcome {
  readonly action: DrainAction;
  /** Whether the consumer's side effect actually ran (false on skip/park/dupe). */
  readonly effected: boolean;
}

/**
 * Advance one claimed event through its drain action, on the caller's
 * transaction. `publish` runs the side effect ONLY if the inbox INSERT wins the
 * dedup (`ON CONFLICT DO NOTHING`) — a redelivery that raced still lands the
 * effect exactly once. `park-denied` records the denial and leaves the delivery
 * pending (a kill-switch/rollback drains safely).
 */
export async function deliverClaimedEvent(
  exec: Queryable,
  input: DeliverInput,
): Promise<DeliverOutcome> {
  const eventId = input.claimed.envelope.eventId;
  const inbox = inboxDedupDecision(input.seen, input.consumer, eventId);
  const action = planDrainAction({
    delivery: input.claimed.delivery,
    capabilityAllowed: input.capabilityAllowed,
    inbox,
  });
  switch (action) {
    case 'noop':
      return { action, effected: false };
    case 'park-denied':
      await exec.query(
        `UPDATE events.outbox_delivery
            SET attempts = attempts + 1, last_error = 'capability-denied-at-drain',
                next_attempt_at = now()
          WHERE event_id = $1`,
        [eventId],
      );
      return { action, effected: false };
    case 'skip-duplicate':
      await markPublished(exec, eventId, false);
      return { action, effected: false };
    case 'publish': {
      const inserted = await exec.query(
        `INSERT INTO events.inbox (tenant_id, consumer, event_id, outcome, synthetic)
         VALUES ($1, $2, $3, 'processed', true)
         ON CONFLICT (tenant_id, consumer, event_id) DO NOTHING`,
        [input.claimed.envelope.tenantId, input.consumer, eventId],
      );
      const won = (inserted.rowCount ?? 0) === 1;
      if (won && input.sideEffect !== undefined) {
        await input.sideEffect(exec, input.claimed.envelope);
      }
      await markPublished(exec, eventId, won);
      return { action, effected: won };
    }
  }
}

/**
 * Record a delivery failure (the caller's publish transaction rolled back):
 * retry with a bumped attempt count, or dead-letter once the retry budget is
 * spent (a `dead` delivery opens a WorkItem downstream — never a silent drop).
 */
export async function markDeliveryFailed(
  exec: Queryable,
  input: {
    readonly eventId: string;
    readonly delivery: OutboxDelivery;
    readonly retryPolicy: RetryPolicy;
    readonly errorRef: string;
  },
): Promise<'retry-later' | 'dead-letter'> {
  const attempts = input.delivery.attempts + 1;
  const failure = planFailureAction({ status: 'failed', attempts }, input.retryPolicy);
  const status = failure === 'dead-letter' ? 'dead' : 'failed';
  await exec.query(
    `UPDATE events.outbox_delivery
        SET status = $2, attempts = $3, last_error = $4, next_attempt_at = now()
      WHERE event_id = $1`,
    [input.eventId, status, attempts, input.errorRef],
  );
  return failure;
}

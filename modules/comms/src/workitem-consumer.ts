import { createHash } from 'node:crypto';

import {
  appendEvents,
  claimWorkItem,
  loadWorkItem,
  openWorkItem,
  reassignWorkItem,
  type ContextPackage,
  type Queryable,
  type WorkItem,
  type WorkItemEvent,
} from '@practicehub/events';

import { openThread, type Thread } from './thread.js';

export interface OpenAccountableThreadInput {
  readonly tenantId: string;
  readonly threadId: string;
  readonly personRef: string | null;
  readonly workItemId: string;
  readonly ownerRef: string | null;
  readonly poolId: string | null;
  readonly serviceTier: string;
  readonly slaPolicyId: string;
  readonly policyVersion: number;
  readonly openedAt: string;
  readonly firstResponseDueAt: string;
  readonly actorRef: string;
}

/**
 * Real WP-022 consumer. The caller supplies one DB transaction so WorkItem and
 * Thread projection commit or roll back together; this function never opens a
 * second connection or writes an upstream table directly.
 */
export async function openAccountableThread(
  exec: Queryable,
  input: OpenAccountableThreadInput,
): Promise<{ readonly thread: Thread; readonly workItem: WorkItem }> {
  let workItem = await openWorkItem(exec, {
    tenantId: input.tenantId,
    open: {
      workItemId: input.workItemId,
      origin: 'thread',
      subjectRef: `thread:${input.threadId}`,
      purpose: 'member-message',
      risk: 'routine',
      serviceTier: input.serviceTier,
      slaPolicyId: input.slaPolicyId,
      policyVersion: input.policyVersion,
      responseDueAt: input.firstResponseDueAt,
      poolId: input.poolId,
      openedAt: input.openedAt,
    },
    actorRef: input.actorRef,
    firstResponseDueAt: input.firstResponseDueAt,
  });
  if (input.ownerRef !== null) {
    workItem = await appendEvents(exec, input.tenantId, input.workItemId, [
      {
        workItemId: input.workItemId,
        eventSeq: workItem.lastEventSeq + 1,
        eventType: 'assigned',
        occurredAt: input.openedAt,
        actorRef: input.actorRef,
        toOwnerRef: input.ownerRef,
        reason: 'assignment',
      },
    ]);
  }
  const thread = openThread({
    tenantId: input.tenantId,
    threadId: input.threadId,
    personRef: input.personRef,
    workItemId: input.workItemId,
    channel: 'sms',
    purpose: 'treatment',
    ownerRef: workItem.ownerRef,
  });
  await exec.query(
    `INSERT INTO comms.thread
       (tenant_id, thread_id, person_ref, work_item_ref, channel, purpose,
        owner_ref, escalated, status, synthetic)
     VALUES ($1, $2, $3, $4, 'sms', 'treatment', $5, false, 'open', true)`,
    [input.tenantId, input.threadId, input.personRef, input.workItemId, workItem.ownerRef],
  );
  return { thread, workItem };
}

/** Real row-locked claim for pooled work; real reassignment for owned escalation. */
export async function takeAccountableThread(
  exec: Queryable,
  input: {
    readonly thread: Thread;
    readonly toOwnerRef: string;
    readonly actorRef: string;
    readonly occurredAt: string;
    readonly contextPackage: ContextPackage;
  },
): Promise<WorkItem> {
  const locked = await exec.query(
    `SELECT work_item_ref, owner_ref, escalated, status
       FROM comms.thread
      WHERE tenant_id = $1 AND thread_id = $2
      FOR UPDATE`,
    [input.thread.tenantId, input.thread.threadId],
  );
  const current = locked.rows[0];
  if (
    current === undefined ||
    current['status'] !== 'open' ||
    current['work_item_ref'] !== input.thread.workItemId
  ) {
    throw new Error('live thread is closed, missing, or has mismatched WorkItem correlation');
  }
  const liveOwner = current['owner_ref'] === null ? null : String(current['owner_ref']);
  const liveEscalated = current['escalated'] === true;
  let workItem: WorkItem;
  if (liveOwner === null) {
    workItem = await claimWorkItem(exec, {
      tenantId: input.thread.tenantId,
      workItemId: input.thread.workItemId,
      toOwnerRef: input.toOwnerRef,
      actorRef: input.actorRef,
      occurredAt: input.occurredAt,
      contextPackage: input.contextPackage,
    });
  } else {
    if (!liveEscalated) throw new Error('an owned non-escalated thread is not claimable');
    workItem = await reassignWorkItem(exec, {
      tenantId: input.thread.tenantId,
      workItemId: input.thread.workItemId,
      toOwnerRef: input.toOwnerRef,
      actorRef: input.actorRef,
      occurredAt: input.occurredAt,
      reason: 'escalation',
      contextPackage: input.contextPackage,
    });
  }
  const updated = await exec.query(
    `UPDATE comms.thread SET owner_ref = $3
      WHERE tenant_id = $1 AND thread_id = $2 AND status = 'open'`,
    [input.thread.tenantId, input.thread.threadId, workItem.ownerRef],
  );
  if (updated.rowCount !== 1) {
    throw new Error('Thread projection update failed; caller must roll back the transaction');
  }
  return workItem;
}

export async function resolveAccountableThread(
  exec: Queryable,
  input: {
    readonly thread: Thread;
    readonly actorRef: string;
    readonly occurredAt: string;
    readonly disposition: string;
    readonly evidenceRef: string;
  },
): Promise<WorkItem> {
  if (input.disposition.trim() === '' || input.evidenceRef.trim() === '') {
    throw new Error('resolution requires disposition and evidence');
  }
  const item = await loadWorkItem(exec, input.thread.workItemId);
  if (item === null || item.status === 'resolved')
    throw new Error('WorkItem is missing or resolved');
  const resolved = await appendEvents(exec, input.thread.tenantId, item.workItemId, [
    {
      workItemId: item.workItemId,
      eventSeq: item.lastEventSeq + 1,
      eventType: 'resolved',
      occurredAt: input.occurredAt,
      actorRef: input.actorRef,
    },
  ]);
  const updated = await exec.query(
    `UPDATE comms.thread
        SET status = 'resolved', resolution_disposition = $3, resolution_evidence_ref = $4
      WHERE tenant_id = $1 AND thread_id = $2 AND work_item_ref = $5 AND status = 'open'`,
    [
      input.thread.tenantId,
      input.thread.threadId,
      input.disposition,
      input.evidenceRef,
      input.thread.workItemId,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new Error('Thread closure failed; caller must roll back the WorkItem resolution');
  }
  return resolved;
}

/**
 * Same-transaction idempotency fence for a holding message's task effects.
 * A replay with identical intent is a no-op; the same key with changed timer
 * intent is rejected. The caller transaction makes fence + WorkItem events one
 * commit, so a failure after the external effect can safely retry this step.
 */
export async function appendHoldingTaskEventsOnce(
  exec: Queryable,
  input: {
    readonly tenantId: string;
    readonly idempotencyKey: string;
    readonly events: readonly WorkItemEvent[];
    readonly createdAt: string;
  },
): Promise<'appended' | 'duplicate'> {
  const first = input.events[0];
  if (first === undefined) throw new Error('holding task event batch is empty');
  const intentHash = createHash('sha256').update(JSON.stringify(input.events)).digest('hex');
  const inserted = await exec.query(
    `INSERT INTO comms.holding_task_effect
       (tenant_id, idempotency_key, intent_hash, work_item_ref, created_at, synthetic)
     VALUES ($1,$2,$3,$4,$5,true)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING intent_hash`,
    [input.tenantId, input.idempotencyKey, intentHash, first.workItemId, input.createdAt],
  );
  if (inserted.rowCount === 1) {
    await appendEvents(exec, input.tenantId, first.workItemId, input.events);
    return 'appended';
  }
  const prior = await exec.query(
    `SELECT intent_hash, work_item_ref FROM comms.holding_task_effect
      WHERE tenant_id = $1 AND idempotency_key = $2`,
    [input.tenantId, input.idempotencyKey],
  );
  const row = prior.rows[0];
  if (
    row === undefined ||
    row['intent_hash'] !== intentHash ||
    row['work_item_ref'] !== first.workItemId
  ) {
    throw new Error('holding task idempotency key was reused with changed intent');
  }
  return 'duplicate';
}

import type { Queryable } from '@practicehub/events';

import {
  openThread,
  reconcileDelivery,
  recordMessage,
  ThreadError,
  type Thread,
  type ThreadMessage,
} from './thread.js';

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

function rowMessage(row: Record<string, unknown>): ThreadMessage {
  return {
    messageId: String(row['message_id']),
    direction: String(row['direction']) as ThreadMessage['direction'],
    contentRef: String(row['content_ref']),
    occurredAt: iso(row['occurred_at']),
    vendorEventKey: String(row['vendor_event_key']),
    effectKey: row['effect_key'] === null ? null : String(row['effect_key']),
    deliveryState: String(row['delivery_state']) as ThreadMessage['deliveryState'],
    holding: row['holding'] === true,
  };
}

export async function loadThread(
  exec: Queryable,
  tenantId: string,
  threadId: string,
): Promise<Thread | null> {
  const projection = await exec.query(
    `SELECT tenant_id, thread_id, person_ref, work_item_ref, channel, purpose,
            owner_ref, escalated, status, resolution_disposition, resolution_evidence_ref
       FROM comms.thread WHERE tenant_id = $1 AND thread_id = $2`,
    [tenantId, threadId],
  );
  const row = projection.rows[0];
  if (row === undefined) return null;
  const messageRows = await exec.query(
    `SELECT message_id, direction, content_ref, occurred_at, vendor_event_key,
            effect_key, delivery_state, holding
       FROM comms.thread_message
      WHERE tenant_id = $1 AND thread_id = $2
      ORDER BY occurred_at, message_id`,
    [tenantId, threadId],
  );
  const base = openThread({
    tenantId: String(row['tenant_id']),
    threadId: String(row['thread_id']),
    personRef: row['person_ref'] === null ? null : String(row['person_ref']),
    workItemId: String(row['work_item_ref']),
    channel: String(row['channel']) as Thread['channel'],
    purpose: String(row['purpose']) as Thread['purpose'],
    ownerRef: row['owner_ref'] === null ? null : String(row['owner_ref']),
    escalated: row['escalated'] === true,
  });
  return {
    ...base,
    status: String(row['status']) as Thread['status'],
    messages: messageRows.rows.map(rowMessage),
    resolutionDisposition:
      row['resolution_disposition'] === null ? null : String(row['resolution_disposition']),
    resolutionEvidenceRef:
      row['resolution_evidence_ref'] === null ? null : String(row['resolution_evidence_ref']),
  };
}

export async function appendThreadMessage(
  exec: Queryable,
  thread: Thread,
  message: ThreadMessage,
): Promise<Thread> {
  const projected = recordMessage(thread, message);
  if (projected === thread) return thread;
  await exec.query(
    `INSERT INTO comms.thread_message
       (tenant_id, thread_id, message_id, direction, content_ref, vendor_event_key,
        effect_key, delivery_state, holding, occurred_at, synthetic)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
    [
      thread.tenantId,
      thread.threadId,
      message.messageId,
      message.direction,
      message.contentRef,
      message.vendorEventKey,
      message.effectKey,
      message.deliveryState,
      message.holding,
      message.occurredAt,
    ],
  );
  return projected;
}

export async function applyDeliveryReceipt(
  exec: Queryable,
  thread: Thread,
  receipt: {
    readonly receiptId: string;
    readonly messageId: string;
    readonly messageVendorEventKey: string;
    readonly receiptEventKey: string;
    readonly effectKey: string;
    readonly outcome: 'accepted' | 'delivered' | 'failed' | null;
    readonly observedAt: string;
  },
): Promise<Thread> {
  const locked = await exec.query(
    `SELECT message_id, direction, content_ref, occurred_at, vendor_event_key,
            effect_key, delivery_state, holding
       FROM comms.thread_message
      WHERE tenant_id = $1 AND thread_id = $2 AND message_id = $3
      FOR UPDATE`,
    [thread.tenantId, thread.threadId, receipt.messageId],
  );
  const actualRow = locked.rows[0];
  if (actualRow === undefined) throw new ThreadError(`unknown message ${receipt.messageId}`);
  const actual = { ...thread, messages: [rowMessage(actualRow)] };
  reconcileDelivery(actual, { ...receipt, outcome: null });
  const mergeActual = (replacement: ThreadMessage): Thread => ({
    ...thread,
    messages: thread.messages.map((message) =>
      message.messageId === receipt.messageId ? replacement : message,
    ),
  });
  const currentMessage = actual.messages[0];
  if (currentMessage === undefined) throw new ThreadError('locked message disappeared');
  if (receipt.outcome === null) return mergeActual(currentMessage);
  const existing = await exec.query(
    `SELECT message_id, message_vendor_event_key, receipt_event_key,
            effect_key, outcome, observed_at
       FROM comms.delivery_receipt
      WHERE tenant_id = $1 AND receipt_id = $2`,
    [thread.tenantId, receipt.receiptId],
  );
  const prior = existing.rows[0];
  if (prior !== undefined) {
    const identical =
      prior['message_id'] === receipt.messageId &&
      prior['message_vendor_event_key'] === receipt.messageVendorEventKey &&
      prior['receipt_event_key'] === receipt.receiptEventKey &&
      prior['effect_key'] === receipt.effectKey &&
      prior['outcome'] === receipt.outcome &&
      Date.parse(iso(prior['observed_at'])) === Date.parse(receipt.observedAt);
    if (!identical) throw new ThreadError('receipt id was reused with changed payload');
    return mergeActual(currentMessage);
  }
  const projectedActual = reconcileDelivery(actual, receipt);
  const nextMessage = projectedActual.messages[0];
  if (nextMessage === undefined) throw new ThreadError('receipt projection lost its message');
  const projected = mergeActual(nextMessage);
  await exec.query(
    `INSERT INTO comms.delivery_receipt
       (tenant_id, receipt_id, message_id, message_vendor_event_key,
        receipt_event_key, effect_key,
        outcome, observed_at, synthetic)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)`,
    [
      thread.tenantId,
      receipt.receiptId,
      receipt.messageId,
      receipt.messageVendorEventKey,
      receipt.receiptEventKey,
      receipt.effectKey,
      receipt.outcome,
      receipt.observedAt,
    ],
  );
  await exec.query(
    `UPDATE comms.thread_message SET delivery_state = $3
      WHERE tenant_id = $1 AND message_id = $2`,
    [thread.tenantId, receipt.messageId, nextMessage.deliveryState],
  );
  return projected;
}

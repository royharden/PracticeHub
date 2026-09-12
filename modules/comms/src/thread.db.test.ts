import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { appendEvents, holdingReplyEvents } from '@practicehub/events';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { applyDeliveryReceipt } from './thread-store.js';
import { openThread, recordMessage } from './thread.js';
import {
  appendHoldingTaskEventsOnce,
  openAccountableThread,
  resolveAccountableThread,
  takeAccountableThread,
} from './workitem-consumer.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const host = process.env['PRACTICEHUB_DB_HOST'] ?? '127.0.0.1';
const port = Number(process.env['PRACTICEHUB_DB_PORT'] ?? '55432');
const owner = new Client({
  host,
  port,
  database: 'practicehub',
  user: 'practicehub',
  password: 'practicehub_synthetic_local',
});
const app = new Client({
  host,
  port,
  database: 'practicehub',
  user: 'practicehub_app',
  password: 'practicehub_app_synthetic_local',
});
const app2 = new Client({
  host,
  port,
  database: 'practicehub',
  user: 'practicehub_app',
  password: 'practicehub_app_synthetic_local',
});
const provisioning = [
  'infra/postgres/init/001-bootstrap.sql',
  'modules/platform-core/migrations/0001-tenancy.sql',
  'modules/events/migrations/0010-events.sql',
  'modules/events/migrations/0012-workitems.sql',
  'modules/comms/migrations/0018-thread.sql',
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/014-workitems-seed.sql',
];

beforeAll(async () => {
  await owner.connect();
  for (const path of provisioning) await owner.query(readFileSync(`${repoRoot}/${path}`, 'utf8'));
  await app.connect();
  await app2.connect();
});

afterAll(async () => {
  await app2.end();
  await app.end();
  await owner.end();
});

afterEach(async () => {
  await app.query('ROLLBACK').catch(() => undefined);
  await app2.query('ROLLBACK').catch(() => undefined);
  await owner.query(`DELETE FROM comms.delivery_receipt WHERE message_id LIKE 'db-%'`);
  await owner.query(`DELETE FROM comms.thread_message WHERE message_id LIKE 'db-%'`);
  await owner.query(`DELETE FROM comms.holding_task_effect WHERE work_item_ref LIKE 'db-%'`);
  await owner.query(`DELETE FROM comms.thread WHERE thread_id LIKE 'db-%'`);
  await owner.query(`DELETE FROM events.sla_timer WHERE work_item_id LIKE 'db-%'`);
  await owner.query(`DELETE FROM events.work_item_event WHERE work_item_id LIKE 'db-%'`);
  await owner.query(`DELETE FROM events.work_item WHERE work_item_id LIKE 'db-%'`);
});

async function begin(): Promise<void> {
  await app.query('BEGIN');
  await app.query(`SET LOCAL practicehub.tenant_id = 'northwind-synthetic'`);
}

async function beginOn(client: Client): Promise<void> {
  await client.query('BEGIN');
  await client.query(`SET LOCAL practicehub.tenant_id = 'northwind-synthetic'`);
}

describe('Thread database concurrency and idempotency', () => {
  it('locks live message state so a stale receipt cannot regress delivered', async () => {
    await begin();
    try {
      await app.query(`INSERT INTO comms.thread
        (tenant_id,thread_id,person_ref,work_item_ref,channel,purpose,owner_ref,escalated,status,synthetic)
        VALUES ('northwind-synthetic','db-thread-receipt','person-1','work-db-receipt','sms','treatment','guide-1',false,'open',true)`);
      await app.query(`INSERT INTO comms.thread_message
        (tenant_id,thread_id,message_id,direction,content_ref,vendor_event_key,effect_key,delivery_state,holding,occurred_at,synthetic)
        VALUES ('northwind-synthetic','db-thread-receipt','db-message-receipt','outbound','content:1','vendor-db-1','effect-db-1','unknown',false,'2026-09-12T14:00:00Z',true)`);
      const stale = recordMessage(
        openThread({
          tenantId: 'northwind-synthetic',
          threadId: 'db-thread-receipt',
          personRef: 'person-1',
          workItemId: 'work-db-receipt',
          channel: 'sms',
          purpose: 'treatment',
          ownerRef: 'guide-1',
        }),
        {
          messageId: 'db-message-receipt',
          direction: 'outbound',
          contentRef: 'content:1',
          occurredAt: '2026-09-12T14:00:00Z',
          vendorEventKey: 'vendor-db-1',
          effectKey: 'effect-db-1',
          holding: false,
        },
      );
      await applyDeliveryReceipt(app, stale, {
        receiptId: 'db-receipt-accepted',
        messageId: 'db-message-receipt',
        messageVendorEventKey: 'vendor-db-1',
        receiptEventKey: 'receipt-event-db-accepted',
        effectKey: 'effect-db-1',
        outcome: 'accepted',
        observedAt: '2026-09-12T14:01:00Z',
      });
      await applyDeliveryReceipt(app, stale, {
        receiptId: 'db-receipt-delivered',
        messageId: 'db-message-receipt',
        messageVendorEventKey: 'vendor-db-1',
        receiptEventKey: 'receipt-event-db-delivered',
        effectKey: 'effect-db-1',
        outcome: 'delivered',
        observedAt: '2026-09-12T14:01:30Z',
      });
      await applyDeliveryReceipt(app, stale, {
        receiptId: 'db-receipt-accepted',
        messageId: 'db-message-receipt',
        messageVendorEventKey: 'vendor-db-1',
        receiptEventKey: 'receipt-event-db-accepted',
        effectKey: 'effect-db-1',
        outcome: 'accepted',
        observedAt: '2026-09-12T14:01:00.000Z',
      });
      await expect(
        applyDeliveryReceipt(app, stale, {
          receiptId: 'db-receipt-late',
          messageId: 'db-message-receipt',
          messageVendorEventKey: 'vendor-db-1',
          receiptEventKey: 'receipt-event-db-late',
          effectKey: 'effect-db-1',
          outcome: 'accepted',
          observedAt: '2026-09-12T14:02:00Z',
        }),
      ).rejects.toThrow('regress a terminal');
      const receiptCount = await app.query(
        `SELECT count(*)::int AS count FROM comms.delivery_receipt
          WHERE message_id='db-message-receipt'`,
      );
      expect(receiptCount.rows[0]?.['count']).toBe(2);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('persists a same-transaction holding fence and refuses changed replay intent', async () => {
    await begin();
    try {
      const opened = await openAccountableThread(app, {
        tenantId: 'northwind-synthetic',
        threadId: 'db-thread-holding',
        personRef: 'person-1',
        workItemId: 'db-work-holding',
        ownerRef: 'guide-1',
        poolId: null,
        serviceTier: 'concierge',
        slaPolicyId: 'sla-concierge',
        policyVersion: 1,
        openedAt: '2026-09-12T14:00:00Z',
        firstResponseDueAt: '2026-09-12T15:00:00Z',
        actorRef: 'router-1',
      });
      const awaitingReply = await appendEvents(
        app,
        'northwind-synthetic',
        opened.workItem.workItemId,
        [
          {
            workItemId: opened.workItem.workItemId,
            eventSeq: opened.workItem.lastEventSeq + 1,
            eventType: 'inbound_received',
            occurredAt: '2026-09-12T14:04:00Z',
          },
          {
            workItemId: opened.workItem.workItemId,
            eventSeq: opened.workItem.lastEventSeq + 2,
            eventType: 'timer_started',
            occurredAt: '2026-09-12T14:04:00Z',
            timerType: 'next_response',
            dueAt: '2026-09-12T15:04:00Z',
          },
        ],
      );
      const events = holdingReplyEvents({
        workItemId: opened.workItem.workItemId,
        baseSeq: awaitingReply.lastEventSeq,
        occurredAt: '2026-09-12T14:05:00Z',
        actorRef: 'guide-1',
        resolutionDueAt: '2026-09-12T18:00:00Z',
      });
      const input = {
        tenantId: 'northwind-synthetic',
        idempotencyKey: 'holding-db-1',
        events,
        createdAt: '2026-09-12T14:05:00Z',
      };
      await expect(appendHoldingTaskEventsOnce(app, input)).resolves.toBe('appended');
      await expect(appendHoldingTaskEventsOnce(app, input)).resolves.toBe('duplicate');
      const changed = holdingReplyEvents({
        workItemId: opened.workItem.workItemId,
        baseSeq: awaitingReply.lastEventSeq,
        occurredAt: '2026-09-12T14:05:00Z',
        actorRef: 'guide-1',
        resolutionDueAt: '2026-09-12T20:00:00Z',
      });
      await expect(appendHoldingTaskEventsOnce(app, { ...input, events: changed })).rejects.toThrow(
        'changed intent',
      );
      const rows = await app.query(
        `SELECT count(*)::int AS count FROM comms.holding_task_effect WHERE idempotency_key='holding-db-1'`,
      );
      expect(rows.rows[0]?.['count']).toBe(1);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('serializes two claimers and resolves Thread plus WorkItem together', async () => {
    await begin();
    const opened = await openAccountableThread(app, {
      tenantId: 'northwind-synthetic',
      threadId: 'db-thread-race',
      personRef: 'person-1',
      workItemId: 'db-work-race',
      ownerRef: null,
      poolId: 'guide-pool',
      serviceTier: 'concierge',
      slaPolicyId: 'sla-concierge',
      policyVersion: 1,
      openedAt: '2026-09-12T14:00:00Z',
      firstResponseDueAt: '2026-09-12T15:00:00Z',
      actorRef: 'router-1',
    });
    await app.query('COMMIT');

    const context = { transcriptRef: 'transcript:db-thread-race', timerState: [] };
    await beginOn(app);
    const first = await takeAccountableThread(app, {
      thread: opened.thread,
      toOwnerRef: 'guide-1',
      actorRef: 'guide-1',
      occurredAt: '2026-09-12T14:01:00Z',
      contextPackage: context,
    });
    await beginOn(app2);
    const second = takeAccountableThread(app2, {
      thread: opened.thread,
      toOwnerRef: 'guide-2',
      actorRef: 'guide-2',
      occurredAt: '2026-09-12T14:01:00Z',
      contextPackage: context,
    });
    const beforeCommit = await Promise.race([
      second.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);
    expect(beforeCommit).toBe('blocked');
    await app.query('COMMIT');
    await expect(second).rejects.toThrow('non-escalated thread is not claimable');
    await app2.query('ROLLBACK');
    expect(first.ownerRef).toBe('guide-1');

    await beginOn(app);
    await resolveAccountableThread(app, {
      thread: { ...opened.thread, ownerRef: 'guide-1' },
      actorRef: 'guide-1',
      occurredAt: '2026-09-12T16:00:00Z',
      disposition: 'answered',
      evidenceRef: 'audit:db-race',
    });
    await app.query('COMMIT');
    const state = await owner.query(`SELECT t.status AS thread_status, w.status AS work_status
      FROM comms.thread t JOIN events.work_item w
        ON w.tenant_id=t.tenant_id AND w.work_item_id=t.work_item_ref
      WHERE t.thread_id='db-thread-race'`);
    expect(state.rows[0]).toMatchObject({ thread_status: 'resolved', work_status: 'resolved' });
  });

  it('survives a committed boundary with one immutable holding intent', async () => {
    await begin();
    const opened = await openAccountableThread(app, {
      tenantId: 'northwind-synthetic',
      threadId: 'db-thread-restart',
      personRef: 'person-1',
      workItemId: 'db-work-restart',
      ownerRef: 'guide-1',
      poolId: null,
      serviceTier: 'concierge',
      slaPolicyId: 'sla-concierge',
      policyVersion: 1,
      openedAt: '2026-09-12T14:00:00Z',
      firstResponseDueAt: '2026-09-12T15:00:00Z',
      actorRef: 'router-1',
    });
    const awaitingReply = await appendEvents(
      app,
      'northwind-synthetic',
      opened.workItem.workItemId,
      [
        {
          workItemId: opened.workItem.workItemId,
          eventSeq: opened.workItem.lastEventSeq + 1,
          eventType: 'inbound_received',
          occurredAt: '2026-09-12T14:04:00Z',
        },
        {
          workItemId: opened.workItem.workItemId,
          eventSeq: opened.workItem.lastEventSeq + 2,
          eventType: 'timer_started',
          occurredAt: '2026-09-12T14:04:00Z',
          timerType: 'next_response',
          dueAt: '2026-09-12T15:04:00Z',
        },
      ],
    );
    const events = holdingReplyEvents({
      workItemId: opened.workItem.workItemId,
      baseSeq: awaitingReply.lastEventSeq,
      occurredAt: '2026-09-12T14:05:00Z',
      actorRef: 'guide-1',
      resolutionDueAt: '2026-09-12T18:00:00Z',
    });
    const input = {
      tenantId: 'northwind-synthetic',
      idempotencyKey: 'holding-db-restart',
      events,
      createdAt: '2026-09-12T14:05:00Z',
    };
    await appendHoldingTaskEventsOnce(app, input);
    await app.query('COMMIT');

    const restarted = new Client({
      host,
      port,
      database: 'practicehub',
      user: 'practicehub_app',
      password: 'practicehub_app_synthetic_local',
    });
    await restarted.connect();
    await beginOn(restarted);
    await expect(appendHoldingTaskEventsOnce(restarted, input)).resolves.toBe('duplicate');
    const changed = holdingReplyEvents({
      workItemId: opened.workItem.workItemId,
      baseSeq: awaitingReply.lastEventSeq,
      occurredAt: '2026-09-12T14:05:00Z',
      actorRef: 'guide-1',
      resolutionDueAt: '2026-09-12T20:00:00Z',
    });
    await expect(
      appendHoldingTaskEventsOnce(restarted, { ...input, events: changed }),
    ).rejects.toThrow('changed intent');
    const persisted = await restarted.query(`SELECT
      (SELECT count(*)::int FROM comms.holding_task_effect WHERE idempotency_key='holding-db-restart') AS fence_count,
      (SELECT count(*)::int FROM events.work_item_event
        WHERE work_item_id='db-work-restart'
          AND (event_type IN ('holding_reply','timer_paused')
            OR (event_type='timer_started' AND timer_type='resolution'))) AS event_count,
      (SELECT count(*)::int FROM events.sla_timer
        WHERE work_item_id='db-work-restart' AND timer_type='resolution'
          AND due_at='2026-09-12T18:00:00Z') AS timer_count`);
    expect(persisted.rows[0]).toMatchObject({ fence_count: 1, event_count: 3, timer_count: 1 });
    await restarted.query('ROLLBACK');
    await restarted.end();
  });

  it('reassigns an owned escalated Thread with context and one owner', async () => {
    await begin();
    const opened = await openAccountableThread(app, {
      tenantId: 'northwind-synthetic',
      threadId: 'db-thread-escalated',
      personRef: 'person-1',
      workItemId: 'db-work-escalated',
      ownerRef: 'guide-1',
      poolId: null,
      serviceTier: 'concierge',
      slaPolicyId: 'sla-concierge',
      policyVersion: 1,
      openedAt: '2026-09-12T14:00:00Z',
      firstResponseDueAt: '2026-09-12T15:00:00Z',
      actorRef: 'router-1',
    });
    await appendEvents(app, 'northwind-synthetic', opened.workItem.workItemId, [
      {
        workItemId: opened.workItem.workItemId,
        eventSeq: opened.workItem.lastEventSeq + 1,
        eventType: 'escalated',
        occurredAt: '2026-09-12T15:00:00Z',
        escalationStep: 1,
        escalationAction: 'notify_supervisor',
        escalationTarget: 'supervisor-1',
      },
    ]);
    await app.query(`UPDATE comms.thread SET escalated=true
      WHERE tenant_id='northwind-synthetic' AND thread_id='db-thread-escalated'`);
    const reassigned = await takeAccountableThread(app, {
      thread: { ...opened.thread, escalated: true },
      toOwnerRef: 'guide-2',
      actorRef: 'supervisor-1',
      occurredAt: '2026-09-12T15:01:00Z',
      contextPackage: { transcriptRef: 'transcript:db-thread-escalated', timerState: [] },
    });
    await app.query('COMMIT');
    const projection =
      await owner.query(`SELECT t.owner_ref AS thread_owner, w.owner_ref AS work_owner,
      w.watchers FROM comms.thread t JOIN events.work_item w
        ON w.tenant_id=t.tenant_id AND w.work_item_id=t.work_item_ref
      WHERE t.thread_id='db-thread-escalated'`);
    expect(projection.rows[0]).toMatchObject({ thread_owner: 'guide-2', work_owner: 'guide-2' });
    expect(projection.rows[0]?.['watchers']).toContain('guide-1');
    expect(reassigned.ownerRef).toBe('guide-2');
  });

  it('rolls back upstream resolution when the Thread projection update fails', async () => {
    await begin();
    const opened = await openAccountableThread(app, {
      tenantId: 'northwind-synthetic',
      threadId: 'db-thread-rollback',
      personRef: 'person-1',
      workItemId: 'db-work-rollback',
      ownerRef: 'guide-1',
      poolId: null,
      serviceTier: 'concierge',
      slaPolicyId: 'sla-concierge',
      policyVersion: 1,
      openedAt: '2026-09-12T14:00:00Z',
      firstResponseDueAt: '2026-09-12T15:00:00Z',
      actorRef: 'router-1',
    });
    await app.query('COMMIT');

    await beginOn(app);
    await expect(
      resolveAccountableThread(app, {
        thread: { ...opened.thread, threadId: 'db-thread-missing' },
        actorRef: 'guide-1',
        occurredAt: '2026-09-12T16:00:00Z',
        disposition: 'answered',
        evidenceRef: 'audit:rollback',
      }),
    ).rejects.toThrow('roll back the WorkItem resolution');
    await app.query('ROLLBACK');
    const state = await owner.query(
      `SELECT status FROM events.work_item WHERE work_item_id='db-work-rollback'`,
    );
    expect(state.rows[0]?.['status']).toBe('open');
  });
});

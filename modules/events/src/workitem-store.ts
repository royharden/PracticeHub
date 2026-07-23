/**
 * WorkItem + SLA repository (WP-022, M05). Contract:
 * docs/contracts/workitem-sla-api.md (FROZEN). Binds the pure WorkItem / SLA
 * domain to the `events` schema over the same minimal `Queryable` the event
 * spine uses (a `pg` client or any transaction-bound executor — the caller owns
 * the transaction boundary, so the DB suite can drive a claim race and a
 * mid-transaction crash).
 *
 * Every mutation appends to the append-only work_item_event log and REFOLDS the
 * work_item + sla_timer projections from the full log in the same transaction —
 * the projection is a materialized read model, never a second source of truth
 * (the DB suite proves projection == fold). Ownership acceptance is single-owner
 * by construction; the claim race is resolved with a row lock (first claim wins,
 * REQ-TASK-029 E1).
 */

import type { Queryable } from './store.js';
import {
  assertPolicyValid,
  type EscalationAction,
  type SlaPolicy,
  type SlaTimer,
  type SlaTimerType,
} from './sla.js';
import {
  applyWorkItemEvent,
  foldTimers,
  foldWorkItem,
  holdingReplyEvents,
  initialWorkItem,
  isClaimable,
  type ContextPackage,
  type OwnershipReason,
  type WorkItem,
  type WorkItemEvent,
  type WorkItemEventType,
  type WorkItemOpen,
} from './workitem.js';
import { toWorklistEntry, prioritizeWorklist, type WorklistEntry } from './worklist.js';

export class WorkItemStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WorkItemStoreError';
  }
}

const iso = (value: unknown): string => {
  if (value instanceof Date) {
    return `${value.toISOString().slice(0, 19)}Z`;
  }
  return String(value);
};
const isoOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : iso(value);

/** SLA policies for a tenant (RLS scopes the read to the bound tenant). */
export async function loadSlaPolicies(exec: Queryable): Promise<readonly SlaPolicy[]> {
  const result = await exec.query(
    `SELECT policy_id, version, to_char(effective_on, 'YYYY-MM-DD') AS effective_on,
            member_tier, hours_mode, first_response_target_minutes, next_response_target_minutes,
            resolution_target_minutes, escalation_chain, quiet_hours_exempt
       FROM events.sla_policy`,
  );
  return result.rows.map((row) => {
    const policy: SlaPolicy = {
      policyId: String(row['policy_id']),
      version: Number(row['version']),
      effectiveOn: String(row['effective_on']),
      memberTier: String(row['member_tier']),
      hoursMode: row['hours_mode'] as SlaPolicy['hoursMode'],
      firstResponseTargetMinutes: Number(row['first_response_target_minutes']),
      nextResponseTargetMinutes: Number(row['next_response_target_minutes']),
      resolutionTargetMinutes:
        row['resolution_target_minutes'] === null ? null : Number(row['resolution_target_minutes']),
      escalationChain: row['escalation_chain'] as SlaPolicy['escalationChain'],
      quietHoursExempt: Boolean(row['quiet_hours_exempt']),
    };
    assertPolicyValid(policy);
    return policy;
  });
}

function openFromRow(row: Record<string, unknown>): WorkItemOpen {
  return {
    workItemId: String(row['work_item_id']),
    origin: row['origin'] as WorkItemOpen['origin'],
    ...(row['subject_ref'] === null ? {} : { subjectRef: String(row['subject_ref']) }),
    purpose: String(row['purpose']),
    risk: row['risk'] as WorkItemOpen['risk'],
    serviceTier: String(row['service_tier']),
    slaPolicyId: row['sla_policy_id'] === null ? null : String(row['sla_policy_id']),
    policyVersion: row['policy_version'] === null ? null : Number(row['policy_version']),
    responseDueAt: isoOrNull(row['response_due_at']),
    poolId: row['pool_id'] === null ? null : String(row['pool_id']),
    openedAt: iso(row['opened_at']),
  };
}

function eventFromRow(row: Record<string, unknown>): WorkItemEvent {
  const dueAt = isoOrNull(row['due_at']);
  return {
    workItemId: String(row['work_item_id']),
    eventSeq: Number(row['event_seq']),
    eventType: row['event_type'] as WorkItemEventType,
    occurredAt: iso(row['occurred_at']),
    ...(row['actor_ref'] === null ? {} : { actorRef: String(row['actor_ref']) }),
    ...(row['from_owner_ref'] === null ? {} : { fromOwnerRef: String(row['from_owner_ref']) }),
    ...(row['to_owner_ref'] === null ? {} : { toOwnerRef: String(row['to_owner_ref']) }),
    ...(row['reason'] === null ? {} : { reason: row['reason'] as OwnershipReason }),
    ...(row['timer_type'] === null ? {} : { timerType: row['timer_type'] as SlaTimerType }),
    ...(dueAt === null ? {} : { dueAt }),
    ...(row['escalation_step'] === null ? {} : { escalationStep: Number(row['escalation_step']) }),
    ...(row['escalation_action'] === null
      ? {}
      : { escalationAction: String(row['escalation_action']) }),
    ...(row['escalation_target'] === null
      ? {}
      : { escalationTarget: String(row['escalation_target']) }),
    ...(row['context_package'] === null
      ? {}
      : { contextPackage: row['context_package'] as ContextPackage }),
    ...(row['watcher_ref'] === null ? {} : { watcherRef: String(row['watcher_ref']) }),
  };
}

/** The full ordered event log for one work item (seq ascending). */
export async function loadWorkItemLog(
  exec: Queryable,
  workItemId: string,
): Promise<readonly WorkItemEvent[]> {
  const result = await exec.query(
    `SELECT * FROM events.work_item_event WHERE work_item_id = $1 ORDER BY event_seq`,
    [workItemId],
  );
  return result.rows.map(eventFromRow);
}

async function loadOpen(exec: Queryable, workItemId: string): Promise<WorkItemOpen | null> {
  const result = await exec.query(`SELECT * FROM events.work_item WHERE work_item_id = $1`, [
    workItemId,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : openFromRow(row);
}

/** Load the folded WorkItem projection (materialized), or null. */
export async function loadWorkItem(exec: Queryable, workItemId: string): Promise<WorkItem | null> {
  const open = await loadOpen(exec, workItemId);
  if (open === null) {
    return null;
  }
  return foldWorkItem(open, await loadWorkItemLog(exec, workItemId));
}

export async function loadTimers(
  exec: Queryable,
  workItemId: string,
): Promise<readonly SlaTimer[]> {
  return foldTimers(await loadWorkItemLog(exec, workItemId));
}

const eventColumns = [
  'tenant_id',
  'work_item_id',
  'event_seq',
  'event_type',
  'occurred_at',
  'actor_ref',
  'from_owner_ref',
  'to_owner_ref',
  'reason',
  'timer_type',
  'due_at',
  'escalation_step',
  'escalation_action',
  'escalation_target',
  'context_package',
  'watcher_ref',
  'synthetic',
] as const;

async function insertEvent(exec: Queryable, tenantId: string, event: WorkItemEvent): Promise<void> {
  const params: unknown[] = [
    tenantId,
    event.workItemId,
    event.eventSeq,
    event.eventType,
    event.occurredAt,
    event.actorRef ?? null,
    event.fromOwnerRef ?? null,
    event.toOwnerRef ?? null,
    event.reason ?? null,
    event.timerType ?? null,
    event.dueAt ?? null,
    event.escalationStep ?? null,
    event.escalationAction ?? null,
    event.escalationTarget ?? null,
    event.contextPackage === undefined ? null : JSON.stringify(event.contextPackage),
    event.watcherRef ?? null,
    true,
  ];
  const placeholders = params.map((_unused, index) => `$${index + 1}`).join(', ');
  await exec.query(
    `INSERT INTO events.work_item_event (${eventColumns.join(', ')}) VALUES (${placeholders})`,
    params,
  );
}

async function writeProjection(exec: Queryable, tenantId: string, item: WorkItem): Promise<void> {
  await exec.query(
    `INSERT INTO events.work_item
       (tenant_id, work_item_id, origin, subject_ref, purpose, risk, service_tier,
        sla_policy_id, policy_version, has_sla, status, priority, owner_ref, pool_id,
        watchers, escalated, opened_at, response_due_at, first_owned_at, last_event_seq, synthetic)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,true)
     ON CONFLICT (tenant_id, work_item_id) DO UPDATE
        SET status = EXCLUDED.status, priority = EXCLUDED.priority, owner_ref = EXCLUDED.owner_ref,
            pool_id = EXCLUDED.pool_id, watchers = EXCLUDED.watchers, escalated = EXCLUDED.escalated,
            first_owned_at = EXCLUDED.first_owned_at, last_event_seq = EXCLUDED.last_event_seq`,
    [
      tenantId,
      item.workItemId,
      item.origin,
      item.subjectRef,
      item.purpose,
      item.risk,
      item.serviceTier,
      item.slaPolicyId,
      item.policyVersion,
      item.hasSla,
      item.status,
      item.priority,
      item.ownerRef,
      item.poolId,
      JSON.stringify(item.watchers),
      item.escalated,
      item.openedAt,
      item.responseDueAt,
      item.firstOwnedAt,
      item.lastEventSeq,
    ],
  );
}

// The projection's last_event_seq is the item's; each timer row records the same
// high-water mark so a stale projection is detectable. Timers fold from the same
// log, so the item's lastEventSeq is authoritative for all of them.
async function writeTimers(
  exec: Queryable,
  tenantId: string,
  workItemId: string,
  timers: readonly SlaTimer[],
  lastEventSeq: number,
): Promise<void> {
  for (const timer of timers) {
    await exec.query(
      `INSERT INTO events.sla_timer
         (tenant_id, work_item_id, timer_type, started_at, due_at, paused_total_seconds,
          state, last_event_seq, synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
       ON CONFLICT (tenant_id, work_item_id, timer_type) DO UPDATE
          SET started_at = EXCLUDED.started_at, due_at = EXCLUDED.due_at,
              paused_total_seconds = EXCLUDED.paused_total_seconds, state = EXCLUDED.state,
              last_event_seq = EXCLUDED.last_event_seq`,
      [
        tenantId,
        workItemId,
        timer.timerType,
        timer.startedAt,
        timer.dueAt,
        Math.round(timer.pausedTotalSeconds),
        timer.state,
        lastEventSeq,
      ],
    );
  }
}

/**
 * Open a new work item: insert the initial projection row, then append the
 * `opened` (and optional `queued` / first-response `timer_started`) events, and
 * refold. Returns the folded WorkItem.
 */
export async function openWorkItem(
  exec: Queryable,
  input: {
    readonly tenantId: string;
    readonly open: WorkItemOpen;
    readonly actorRef?: string;
    /** Start the unmatched first-touch first_response timer (gate: unmatched first-touch). */
    readonly firstResponseDueAt?: string;
  },
): Promise<WorkItem> {
  const initial = initialWorkItem(input.open);
  await writeProjection(exec, input.tenantId, initial);
  const events: WorkItemEvent[] = [
    {
      workItemId: input.open.workItemId,
      eventSeq: 1,
      eventType: 'opened',
      occurredAt: input.open.openedAt,
      ...(input.actorRef === undefined ? {} : { actorRef: input.actorRef }),
    },
    {
      workItemId: input.open.workItemId,
      eventSeq: 2,
      eventType: 'queued',
      occurredAt: input.open.openedAt,
    },
  ];
  if (input.firstResponseDueAt !== undefined) {
    events.push({
      workItemId: input.open.workItemId,
      eventSeq: 3,
      eventType: 'timer_started',
      occurredAt: input.open.openedAt,
      timerType: 'first_response',
      dueAt: input.firstResponseDueAt,
    });
  }
  return appendEvents(exec, input.tenantId, input.open.workItemId, events);
}

/**
 * Append a batch of pre-built, contiguous events and refold. The batch must
 * start at the item's current lastEventSeq + 1 (validated by applyWorkItemEvent).
 * Refolds work_item + sla_timer projections from the FULL log in the same
 * transaction.
 */
export async function appendEvents(
  exec: Queryable,
  tenantId: string,
  workItemId: string,
  events: readonly WorkItemEvent[],
): Promise<WorkItem> {
  const open = await loadOpen(exec, workItemId);
  if (open === null) {
    throw new WorkItemStoreError(`work item ${workItemId} does not exist`);
  }
  const existing = await loadWorkItemLog(exec, workItemId);
  // Validate the batch folds cleanly onto the current state before writing.
  let projected = foldWorkItem(open, existing);
  for (const event of events) {
    projected = applyWorkItemEvent(projected, event);
  }
  for (const event of events) {
    await insertEvent(exec, tenantId, event);
  }
  const fullLog = [...existing, ...events];
  const item = foldWorkItem(open, fullLog);
  await writeProjection(exec, tenantId, item);
  await writeTimers(exec, tenantId, workItemId, foldTimers(fullLog), item.lastEventSeq);
  return item;
}

/**
 * Claim an unowned work item (REQ-TASK-029 E1). Locks the projection row FOR
 * UPDATE; if it already has an owner, the claim is refused ("already claimed") —
 * the first concurrent claim wins, no split ownership. Otherwise appends a
 * `claimed` event carrying the context package and refolds.
 */
export async function claimWorkItem(
  exec: Queryable,
  input: {
    readonly tenantId: string;
    readonly workItemId: string;
    readonly toOwnerRef: string;
    readonly actorRef: string;
    readonly occurredAt: string;
    readonly contextPackage: ContextPackage;
    readonly reason?: 'claim' | 'escalation';
  },
): Promise<WorkItem> {
  const locked = await exec.query(
    `SELECT owner_ref, status, last_event_seq FROM events.work_item
       WHERE work_item_id = $1 FOR UPDATE`,
    [input.workItemId],
  );
  const row = locked.rows[0];
  if (row === undefined) {
    throw new WorkItemStoreError(`work item ${input.workItemId} does not exist`);
  }
  const item = await loadWorkItem(exec, input.workItemId);
  if (item === null || !isClaimable(item)) {
    throw new WorkItemStoreError(
      `work item ${input.workItemId} is already claimed by ${String(row['owner_ref'])}`,
    );
  }
  const event: WorkItemEvent = {
    workItemId: input.workItemId,
    eventSeq: item.lastEventSeq + 1,
    eventType: 'claimed',
    occurredAt: input.occurredAt,
    actorRef: input.actorRef,
    ...(item.ownerRef === null ? {} : { fromOwnerRef: item.ownerRef }),
    toOwnerRef: input.toOwnerRef,
    reason: input.reason ?? 'claim',
    contextPackage: input.contextPackage,
  };
  return appendEvents(exec, input.tenantId, input.workItemId, [event]);
}

/**
 * Reassign an owned work item to a new owner with a context package (R8 §5.5 /
 * REQ-TASK-029 A2–A4). The prior owner is demoted to a watcher by the fold.
 */
export async function reassignWorkItem(
  exec: Queryable,
  input: {
    readonly tenantId: string;
    readonly workItemId: string;
    readonly toOwnerRef: string;
    readonly actorRef: string;
    readonly occurredAt: string;
    readonly reason: WorkItemEvent['reason'];
    readonly contextPackage: ContextPackage;
  },
): Promise<WorkItem> {
  const item = await loadWorkItem(exec, input.workItemId);
  if (item === null) {
    throw new WorkItemStoreError(`work item ${input.workItemId} does not exist`);
  }
  const event: WorkItemEvent = {
    workItemId: input.workItemId,
    eventSeq: item.lastEventSeq + 1,
    eventType: 'reassigned',
    occurredAt: input.occurredAt,
    actorRef: input.actorRef,
    ...(item.ownerRef === null ? {} : { fromOwnerRef: item.ownerRef }),
    toOwnerRef: input.toOwnerRef,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    contextPackage: input.contextPackage,
  };
  return appendEvents(exec, input.tenantId, input.workItemId, [event]);
}

/**
 * Record a teammate's holding reply (REQ-TASK-029 A1): pauses next_response,
 * starts the resolution timer. Does NOT change owner (E2).
 */
export async function recordHoldingReply(
  exec: Queryable,
  input: {
    readonly tenantId: string;
    readonly workItemId: string;
    readonly actorRef: string;
    readonly occurredAt: string;
    readonly resolutionDueAt: string;
  },
): Promise<WorkItem> {
  const item = await loadWorkItem(exec, input.workItemId);
  if (item === null) {
    throw new WorkItemStoreError(`work item ${input.workItemId} does not exist`);
  }
  const events = holdingReplyEvents({
    workItemId: input.workItemId,
    baseSeq: item.lastEventSeq,
    occurredAt: input.occurredAt,
    actorRef: input.actorRef,
    resolutionDueAt: input.resolutionDueAt,
  });
  return appendEvents(exec, input.tenantId, input.workItemId, events);
}

/**
 * Build a Guide's prioritized worklist from the live projections (REQ-TASK-019).
 * `ownerRef` scopes to one Guide's items; omit for a supervisor's monitor view
 * (A4). Loads each item's timers and applies the total order.
 */
export async function buildWorklist(
  exec: Queryable,
  input: { readonly nowIso: string; readonly ownerRef?: string },
): Promise<readonly WorklistEntry[]> {
  const rows =
    input.ownerRef === undefined
      ? (await exec.query(`SELECT work_item_id FROM events.work_item WHERE status <> 'resolved'`))
          .rows
      : (
          await exec.query(
            `SELECT work_item_id FROM events.work_item WHERE status <> 'resolved' AND owner_ref = $1`,
            [input.ownerRef],
          )
        ).rows;
  const entries: WorklistEntry[] = [];
  for (const row of rows) {
    const workItemId = String(row['work_item_id']);
    const item = await loadWorkItem(exec, workItemId);
    if (item === null) {
      continue;
    }
    entries.push(toWorklistEntry(item, await loadTimers(exec, workItemId), input.nowIso));
  }
  return prioritizeWorklist(entries);
}

/** Escalation-step firing helper: the events an escalation writes (R8 §5.5). */
export function escalationEvents(input: {
  readonly workItemId: string;
  readonly baseSeq: number;
  readonly occurredAt: string;
  readonly steps: readonly {
    readonly stepIndex: number;
    readonly action: EscalationAction;
    readonly target: string;
  }[];
}): readonly WorkItemEvent[] {
  return input.steps.map((step, offset) => ({
    workItemId: input.workItemId,
    eventSeq: input.baseSeq + offset + 1,
    eventType: 'escalated' as const,
    occurredAt: input.occurredAt,
    escalationStep: step.stepIndex,
    escalationAction: step.action,
    escalationTarget: step.target,
  }));
}

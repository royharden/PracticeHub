/**
 * Synthetic WorkItem + SLA seed data of record (WP-022). The committed seed file
 * `infra/postgres/seed/014-workitems-seed.sql` embeds `renderWorkItemsSeedSection`
 * output between the workitems markers — a drift test compares the file against a
 * fresh emission, and the DB suite re-checks the postures against live Postgres.
 *
 * The work_item + sla_timer projections are computed HERE by folding each item's
 * committed event log (foldWorkItem / foldTimers) — one data source, so the seed
 * can never disagree with the fold (the DB projection-sync probe re-proves it).
 *
 * Standing proofs (Northwind):
 * - the William scenario (R8 §5.5): an owned SMS-thread WorkItem breaches, the
 *   escalation chain fires in order (owner+supervisor at target, hard-escalate at
 *   5h), a teammate's holding reply PAUSES the next_response timer and starts a
 *   resolution timer, and the thread is reassigned with a context package — the
 *   prior owner demoted to a watcher, single-owner preserved;
 * - an UNMATCHED first-touch WorkItem (unowned, first_response timer running);
 * - the origin taxonomy: an obligation-clock-sourced WorkItem (FWD-CLOCK-022) and
 *   a merge-review-sourced WorkItem (FWD-MERGE-022) proving the engine surfaces
 *   upstream domains as SLA-timed WorkItems;
 * - a non-SLA admin task (REQ-TASK-019 E1: it sorts below SLA-bearing items).
 * Riverbend carries one pooled, unowned WorkItem as the cross-tenant negative.
 */

import {
  foldTimers,
  foldWorkItem,
  type ContextPackage,
  type WorkItem,
  type WorkItemEvent,
  type WorkItemOpen,
} from './workitem.js';
import type { EscalationStep, SlaTimer } from './sla.js';

const northwind = 'northwind-synthetic';
const riverbend = 'riverbend-synthetic';

export interface SlaPolicySeed {
  readonly tenantId: string;
  readonly policyId: string;
  readonly version: number;
  readonly effectiveOn: string;
  readonly memberTier: string;
  readonly hoursMode: 'business' | 'after_hours';
  readonly firstResponseTargetMinutes: number;
  readonly nextResponseTargetMinutes: number;
  readonly resolutionTargetMinutes: number | null;
  readonly escalationChain: readonly EscalationStep[];
  readonly quietHoursExempt: boolean;
  readonly changeControlRef: string;
}

const conciergeChain: readonly EscalationStep[] = [
  { afterMinutes: 60, action: 'notify_owner', target: 'synthetic-role:owner' },
  { afterMinutes: 60, action: 'notify_supervisor', target: 'synthetic-supervisor:pod-a' },
  { afterMinutes: 300, action: 'notify_supervisor', target: 'synthetic-supervisor:pod-a' },
  { afterMinutes: 300, action: 'mark_priority_high', target: 'synthetic-escalation-queue:pod-a' },
];

export const slaPolicySeeds: readonly SlaPolicySeed[] = [
  {
    tenantId: northwind,
    policyId: 'sla-concierge',
    version: 1,
    effectiveOn: '2026-01-01',
    memberTier: 'concierge',
    hoursMode: 'after_hours',
    firstResponseTargetMinutes: 60,
    nextResponseTargetMinutes: 60,
    resolutionTargetMinutes: 240,
    escalationChain: conciergeChain,
    quietHoursExempt: true,
    changeControlRef: 'wp-022-sla-concierge-v1',
  },
  {
    tenantId: northwind,
    policyId: 'sla-employer',
    version: 1,
    effectiveOn: '2026-01-01',
    memberTier: 'employer-sponsored',
    hoursMode: 'business',
    firstResponseTargetMinutes: 120,
    nextResponseTargetMinutes: 120,
    resolutionTargetMinutes: 480,
    escalationChain: [
      { afterMinutes: 120, action: 'notify_owner', target: 'synthetic-role:owner' },
      { afterMinutes: 240, action: 'notify_supervisor', target: 'synthetic-supervisor:pod-a' },
    ],
    quietHoursExempt: false,
    changeControlRef: 'wp-022-sla-employer-v1',
  },
  {
    tenantId: northwind,
    policyId: 'sla-non-member',
    version: 1,
    effectiveOn: '2026-01-01',
    memberTier: 'non-member',
    hoursMode: 'business',
    firstResponseTargetMinutes: 240,
    nextResponseTargetMinutes: 240,
    resolutionTargetMinutes: null,
    escalationChain: [
      { afterMinutes: 240, action: 'notify_supervisor', target: 'synthetic-supervisor:pod-b' },
    ],
    quietHoursExempt: false,
    changeControlRef: 'wp-022-sla-non-member-v1',
  },
];

interface WorkItemSeed {
  readonly tenantId: string;
  readonly open: WorkItemOpen;
  readonly log: readonly WorkItemEvent[];
}

const williamContext: ContextPackage = {
  transcriptRef: 'synthetic-transcript:th-william-0001',
  patientSummaryRef: 'synthetic-summary:np-parker-vale',
  openOrders: ['synthetic-order:vo2-panel'],
  priorOwnerNotesRef: 'synthetic-note:william-handoff-0001',
  timerState: [],
  consentFlags: ['sms/treatment:opted_in'],
};

// The William standing scenario as an ordered event log (R8 §5.5). Business/
// coverage hours, no pauses until the holding reply — so the breach is honest.
const williamLog: readonly WorkItemEvent[] = [
  {
    workItemId: 'wi-thread-william-0001',
    eventSeq: 1,
    eventType: 'opened',
    occurredAt: '2026-03-02T08:00:00Z',
    actorRef: 'synthetic-system:router',
  },
  {
    workItemId: 'wi-thread-william-0001',
    eventSeq: 2,
    eventType: 'queued',
    occurredAt: '2026-03-02T08:00:00Z',
  },
  {
    workItemId: 'wi-thread-william-0001',
    eventSeq: 3,
    eventType: 'inbound_received',
    occurredAt: '2026-03-02T08:00:00Z',
  },
  {
    workItemId: 'wi-thread-william-0001',
    eventSeq: 4,
    eventType: 'timer_started',
    occurredAt: '2026-03-02T08:00:00Z',
    timerType: 'next_response',
    dueAt: '2026-03-02T09:00:00Z',
  },
  {
    workItemId: 'wi-thread-william-0001',
    eventSeq: 5,
    eventType: 'assigned',
    occurredAt: '2026-03-02T08:02:00Z',
    actorRef: 'synthetic-guide:william',
    toOwnerRef: 'synthetic-guide:william',
    reason: 'assignment',
  },
  {
    workItemId: 'wi-thread-william-0001',
    eventSeq: 6,
    eventType: 'timer_breached',
    occurredAt: '2026-03-02T09:00:00Z',
    timerType: 'next_response',
  },
  {
    workItemId: 'wi-thread-william-0001',
    eventSeq: 7,
    eventType: 'escalated',
    occurredAt: '2026-03-02T09:00:00Z',
    escalationStep: 0,
    escalationAction: 'notify_owner',
    escalationTarget: 'synthetic-guide:william',
  },
  {
    workItemId: 'wi-thread-william-0001',
    eventSeq: 8,
    eventType: 'watcher_added',
    occurredAt: '2026-03-02T09:00:00Z',
    watcherRef: 'synthetic-supervisor:pod-a',
  },
  {
    workItemId: 'wi-thread-william-0001',
    eventSeq: 9,
    eventType: 'escalated',
    occurredAt: '2026-03-02T09:00:00Z',
    escalationStep: 1,
    escalationAction: 'notify_supervisor',
    escalationTarget: 'synthetic-supervisor:pod-a',
  },
  {
    workItemId: 'wi-thread-william-0001',
    eventSeq: 10,
    eventType: 'escalated',
    occurredAt: '2026-03-02T13:00:00Z',
    escalationStep: 2,
    escalationAction: 'notify_supervisor',
    escalationTarget: 'synthetic-supervisor:pod-a',
  },
  {
    workItemId: 'wi-thread-william-0001',
    eventSeq: 11,
    eventType: 'escalated',
    occurredAt: '2026-03-02T13:00:00Z',
    escalationStep: 3,
    escalationAction: 'mark_priority_high',
    escalationTarget: 'synthetic-escalation-queue:pod-a',
  },
  {
    workItemId: 'wi-thread-william-0001',
    eventSeq: 12,
    eventType: 'holding_reply',
    occurredAt: '2026-03-02T13:10:00Z',
    actorRef: 'synthetic-guide:maya',
  },
  {
    workItemId: 'wi-thread-william-0001',
    eventSeq: 13,
    eventType: 'timer_paused',
    occurredAt: '2026-03-02T13:10:00Z',
    timerType: 'next_response',
  },
  {
    workItemId: 'wi-thread-william-0001',
    eventSeq: 14,
    eventType: 'timer_started',
    occurredAt: '2026-03-02T13:10:00Z',
    timerType: 'resolution',
    dueAt: '2026-03-02T17:10:00Z',
  },
  {
    workItemId: 'wi-thread-william-0001',
    eventSeq: 15,
    eventType: 'reassigned',
    occurredAt: '2026-03-02T13:15:00Z',
    actorRef: 'synthetic-supervisor:pod-a',
    fromOwnerRef: 'synthetic-guide:william',
    toOwnerRef: 'synthetic-guide:maya',
    reason: 'escalation',
    contextPackage: williamContext,
  },
];

const workItemSeeds: readonly WorkItemSeed[] = [
  {
    tenantId: northwind,
    open: {
      workItemId: 'wi-thread-william-0001',
      origin: 'thread',
      subjectRef: 'thread:th-william-0001',
      purpose: 'member-message',
      risk: 'routine',
      serviceTier: 'concierge',
      slaPolicyId: 'sla-concierge',
      policyVersion: 1,
      responseDueAt: '2026-03-02T09:00:00Z',
      poolId: null,
      openedAt: '2026-03-02T08:00:00Z',
    },
    log: williamLog,
  },
  {
    // Unmatched first-touch: an inbound with no owner and a running first_response
    // timer — the gate's "unmatched first-touch timer" standing proof.
    tenantId: northwind,
    open: {
      workItemId: 'wi-thread-unmatched-0002',
      origin: 'thread',
      subjectRef: 'thread:th-unmatched-0002',
      purpose: 'member-message',
      risk: 'routine',
      serviceTier: 'concierge',
      slaPolicyId: 'sla-concierge',
      policyVersion: 1,
      responseDueAt: '2026-03-03T09:00:00Z',
      poolId: 'synthetic-pool:front-desk',
      openedAt: '2026-03-03T08:00:00Z',
    },
    log: [
      {
        workItemId: 'wi-thread-unmatched-0002',
        eventSeq: 1,
        eventType: 'opened',
        occurredAt: '2026-03-03T08:00:00Z',
        actorRef: 'synthetic-system:router',
      },
      {
        workItemId: 'wi-thread-unmatched-0002',
        eventSeq: 2,
        eventType: 'queued',
        occurredAt: '2026-03-03T08:00:00Z',
      },
      {
        workItemId: 'wi-thread-unmatched-0002',
        eventSeq: 3,
        eventType: 'inbound_received',
        occurredAt: '2026-03-03T08:00:00Z',
      },
      {
        workItemId: 'wi-thread-unmatched-0002',
        eventSeq: 4,
        eventType: 'timer_started',
        occurredAt: '2026-03-03T08:00:00Z',
        timerType: 'first_response',
        dueAt: '2026-03-03T09:00:00Z',
      },
    ],
  },
  {
    // Obligation-clock origin (FWD-CLOCK-022-WORKITEMS): the MHRA renewal clock
    // surfaced as an owned, SLA-timed WorkItem.
    tenantId: northwind,
    open: {
      workItemId: 'wi-clock-mhra-0003',
      origin: 'obligation-clock',
      subjectRef: 'clock:ncl-mhra-0001',
      purpose: 'consent-renewal',
      risk: 'elevated',
      serviceTier: 'employer-sponsored',
      slaPolicyId: 'sla-employer',
      policyVersion: 1,
      responseDueAt: '2026-03-04T10:00:00Z',
      poolId: null,
      openedAt: '2026-03-04T08:00:00Z',
    },
    log: [
      {
        workItemId: 'wi-clock-mhra-0003',
        eventSeq: 1,
        eventType: 'opened',
        occurredAt: '2026-03-04T08:00:00Z',
        actorRef: 'synthetic-system:clock-engine',
      },
      {
        workItemId: 'wi-clock-mhra-0003',
        eventSeq: 2,
        eventType: 'queued',
        occurredAt: '2026-03-04T08:00:00Z',
      },
      {
        workItemId: 'wi-clock-mhra-0003',
        eventSeq: 3,
        eventType: 'timer_started',
        occurredAt: '2026-03-04T08:00:00Z',
        timerType: 'first_response',
        dueAt: '2026-03-04T10:00:00Z',
      },
      {
        workItemId: 'wi-clock-mhra-0003',
        eventSeq: 4,
        eventType: 'assigned',
        occurredAt: '2026-03-04T08:30:00Z',
        actorRef: 'synthetic-guide:noor',
        toOwnerRef: 'synthetic-guide:noor',
        reason: 'assignment',
      },
    ],
  },
  {
    // Merge-review origin (FWD-MERGE-022-TASKS): a wrong-merge harm review as a
    // pooled, unclaimed WorkItem awaiting an owner.
    tenantId: northwind,
    open: {
      workItemId: 'wi-merge-review-0004',
      origin: 'merge-review',
      subjectRef: 'merge-case:mc-0007',
      purpose: 'identity-harm-review',
      risk: 'critical',
      serviceTier: 'concierge',
      slaPolicyId: 'sla-concierge',
      policyVersion: 1,
      responseDueAt: '2026-03-05T09:00:00Z',
      poolId: 'synthetic-pool:identity-governance',
      openedAt: '2026-03-05T08:00:00Z',
    },
    log: [
      {
        workItemId: 'wi-merge-review-0004',
        eventSeq: 1,
        eventType: 'opened',
        occurredAt: '2026-03-05T08:00:00Z',
        actorRef: 'synthetic-system:merge-governance',
      },
      {
        workItemId: 'wi-merge-review-0004',
        eventSeq: 2,
        eventType: 'queued',
        occurredAt: '2026-03-05T08:00:00Z',
      },
      {
        workItemId: 'wi-merge-review-0004',
        eventSeq: 3,
        eventType: 'timer_started',
        occurredAt: '2026-03-05T08:00:00Z',
        timerType: 'first_response',
        dueAt: '2026-03-05T09:00:00Z',
      },
    ],
  },
  {
    // Non-SLA admin task (REQ-TASK-019 E1): no policy attached, sorts below all
    // SLA-bearing items.
    tenantId: northwind,
    open: {
      workItemId: 'wi-admin-0005',
      origin: 'admin',
      purpose: 'inventory-count',
      risk: 'routine',
      serviceTier: 'internal',
      slaPolicyId: null,
      policyVersion: null,
      responseDueAt: null,
      poolId: null,
      openedAt: '2026-03-01T08:00:00Z',
    },
    log: [
      {
        workItemId: 'wi-admin-0005',
        eventSeq: 1,
        eventType: 'opened',
        occurredAt: '2026-03-01T08:00:00Z',
        actorRef: 'synthetic-guide:noor',
      },
      {
        workItemId: 'wi-admin-0005',
        eventSeq: 2,
        eventType: 'assigned',
        occurredAt: '2026-03-01T08:00:00Z',
        actorRef: 'synthetic-guide:noor',
        toOwnerRef: 'synthetic-guide:noor',
        reason: 'assignment',
      },
    ],
  },
  {
    // Riverbend cross-tenant negative + opposite posture: a pooled, unowned
    // non-SLA WorkItem (this tenant has no SLA policies configured).
    tenantId: riverbend,
    open: {
      workItemId: 'wi-thread-rb-0001',
      origin: 'thread',
      subjectRef: 'thread:rb-th-0001',
      purpose: 'member-message',
      risk: 'routine',
      serviceTier: 'non-member',
      slaPolicyId: null,
      policyVersion: null,
      responseDueAt: null,
      poolId: 'synthetic-pool:rb-front-desk',
      openedAt: '2026-03-02T08:00:00Z',
    },
    log: [
      {
        workItemId: 'wi-thread-rb-0001',
        eventSeq: 1,
        eventType: 'opened',
        occurredAt: '2026-03-02T08:00:00Z',
        actorRef: 'synthetic-system:router',
      },
      {
        workItemId: 'wi-thread-rb-0001',
        eventSeq: 2,
        eventType: 'queued',
        occurredAt: '2026-03-02T08:00:00Z',
      },
    ],
  },
];

export interface WorkItemSeedRecord {
  readonly tenantId: string;
  readonly item: WorkItem;
  readonly log: readonly WorkItemEvent[];
  readonly timers: readonly SlaTimer[];
}

function buildRecords(): readonly WorkItemSeedRecord[] {
  return workItemSeeds.map((seed) => ({
    tenantId: seed.tenantId,
    item: foldWorkItem(seed.open, seed.log),
    log: seed.log,
    timers: foldTimers(seed.log),
  }));
}

export interface WorkItemsSeed {
  readonly policies: readonly SlaPolicySeed[];
  readonly records: readonly WorkItemSeedRecord[];
}

export const syntheticWorkItemsSeedV1: WorkItemsSeed = {
  policies: slaPolicySeeds,
  records: buildRecords(),
};

export const workItemsSeedBeginMarker = '-- workitems:generated:begin';
export const workItemsSeedEndMarker = '-- workitems:generated:end';

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqlOptional = (value: string | null | undefined): string =>
  value === null || value === undefined ? 'NULL' : sqlLiteral(value);
const sqlJson = (value: unknown): string => `${sqlLiteral(JSON.stringify(value))}::jsonb`;
const sqlBool = (value: boolean): string => (value ? 'true' : 'false');
const sqlIntOrNull = (value: number | null): string => (value === null ? 'NULL' : String(value));

function policyRow(policy: SlaPolicySeed): string {
  return (
    `  (${sqlLiteral(policy.tenantId)}, ${sqlLiteral(policy.policyId)}, ${policy.version}, ` +
    `${sqlLiteral(policy.effectiveOn)}, ${sqlLiteral(policy.memberTier)}, ${sqlLiteral(policy.hoursMode)}, ` +
    `${policy.firstResponseTargetMinutes}, ${policy.nextResponseTargetMinutes}, ` +
    `${sqlIntOrNull(policy.resolutionTargetMinutes)}, ${sqlJson(policy.escalationChain)}, ` +
    `${sqlBool(policy.quietHoursExempt)}, ${sqlLiteral(policy.changeControlRef)}, true)`
  );
}

function workItemRow(record: WorkItemSeedRecord): string {
  const i = record.item;
  return (
    `  (${sqlLiteral(record.tenantId)}, ${sqlLiteral(i.workItemId)}, ${sqlLiteral(i.origin)}, ` +
    `${sqlOptional(i.subjectRef)}, ${sqlLiteral(i.purpose)}, ${sqlLiteral(i.risk)}, ` +
    `${sqlLiteral(i.serviceTier)}, ${sqlOptional(i.slaPolicyId)}, ${sqlIntOrNull(i.policyVersion)}, ` +
    `${sqlBool(i.hasSla)}, ${sqlLiteral(i.status)}, ${sqlLiteral(i.priority)}, ${sqlOptional(i.ownerRef)}, ` +
    `${sqlOptional(i.poolId)}, ${sqlJson(i.watchers)}, ${sqlBool(i.escalated)}, ` +
    `${sqlLiteral(i.openedAt)}, ${sqlOptional(i.responseDueAt)}, ${sqlOptional(i.firstOwnedAt)}, ` +
    `${i.lastEventSeq}, true)`
  );
}

function eventRow(tenantId: string, event: WorkItemEvent): string {
  return (
    `  (${sqlLiteral(tenantId)}, ${sqlLiteral(event.workItemId)}, ${event.eventSeq}, ` +
    `${sqlLiteral(event.eventType)}, ${sqlLiteral(event.occurredAt)}, ${sqlOptional(event.actorRef)}, ` +
    `${sqlOptional(event.fromOwnerRef)}, ${sqlOptional(event.toOwnerRef)}, ${sqlOptional(event.reason)}, ` +
    `${sqlOptional(event.timerType)}, ${sqlOptional(event.dueAt)}, ${sqlIntOrNull(event.escalationStep ?? null)}, ` +
    `${sqlOptional(event.escalationAction)}, ${sqlOptional(event.escalationTarget)}, ` +
    `${event.contextPackage === undefined ? 'NULL' : sqlJson(event.contextPackage)}, ` +
    `${sqlOptional(event.watcherRef)}, '{}'::jsonb, true)`
  );
}

function timerRow(tenantId: string, record: WorkItemSeedRecord, timer: SlaTimer): string {
  return (
    `  (${sqlLiteral(tenantId)}, ${sqlLiteral(record.item.workItemId)}, ${sqlLiteral(timer.timerType)}, ` +
    `${sqlLiteral(timer.startedAt)}, ${sqlLiteral(timer.dueAt)}, ${Math.round(timer.pausedTotalSeconds)}, ` +
    `${sqlLiteral(timer.state)}, ${record.item.lastEventSeq}, true)`
  );
}

/**
 * Render the synthetic seed as idempotent SQL. The policy registry and event log
 * insert ON CONFLICT DO NOTHING (change-controlled / append-only — never
 * rewritten); the work_item + sla_timer projections upsert (they are the fold of
 * the log). Drift-tested in the unit suite; re-proven against Postgres by the DB
 * suite's projection-sync test.
 */
export function renderWorkItemsSeedSection(seed: WorkItemsSeed): string {
  const policyRows = seed.policies.map(policyRow);
  const itemRows = seed.records.map(workItemRow);
  const eventRows = seed.records.flatMap((record) =>
    record.log.map((event) => eventRow(record.tenantId, event)),
  );
  const timerRows = seed.records.flatMap((record) =>
    record.timers.map((timer) => timerRow(record.tenantId, record, timer)),
  );
  const lines: string[] = [
    workItemsSeedBeginMarker,
    '-- Generated by @practicehub/events renderWorkItemsSeedSection from',
    '-- syntheticWorkItemsSeedV1. Regenerate on any seed change; the drift test and',
    '-- the DB suite fail on divergence.',
    'INSERT INTO events.sla_policy',
    '  (tenant_id, policy_id, version, effective_on, member_tier, hours_mode,',
    '   first_response_target_minutes, next_response_target_minutes, resolution_target_minutes,',
    '   escalation_chain, quiet_hours_exempt, change_control_ref, synthetic)',
    'VALUES',
    policyRows.join(',\n'),
    'ON CONFLICT (tenant_id, policy_id, version) DO NOTHING;',
    '',
    'INSERT INTO events.work_item',
    '  (tenant_id, work_item_id, origin, subject_ref, purpose, risk, service_tier,',
    '   sla_policy_id, policy_version, has_sla, status, priority, owner_ref, pool_id,',
    '   watchers, escalated, opened_at, response_due_at, first_owned_at, last_event_seq, synthetic)',
    'VALUES',
    itemRows.join(',\n'),
    'ON CONFLICT (tenant_id, work_item_id) DO UPDATE',
    'SET status = EXCLUDED.status, priority = EXCLUDED.priority, owner_ref = EXCLUDED.owner_ref,',
    '    pool_id = EXCLUDED.pool_id, watchers = EXCLUDED.watchers, escalated = EXCLUDED.escalated,',
    '    first_owned_at = EXCLUDED.first_owned_at, last_event_seq = EXCLUDED.last_event_seq;',
    '',
    'INSERT INTO events.work_item_event',
    '  (tenant_id, work_item_id, event_seq, event_type, occurred_at, actor_ref, from_owner_ref,',
    '   to_owner_ref, reason, timer_type, due_at, escalation_step, escalation_action,',
    '   escalation_target, context_package, watcher_ref, detail, synthetic)',
    'VALUES',
    eventRows.join(',\n'),
    'ON CONFLICT (tenant_id, work_item_id, event_seq) DO NOTHING;',
  ];
  if (timerRows.length > 0) {
    lines.push(
      '',
      'INSERT INTO events.sla_timer',
      '  (tenant_id, work_item_id, timer_type, started_at, due_at, paused_total_seconds,',
      '   state, last_event_seq, synthetic)',
      'VALUES',
      timerRows.join(',\n'),
      'ON CONFLICT (tenant_id, work_item_id, timer_type) DO UPDATE',
      'SET started_at = EXCLUDED.started_at, due_at = EXCLUDED.due_at,',
      '    paused_total_seconds = EXCLUDED.paused_total_seconds, state = EXCLUDED.state,',
      '    last_event_seq = EXCLUDED.last_event_seq;',
    );
  }
  lines.push(workItemsSeedEndMarker);
  return lines.join('\n');
}

/** Extract the generated section from the committed seed file's contents. */
export function extractWorkItemsSeedSection(seedSql: string): string | null {
  const begin = seedSql.indexOf(workItemsSeedBeginMarker);
  const end = seedSql.indexOf(workItemsSeedEndMarker);
  if (begin === -1 || end === -1 || end < begin) {
    return null;
  }
  return seedSql.slice(begin, end + workItemsSeedEndMarker.length);
}

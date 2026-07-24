/**
 * On-call + coverage repository (WP-023, M05). Contract:
 * docs/contracts/oncall-coverage-api.md (FROZEN). Binds the pure on-call/coverage
 * domain to the `events` schema over the same minimal `Queryable` the WP-022
 * tasking store uses (the caller owns the transaction boundary, so the DB suite
 * can drive a bulk reassignment inside one transaction).
 *
 * The on-call rotation registry is RUNTIME READ-ONLY for the app role (loaded
 * here, published only as change-controlled seed via the owner connection). The
 * operational writes — slot vacate, gap-alert emission, coverage reassignment,
 * handoff records — are never capability-gated (on-call coverage and the safety
 * escalations that depend on it must always run). The bulk reassignment drives the
 * WP-022 reassignWorkItem per item in the caller's transaction, then records the
 * CoverageHandoff manifest — so a mid-batch crash rolls the whole handoff back.
 */

import type { Queryable } from './store.js';
import { reassignWorkItem } from './workitem-store.js';
import {
  assertRotationValid,
  type OnCallRotation,
  type OnCallSlot,
  type OnCallSlotKind,
  type OnCallSlotStatus,
  type CoverageGapReason,
} from './oncall.js';
import {
  planCoverageReassignment,
  type CoverageHandoff,
  type CoverageWindow,
  type OwnedItemHandoff,
} from './coverage.js';

export class OnCallStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OnCallStoreError';
  }
}

const iso = (value: unknown): string => {
  if (value instanceof Date) {
    return `${value.toISOString().slice(0, 19)}Z`;
  }
  return String(value);
};

/** On-call rotations for the bound tenant (RLS-scoped read). */
export async function loadOnCallRotations(exec: Queryable): Promise<readonly OnCallRotation[]> {
  const result = await exec.query(
    `SELECT rotation_id, version, to_char(effective_on, 'YYYY-MM-DD') AS effective_on,
            location_id, coverage_mode, service_scopes, member_order
       FROM events.on_call_rotation`,
  );
  return result.rows.map((row) => {
    const rotation: OnCallRotation = {
      rotationId: String(row['rotation_id']),
      version: Number(row['version']),
      effectiveOn: String(row['effective_on']),
      locationId: String(row['location_id']),
      coverageMode: row['coverage_mode'] as OnCallRotation['coverageMode'],
      serviceScopes: row['service_scopes'] as readonly string[],
      memberOrder: row['member_order'] as OnCallRotation['memberOrder'],
    };
    assertRotationValid(rotation);
    return rotation;
  });
}

/** On-call slots for the bound tenant (optionally one rotation), RLS-scoped. */
export async function loadOnCallSlots(
  exec: Queryable,
  rotationId?: string,
): Promise<readonly OnCallSlot[]> {
  const result =
    rotationId === undefined
      ? await exec.query(`SELECT * FROM events.on_call_slot`)
      : await exec.query(`SELECT * FROM events.on_call_slot WHERE rotation_id = $1`, [rotationId]);
  return result.rows.map((row) => ({
    slotId: String(row['slot_id']),
    rotationId: String(row['rotation_id']),
    kind: row['kind'] as OnCallSlotKind,
    memberRef: String(row['member_ref']),
    serviceScopes: row['service_scopes'] as readonly string[],
    windowStart: iso(row['window_start']),
    windowEnd: iso(row['window_end']),
    status: row['status'] as OnCallSlotStatus,
  }));
}

/** Mark an on-call slot vacated (a departed member covers nobody). Fold-forward, no DELETE. */
export async function vacateOnCallSlot(
  exec: Queryable,
  input: { readonly tenantId: string; readonly slotId: string },
): Promise<void> {
  const result = await exec.query(
    `UPDATE events.on_call_slot SET status = 'vacated' WHERE tenant_id = $1 AND slot_id = $2`,
    [input.tenantId, input.slotId],
  );
  if (result.rowCount === 0) {
    throw new OnCallStoreError(`on-call slot ${input.slotId} does not exist`);
  }
}

/** Record a detected coverage-gap alert (REQ-ADM-041 gap alerting). */
export async function recordCoverageGapAlert(
  exec: Queryable,
  input: {
    readonly tenantId: string;
    readonly alertId: string;
    readonly rotationId: string;
    readonly locationId: string;
    readonly serviceScope: string;
    readonly gapStart: string;
    readonly gapEnd: string;
    readonly reason: CoverageGapReason;
  },
): Promise<void> {
  await exec.query(
    `INSERT INTO events.coverage_gap_alert
       (tenant_id, alert_id, rotation_id, location_id, service_scope, gap_start, gap_end,
        detected_reason, status, synthetic)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',true)`,
    [
      input.tenantId,
      input.alertId,
      input.rotationId,
      input.locationId,
      input.serviceScope,
      input.gapStart,
      input.gapEnd,
      input.reason,
    ],
  );
}

async function insertHandoff(
  exec: Queryable,
  tenantId: string,
  handoff: CoverageHandoff,
): Promise<void> {
  await exec.query(
    `INSERT INTO events.coverage_handoff
       (tenant_id, handoff_id, kind, from_owner_ref, to_owner_ref, generated_at,
        item_count, context_manifest, synthetic)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,true)`,
    [
      tenantId,
      handoff.handoffId,
      handoff.kind,
      handoff.fromOwnerRef,
      handoff.toOwnerRef,
      handoff.generatedAt,
      handoff.itemCount,
      JSON.stringify(handoff.manifest),
    ],
  );
}

/** Record a morning-handoff artifact (REQ-TASK-034). */
export async function recordCoverageHandoff(
  exec: Queryable,
  input: { readonly tenantId: string; readonly handoff: CoverageHandoff },
): Promise<void> {
  await insertHandoff(exec, input.tenantId, input.handoff);
}

export interface CoverageReassignmentResult {
  readonly handoffId: string;
  readonly reassignedItemIds: readonly string[];
}

/**
 * Execute a planned coverage/PTO bulk reassignment (REQ-TASK-020 / REQ-TASK-003).
 * Builds the plan (fail-closed on any missing context package), drives WP-022
 * reassignWorkItem for each owned item in the caller's transaction — so the prior
 * owner is demoted to a watcher and the single-owner invariant holds — then records
 * the CoverageHandoff manifest. A mid-batch failure rolls the whole handoff back
 * (the caller's transaction is atomic): a coverage handoff never leaves half the
 * threads moved and no record.
 */
export async function executeCoverageReassignment(
  exec: Queryable,
  input: {
    readonly tenantId: string;
    readonly handoffId: string;
    readonly window: CoverageWindow;
    readonly ownedItems: readonly OwnedItemHandoff[];
    readonly actorRef: string;
    readonly occurredAt: string;
  },
): Promise<CoverageReassignmentResult> {
  const plan = planCoverageReassignment({ window: input.window, ownedItems: input.ownedItems });
  const reassignedItemIds: string[] = [];
  for (const entry of plan) {
    await reassignWorkItem(exec, {
      tenantId: input.tenantId,
      workItemId: entry.workItemId,
      toOwnerRef: entry.toOwnerRef,
      actorRef: input.actorRef,
      occurredAt: input.occurredAt,
      reason: entry.reason,
      contextPackage: entry.contextPackage,
    });
    reassignedItemIds.push(entry.workItemId);
  }
  const handoff: CoverageHandoff = {
    handoffId: input.handoffId,
    kind: input.window.reason === 'pto' ? 'pto-coverage' : 'departure',
    fromOwnerRef: input.window.ownerRef,
    toOwnerRef: input.window.coverageTargetRef,
    generatedAt: input.occurredAt,
    itemCount: plan.length,
    manifest: plan.map((entry) => ({
      workItemId: entry.workItemId,
      risk: 'elevated',
      contextPackageRef: entry.contextPackage.priorOwnerNotesRef ?? `context:${entry.workItemId}`,
    })),
  };
  await insertHandoff(exec, input.tenantId, handoff);
  return { handoffId: input.handoffId, reassignedItemIds };
}

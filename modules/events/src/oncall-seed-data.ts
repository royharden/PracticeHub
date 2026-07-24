/**
 * Synthetic on-call + coverage seed data of record (WP-023). The committed seed
 * file `infra/postgres/seed/016-oncall-seed.sql` embeds `renderOnCallSeedSection`
 * output between the oncall markers — a drift test compares the file against a
 * fresh emission, and the DB suite re-checks the postures against live Postgres.
 *
 * Standing proofs (Northwind):
 * - a provisioned 24/7 concierge on-call rotation (REQ-ADM-016) with a rotation
 *   slot, an override slot (REQ-ADM-041), and a vacated slot (a departed member);
 * - one OPEN coverage-gap alert (REQ-ADM-041 gap alerting);
 * - a planned PTO coverage window (REQ-TASK-003/020) and a `pto-coverage` handoff
 *   artifact of two reassigned items with context (REQ-TASK-020), plus a
 *   `morning-handoff` artifact (REQ-TASK-034).
 * Riverbend carries a business-mode rotation with its own OPEN gap alert — the
 * cross-tenant negative + opposite posture.
 */

import type { OnCallRotation, OnCallSlot } from './oncall.js';
import type { CoverageWindow, CoverageHandoff } from './coverage.js';

const northwind = 'northwind-synthetic';
const riverbend = 'riverbend-synthetic';

export interface OnCallRotationSeed extends OnCallRotation {
  readonly tenantId: string;
  readonly changeControlRef: string;
}

export interface OnCallSlotSeed extends OnCallSlot {
  readonly tenantId: string;
}

export interface CoverageWindowSeed extends CoverageWindow {
  readonly tenantId: string;
}

export interface CoverageGapAlertSeed {
  readonly tenantId: string;
  readonly alertId: string;
  readonly rotationId: string;
  readonly locationId: string;
  readonly serviceScope: string;
  readonly gapStart: string;
  readonly gapEnd: string;
  readonly detectedReason: string;
  readonly status: 'open' | 'resolved';
}

export interface CoverageHandoffSeed extends CoverageHandoff {
  readonly tenantId: string;
}

export const onCallRotationSeeds: readonly OnCallRotationSeed[] = [
  {
    tenantId: northwind,
    rotationId: 'oncall-concierge-nv',
    version: 1,
    effectiveOn: '2026-01-01',
    locationId: 'loc-nv-lasvegas',
    coverageMode: '24x7',
    serviceScopes: ['concierge-urgent', 'longevity'],
    memberOrder: [
      { memberRef: 'synthetic-provider:reyes', serviceScopes: ['concierge-urgent', 'longevity'] },
      { memberRef: 'synthetic-provider:okafor', serviceScopes: ['concierge-urgent'] },
    ],
    changeControlRef: 'wp-023-oncall-concierge-nv-v1',
  },
  {
    tenantId: riverbend,
    rotationId: 'oncall-rb',
    version: 1,
    effectiveOn: '2026-01-01',
    locationId: 'loc-rb-central',
    coverageMode: 'business',
    serviceScopes: ['general'],
    memberOrder: [{ memberRef: 'synthetic-provider:rb-lane', serviceScopes: ['general'] }],
    changeControlRef: 'wp-023-oncall-rb-v1',
  },
];

export const onCallSlotSeeds: readonly OnCallSlotSeed[] = [
  {
    // Rotation slot: Reyes covers the full-scope daytime window.
    tenantId: northwind,
    slotId: 'slot-nv-0001',
    rotationId: 'oncall-concierge-nv',
    kind: 'rotation',
    memberRef: 'synthetic-provider:reyes',
    serviceScopes: ['concierge-urgent', 'longevity'],
    windowStart: '2026-03-02T08:00:00Z',
    windowEnd: '2026-03-02T20:00:00Z',
    status: 'scheduled',
  },
  {
    // Override slot: Okafor (concierge-urgent only) overrides the evening — a
    // longevity case in this window is skipped to no-qualified-oncall.
    tenantId: northwind,
    slotId: 'slot-nv-0002',
    rotationId: 'oncall-concierge-nv',
    kind: 'override',
    memberRef: 'synthetic-provider:okafor',
    serviceScopes: ['concierge-urgent'],
    windowStart: '2026-03-02T20:00:00Z',
    windowEnd: '2026-03-03T00:00:00Z',
    status: 'overridden',
  },
  {
    // Vacated slot: a departed member covers nobody (REQ-TASK-033).
    tenantId: northwind,
    slotId: 'slot-nv-0003',
    rotationId: 'oncall-concierge-nv',
    kind: 'rotation',
    memberRef: 'synthetic-provider:departed',
    serviceScopes: ['concierge-urgent', 'longevity'],
    windowStart: '2026-03-03T00:00:00Z',
    windowEnd: '2026-03-03T08:00:00Z',
    status: 'vacated',
  },
  {
    tenantId: riverbend,
    slotId: 'slot-rb-0001',
    rotationId: 'oncall-rb',
    kind: 'rotation',
    memberRef: 'synthetic-provider:rb-lane',
    serviceScopes: ['general'],
    windowStart: '2026-03-02T09:00:00Z',
    windowEnd: '2026-03-02T17:00:00Z',
    status: 'scheduled',
  },
];

export const coverageWindowSeeds: readonly CoverageWindowSeed[] = [
  {
    tenantId: northwind,
    coverageId: 'cov-noor-0001',
    ownerRef: 'synthetic-guide:noor',
    fromAt: '2026-03-10T00:00:00Z',
    toAt: '2026-03-14T00:00:00Z',
    coverageTargetRef: 'synthetic-guide:maya',
    targetKind: 'owner',
    reason: 'pto',
    status: 'planned',
  },
];

export const coverageGapAlertSeeds: readonly CoverageGapAlertSeed[] = [
  {
    // Northwind: the vacated overnight window leaves a longevity+concierge gap.
    tenantId: northwind,
    alertId: 'gap-nv-0001',
    rotationId: 'oncall-concierge-nv',
    locationId: 'loc-nv-lasvegas',
    serviceScope: 'concierge-urgent',
    gapStart: '2026-03-03T00:00:00Z',
    gapEnd: '2026-03-03T08:00:00Z',
    detectedReason: 'vacated-slot',
    status: 'open',
  },
  {
    // Riverbend: after-hours are uncovered (business-mode rotation).
    tenantId: riverbend,
    alertId: 'gap-rb-0001',
    rotationId: 'oncall-rb',
    locationId: 'loc-rb-central',
    serviceScope: 'general',
    gapStart: '2026-03-02T17:00:00Z',
    gapEnd: '2026-03-03T09:00:00Z',
    detectedReason: 'unfilled-window',
    status: 'open',
  },
];

export const coverageHandoffSeeds: readonly CoverageHandoffSeed[] = [
  {
    // A planned PTO handoff of two owned threads to the covering Guide (REQ-TASK-020).
    tenantId: northwind,
    handoffId: 'handoff-noor-pto-0001',
    kind: 'pto-coverage',
    fromOwnerRef: 'synthetic-guide:noor',
    toOwnerRef: 'synthetic-guide:maya',
    generatedAt: '2026-03-09T18:00:00Z',
    itemCount: 2,
    manifest: [
      {
        workItemId: 'wi-thread-noor-0011',
        risk: 'elevated',
        contextPackageRef: 'synthetic-note:noor-handoff-0011',
      },
      {
        workItemId: 'wi-thread-noor-0012',
        risk: 'routine',
        contextPackageRef: 'synthetic-note:noor-handoff-0012',
      },
    ],
  },
  {
    // A morning handoff of one overnight urgent thread (REQ-TASK-034).
    tenantId: northwind,
    handoffId: 'handoff-morning-0001',
    kind: 'morning-handoff',
    fromOwnerRef: 'synthetic-provider:okafor',
    toOwnerRef: 'synthetic-guide:noor',
    generatedAt: '2026-03-03T07:30:00Z',
    itemCount: 1,
    manifest: [
      {
        workItemId: 'wi-thread-overnight-0021',
        risk: 'urgent',
        contextPackageRef: 'synthetic-note:overnight-0021',
      },
    ],
  },
];

export interface OnCallSeed {
  readonly rotations: readonly OnCallRotationSeed[];
  readonly slots: readonly OnCallSlotSeed[];
  readonly windows: readonly CoverageWindowSeed[];
  readonly gapAlerts: readonly CoverageGapAlertSeed[];
  readonly handoffs: readonly CoverageHandoffSeed[];
}

export const syntheticOnCallSeedV1: OnCallSeed = {
  rotations: onCallRotationSeeds,
  slots: onCallSlotSeeds,
  windows: coverageWindowSeeds,
  gapAlerts: coverageGapAlertSeeds,
  handoffs: coverageHandoffSeeds,
};

export const onCallSeedBeginMarker = '-- oncall:generated:begin';
export const onCallSeedEndMarker = '-- oncall:generated:end';

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqlOptional = (value: string | null | undefined): string =>
  value === null || value === undefined ? 'NULL' : sqlLiteral(value);
const sqlJson = (value: unknown): string => `${sqlLiteral(JSON.stringify(value))}::jsonb`;

function rotationRow(rotation: OnCallRotationSeed): string {
  return (
    `  (${sqlLiteral(rotation.tenantId)}, ${sqlLiteral(rotation.rotationId)}, ${rotation.version}, ` +
    `${sqlLiteral(rotation.effectiveOn)}, ${sqlLiteral(rotation.locationId)}, ${sqlLiteral(rotation.coverageMode)}, ` +
    `${sqlJson(rotation.serviceScopes)}, ${sqlJson(rotation.memberOrder)}, ${sqlLiteral(rotation.changeControlRef)}, true)`
  );
}

function slotRow(slot: OnCallSlotSeed): string {
  return (
    `  (${sqlLiteral(slot.tenantId)}, ${sqlLiteral(slot.slotId)}, ${sqlLiteral(slot.rotationId)}, ` +
    `${sqlLiteral(slot.kind)}, ${sqlLiteral(slot.memberRef)}, ${sqlJson(slot.serviceScopes)}, ` +
    `${sqlLiteral(slot.windowStart)}, ${sqlLiteral(slot.windowEnd)}, ${sqlLiteral(slot.status)}, true)`
  );
}

function windowRow(window: CoverageWindowSeed): string {
  return (
    `  (${sqlLiteral(window.tenantId)}, ${sqlLiteral(window.coverageId)}, ${sqlLiteral(window.ownerRef)}, ` +
    `${sqlLiteral(window.fromAt)}, ${sqlLiteral(window.toAt)}, ${sqlLiteral(window.coverageTargetRef)}, ` +
    `${sqlLiteral(window.targetKind)}, ${sqlLiteral(window.reason)}, ${sqlLiteral(window.status)}, true)`
  );
}

function gapRow(gap: CoverageGapAlertSeed): string {
  return (
    `  (${sqlLiteral(gap.tenantId)}, ${sqlLiteral(gap.alertId)}, ${sqlLiteral(gap.rotationId)}, ` +
    `${sqlLiteral(gap.locationId)}, ${sqlLiteral(gap.serviceScope)}, ${sqlLiteral(gap.gapStart)}, ` +
    `${sqlLiteral(gap.gapEnd)}, ${sqlLiteral(gap.detectedReason)}, ${sqlLiteral(gap.status)}, true)`
  );
}

function handoffRow(handoff: CoverageHandoffSeed): string {
  return (
    `  (${sqlLiteral(handoff.tenantId)}, ${sqlLiteral(handoff.handoffId)}, ${sqlLiteral(handoff.kind)}, ` +
    `${sqlOptional(handoff.fromOwnerRef)}, ${sqlLiteral(handoff.toOwnerRef)}, ${sqlLiteral(handoff.generatedAt)}, ` +
    `${handoff.itemCount}, ${sqlJson(handoff.manifest)}, true)`
  );
}

/**
 * Render the synthetic seed as idempotent SQL. The rotation registry inserts ON
 * CONFLICT DO NOTHING (change-controlled — never rewritten); slots/windows/gap
 * alerts/handoffs are re-seedable append rows (DO NOTHING). Drift-tested in the
 * unit suite; re-proven against Postgres by the DB suite.
 */
export function renderOnCallSeedSection(seed: OnCallSeed): string {
  const lines: string[] = [
    onCallSeedBeginMarker,
    '-- Generated by @practicehub/events renderOnCallSeedSection from',
    '-- syntheticOnCallSeedV1. Regenerate on any seed change; the drift test and',
    '-- the DB suite fail on divergence.',
    'INSERT INTO events.on_call_rotation',
    '  (tenant_id, rotation_id, version, effective_on, location_id, coverage_mode,',
    '   service_scopes, member_order, change_control_ref, synthetic)',
    'VALUES',
    seed.rotations.map(rotationRow).join(',\n'),
    'ON CONFLICT (tenant_id, rotation_id, version) DO NOTHING;',
    '',
    'INSERT INTO events.on_call_slot',
    '  (tenant_id, slot_id, rotation_id, kind, member_ref, service_scopes,',
    '   window_start, window_end, status, synthetic)',
    'VALUES',
    seed.slots.map(slotRow).join(',\n'),
    'ON CONFLICT (tenant_id, slot_id) DO NOTHING;',
    '',
    'INSERT INTO events.coverage_window',
    '  (tenant_id, coverage_id, owner_ref, from_at, to_at, coverage_target_ref,',
    '   target_kind, reason, status, synthetic)',
    'VALUES',
    seed.windows.map(windowRow).join(',\n'),
    'ON CONFLICT (tenant_id, coverage_id) DO NOTHING;',
    '',
    'INSERT INTO events.coverage_gap_alert',
    '  (tenant_id, alert_id, rotation_id, location_id, service_scope, gap_start, gap_end,',
    '   detected_reason, status, synthetic)',
    'VALUES',
    seed.gapAlerts.map(gapRow).join(',\n'),
    'ON CONFLICT (tenant_id, alert_id) DO NOTHING;',
    '',
    'INSERT INTO events.coverage_handoff',
    '  (tenant_id, handoff_id, kind, from_owner_ref, to_owner_ref, generated_at,',
    '   item_count, context_manifest, synthetic)',
    'VALUES',
    seed.handoffs.map(handoffRow).join(',\n'),
    'ON CONFLICT (tenant_id, handoff_id) DO NOTHING;',
    onCallSeedEndMarker,
  ];
  return lines.join('\n');
}

/** Extract the generated section from the committed seed file's contents. */
export function extractOnCallSeedSection(seedSql: string): string | null {
  const begin = seedSql.indexOf(onCallSeedBeginMarker);
  const end = seedSql.indexOf(onCallSeedEndMarker);
  if (begin === -1 || end === -1 || end < begin) {
    return null;
  }
  return seedSql.slice(begin, end + onCallSeedEndMarker.length);
}

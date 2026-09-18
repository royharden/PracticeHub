import type { CatalogSlot, ManagerSchedulingException, WaitlistPriorityPause } from '../types.js';

export interface Inc2ResourceCatalogRow {
  tenant_id: string;
  catalog_id: string;
  location_id: string;
  resource_id: string;
  resource_kind: string;
  setup_minutes: number;
  cleanup_minutes: number;
  out_of_service: boolean;
  nearest_alternate_location_id: string | null;
  synthetic: boolean;
}

export interface Inc2WaitlistPauseRow {
  tenant_id: string;
  waitlist_entry_id: string;
  reason: string;
  owner_ref: string;
  original_priority: number;
  reevaluation_deadline: string;
  state: 'paused' | 'restored' | 'closed';
  synthetic: boolean;
}

export interface Inc2ManagerExceptionRow {
  tenant_id: string;
  exception_id: string;
  rationale: string;
  scope: string;
  exception_range: { start: string; end: string };
  impacted_resource_ids: readonly string[];
  approved_by: string;
  synthetic: boolean;
}

export function catalogRowToSlot(row: Inc2ResourceCatalogRow, slot: CatalogSlot): CatalogSlot {
  return {
    ...slot,
    locationId: row.location_id,
    resourceIds: [...slot.resourceIds, row.resource_id],
    setupMinutes: row.setup_minutes,
    cleanupMinutes: row.cleanup_minutes,
    outOfService: row.out_of_service,
  };
}

export function pauseRowToPause(row: Inc2WaitlistPauseRow): WaitlistPriorityPause {
  return {
    waitlistEntryId: row.waitlist_entry_id,
    reason: row.reason,
    owner: row.owner_ref,
    originalPriority: row.original_priority,
    reevaluationDeadline: row.reevaluation_deadline,
    state: row.state,
  };
}

export function exceptionRowToException(row: Inc2ManagerExceptionRow): ManagerSchedulingException {
  return {
    exceptionId: row.exception_id,
    rationale: row.rationale,
    scope: row.scope,
    duration: row.exception_range,
    impactedResourceIds: row.impacted_resource_ids,
    approvedBy: row.approved_by,
  };
}

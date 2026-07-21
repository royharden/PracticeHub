/**
 * Identity timeline (WP-013, REQ-ID-005 AC-3): append-only per-person event
 * trail — registration, conversions, cross-location encounters, name updates,
 * reviews — each entry carrying actor, location, source, and timestamp. The
 * database enforces append-only with REVOKE UPDATE/DELETE (0004-identity.sql).
 */

import type { LocationId, PersonId, TenantId } from '@practicehub/contracts';

import { IdentityInvariantError, assertIdentityId } from './identity.js';

export const timelineEntryKinds = [
  'registered',
  'converted',
  'cross-location-encounter',
  'name-updated',
  'endpoint-linked',
  'source-linked',
  'review-opened',
] as const;
export type TimelineEntryKind = (typeof timelineEntryKinds)[number];

export interface IdentityTimelineEntry {
  readonly entryId: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly kind: TimelineEntryKind;
  readonly actorRef: string;
  readonly locationId?: LocationId;
  readonly source: string;
  readonly occurredAt: string;
  readonly detail?: string;
  readonly synthetic: boolean;
}

export function assertTimelineEntryWellFormed(entry: IdentityTimelineEntry): void {
  assertIdentityId(entry.tenantId, 'tenantId');
  assertIdentityId(entry.entryId, 'entryId');
  if (!entry.actorRef || !entry.source || !entry.occurredAt) {
    throw new IdentityInvariantError(
      `timeline entry ${entry.entryId} must carry actor, source, and timestamp (REQ-ID-005 AC-3)`,
    );
  }
}

/** Append-only: returns a new trail; existing entries are never rewritten. */
export function appendTimelineEntry(
  trail: readonly IdentityTimelineEntry[],
  entry: IdentityTimelineEntry,
): readonly IdentityTimelineEntry[] {
  assertTimelineEntryWellFormed(entry);
  if (trail.some((existing) => existing.entryId === entry.entryId)) {
    throw new IdentityInvariantError(`timeline entry ${entry.entryId} already exists`);
  }
  return [...trail, entry];
}

import type { CatalogSlot, LinkedResourceNeed, TimeInterval } from '../types.js';
import type { Increment2Engine } from './engine.js';
import { intervalsOverlap } from './overlap.js';

export interface CatalogResourceRow {
  catalogId: string;
  locationId: string;
  resourceId: string;
  resourceKind: 'provider' | 'room' | 'equipment' | 'staff' | 'interpreter';
  setupMinutes: number;
  cleanupMinutes: number;
  outOfService: boolean;
  nearestAlternateLocationId: string | null;
}

export interface OccupiedInterval {
  resourceId: string;
  start: string;
  end: string;
}

function pad(slot: CatalogSlot): TimeInterval {
  return {
    start: new Date(Date.parse(slot.start) - slot.setupMinutes * 60_000).toISOString(),
    end: new Date(Date.parse(slot.end) + slot.cleanupMinutes * 60_000).toISOString(),
  };
}

export function searchJointCatalog(input: {
  locationId: string;
  interval: TimeInterval;
  slots: readonly CatalogSlot[];
  catalog: readonly CatalogResourceRow[];
  occupied: readonly OccupiedInterval[];
  required: readonly { kind: CatalogResourceRow['resourceKind']; id: string }[];
  engine: Increment2Engine;
}): {
  committed: boolean;
  receipts: readonly string[];
  slot?: CatalogSlot;
  alternateLocationId: string | null;
} {
  const liveCatalog = input.catalog.filter((row) => !row.outOfService);
  const candidates = input.slots.filter(
    (slot) =>
      slot.locationId === input.locationId &&
      !slot.outOfService &&
      Date.parse(slot.start) >= Date.parse(input.interval.start) &&
      Date.parse(slot.end) <= Date.parse(input.interval.end),
  );
  for (const slot of candidates) {
    const padded = pad(slot);
    const needs: LinkedResourceNeed[] = input.required.map((req) => {
      const row = liveCatalog.find(
        (item) =>
          item.resourceId === req.id &&
          item.resourceKind === req.kind &&
          item.locationId === input.locationId,
      );
      const busy = input.occupied.some(
        (occ) => occ.resourceId === req.id && intervalsOverlap(padded, occ, 0),
      );
      return {
        resourceId: req.id,
        resourceType: req.kind === 'provider' ? 'staff' : req.kind,
        required: true,
        available: Boolean(row) && !busy,
      };
    });
    const result = input.engine.commitLinkedResources(needs, 'resource-desk', '15m');
    if (result.committed) {
      return {
        committed: true,
        receipts: result.receipts,
        slot,
        alternateLocationId: null,
      };
    }
  }
  const alternate =
    liveCatalog.find(
      (row) => row.locationId === input.locationId && row.nearestAlternateLocationId !== null,
    )?.nearestAlternateLocationId ?? null;
  return { committed: false, receipts: [], alternateLocationId: alternate };
}

import { mirrorKey, type MirrorBody, type SealedMirror } from './contracts.js';
import { sealCanonical } from './seal.js';

export interface BackloadRow {
  readonly tenantId: string;
  readonly kind: MirrorBody['kind'];
  readonly controlNumber: string;
  readonly amountMinor: number;
  readonly payload: string;
}

export interface BackloadKey {
  readonly tenantId: string;
  readonly kind: MirrorBody['kind'];
  readonly controlNumber: string;
}

export interface BackloadConflict {
  readonly key: BackloadKey;
  readonly reason: 'amount' | 'payload' | 'seal';
  readonly incumbentAmountMinor: number | null;
  readonly shadowAmountMinor: number | null;
}

export interface BackloadUnmatched {
  readonly side: 'incumbent' | 'shadow';
  readonly key: BackloadKey;
}

export interface BackloadReport {
  readonly matched: readonly BackloadKey[];
  readonly unmatched: readonly BackloadUnmatched[];
  readonly conflicting: readonly BackloadConflict[];
}

function keyOf(row: BackloadKey): BackloadKey {
  return {
    tenantId: row.tenantId,
    kind: row.kind,
    controlNumber: row.controlNumber,
  };
}

export function reconcileBackload(
  incumbent: readonly BackloadRow[],
  mirrors: readonly SealedMirror[],
): BackloadReport {
  const incumbentByKey = new Map<string, BackloadRow>();
  for (const row of incumbent) {
    incumbentByKey.set(mirrorKey(row), row);
  }
  const shadowByKey = new Map<string, SealedMirror>();
  for (const mirror of mirrors) {
    shadowByKey.set(mirrorKey(mirror.body), mirror);
  }

  const matched: BackloadKey[] = [];
  const unmatched: BackloadUnmatched[] = [];
  const conflicting: BackloadConflict[] = [];

  for (const [key, row] of incumbentByKey) {
    const mirror = shadowByKey.get(key);
    const identity = keyOf(row);
    if (!mirror) {
      unmatched.push({ side: 'incumbent', key: identity });
      continue;
    }
    const sealHolds = sealCanonical(mirror.canonical) === mirror.seal;
    if (!sealHolds) {
      conflicting.push({
        key: identity,
        reason: 'seal',
        incumbentAmountMinor: row.amountMinor,
        shadowAmountMinor: mirror.body.amountMinor,
      });
      continue;
    }
    if (row.amountMinor !== mirror.body.amountMinor) {
      conflicting.push({
        key: identity,
        reason: 'amount',
        incumbentAmountMinor: row.amountMinor,
        shadowAmountMinor: mirror.body.amountMinor,
      });
      continue;
    }
    if (row.payload !== mirror.body.payload) {
      conflicting.push({
        key: identity,
        reason: 'payload',
        incumbentAmountMinor: row.amountMinor,
        shadowAmountMinor: mirror.body.amountMinor,
      });
      continue;
    }
    matched.push(identity);
  }

  for (const [key, mirror] of shadowByKey) {
    if (!incumbentByKey.has(key)) {
      unmatched.push({ side: 'shadow', key: keyOf(mirror.body) });
    }
  }

  return { matched, unmatched, conflicting };
}

import { assertMirrorBody, mirrorKey, type MirrorBody, type SealedMirror } from './contracts.js';
import { canonicalMirror, sealCanonical } from './seal.js';

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
  readonly reason: 'amount' | 'payload' | 'seal' | 'duplicate';
  readonly incumbentAmountMinor: number | null;
  readonly shadowAmountMinor: number | null;
  /** Set on a 'duplicate': how many rows (or mirrors) share the key. */
  readonly occurrences?: number;
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

interface ShadowSide {
  readonly key: BackloadKey;
  /** The sealed body when the seal verifies over it; null when it does not. */
  readonly verified: MirrorBody | null;
  readonly amountMinor: number;
}

function keyOf(row: BackloadKey): BackloadKey {
  return {
    tenantId: row.tenantId,
    kind: row.kind,
    controlNumber: row.controlNumber,
  };
}

function parseCanonical(canonical: string): MirrorBody | null {
  try {
    const parsed = JSON.parse(canonical) as MirrorBody;
    assertMirrorBody(parsed);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The seal must cover the bytes being compared: the canonical bytes hash to
 * the seal, and the body re-canonicalizes to those same bytes. The shadow key
 * comes from the sealed bytes whenever they verify.
 */
function shadowSide(mirror: SealedMirror): ShadowSide {
  const sealed =
    sealCanonical(mirror.canonical) === mirror.seal ? parseCanonical(mirror.canonical) : null;
  let bodyMatches: boolean;
  try {
    bodyMatches = canonicalMirror(mirror.body) === mirror.canonical;
  } catch {
    bodyMatches = false;
  }
  const verified = sealed !== null && bodyMatches ? sealed : null;
  const source = sealed ?? mirror.body;
  return { key: keyOf(source), verified, amountMinor: source.amountMinor };
}

function group<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = grouped.get(key);
    if (list) {
      list.push(item);
    } else {
      grouped.set(key, [item]);
    }
  }
  return grouped;
}

export function reconcileBackload(
  incumbent: readonly BackloadRow[],
  mirrors: readonly SealedMirror[],
): BackloadReport {
  for (const row of incumbent) {
    assertMirrorBody({ ...row, currency: 'USD' });
  }
  const incumbentByKey = group(incumbent, (row) => mirrorKey(row));
  const shadowByKey = group(mirrors.map(shadowSide), (side) => mirrorKey(side.key));

  const matched: BackloadKey[] = [];
  const unmatched: BackloadUnmatched[] = [];
  const conflicting: BackloadConflict[] = [];

  for (const [key, rows] of incumbentByKey) {
    const row = rows[0];
    if (row === undefined) {
      continue;
    }
    const identity = keyOf(row);
    const shadows = shadowByKey.get(key) ?? [];
    const shadow = shadows[0];
    if (rows.length > 1 || shadows.length > 1) {
      conflicting.push({
        key: identity,
        reason: 'duplicate',
        incumbentAmountMinor: row.amountMinor,
        shadowAmountMinor: shadow?.amountMinor ?? null,
        occurrences: Math.max(rows.length, shadows.length),
      });
      continue;
    }
    if (shadow === undefined) {
      unmatched.push({ side: 'incumbent', key: identity });
      continue;
    }
    if (shadow.verified === null) {
      conflicting.push({
        key: identity,
        reason: 'seal',
        incumbentAmountMinor: row.amountMinor,
        shadowAmountMinor: shadow.amountMinor,
      });
      continue;
    }
    if (row.amountMinor !== shadow.verified.amountMinor) {
      conflicting.push({
        key: identity,
        reason: 'amount',
        incumbentAmountMinor: row.amountMinor,
        shadowAmountMinor: shadow.verified.amountMinor,
      });
      continue;
    }
    if (row.payload !== shadow.verified.payload) {
      conflicting.push({
        key: identity,
        reason: 'payload',
        incumbentAmountMinor: row.amountMinor,
        shadowAmountMinor: shadow.verified.amountMinor,
      });
      continue;
    }
    matched.push(identity);
  }

  for (const [key, shadows] of shadowByKey) {
    if (incumbentByKey.has(key)) {
      continue;
    }
    const shadow = shadows[0];
    if (shadow === undefined) {
      continue;
    }
    if (shadows.length > 1) {
      conflicting.push({
        key: shadow.key,
        reason: 'duplicate',
        incumbentAmountMinor: null,
        shadowAmountMinor: shadow.amountMinor,
        occurrences: shadows.length,
      });
      continue;
    }
    if (shadow.verified === null) {
      conflicting.push({
        key: shadow.key,
        reason: 'seal',
        incumbentAmountMinor: null,
        shadowAmountMinor: shadow.amountMinor,
      });
      continue;
    }
    unmatched.push({ side: 'shadow', key: shadow.key });
  }

  return { matched, unmatched, conflicting };
}

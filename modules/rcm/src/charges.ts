import { createHash } from 'node:crypto';

import { RcmShadowError, WP062_PACKAGE_ID, type Wp062EncounterCharge } from './contracts.js';

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export interface ReconciliationHeartbeat {
  readonly runId: string;
  readonly at: string;
  readonly missingCount: number;
  readonly duplicateCount: number;
  readonly postedCount: number;
  readonly conflictCount: number;
  readonly amountMismatchCount: number;
  readonly unexpectedCount: number;
}

/** A captured charge whose amount differs from the expected line with the same key. */
export interface ChargeAmountMismatch {
  readonly expected: Wp062EncounterCharge;
  readonly captured: Wp062EncounterCharge;
}

export interface ChargeReconciliation {
  readonly posted: readonly Wp062EncounterCharge[];
  readonly missing: readonly Wp062EncounterCharge[];
  /** Exact repeats of a captured charge; one copy is posted. */
  readonly duplicates: readonly Wp062EncounterCharge[];
  /** Every copy of a charge key captured with divergent amounts; none is posted. */
  readonly conflicts: readonly Wp062EncounterCharge[];
  /** Captured amount differs from the expected amount; held, not posted. */
  readonly amountMismatches: readonly ChargeAmountMismatch[];
  /** Captured charges with no expected line; held, not posted. */
  readonly unexpected: readonly Wp062EncounterCharge[];
  readonly heartbeat: ReconciliationHeartbeat;
}

/** Which tenants a run covers and what it was given; lets a sink key and pre-check a run. */
export interface ReconciliationRunScope {
  /** The run's tenants, sorted and joined; a run id is unique only within this scope. */
  readonly tenantKey: string;
  /** Digest of the run's inputs, so a divergent replay is caught before any work is done. */
  readonly inputDigest: string;
}

/** Where every reconciliation run records its heartbeat. */
export interface ReconciliationHeartbeatSink {
  record(heartbeat: ReconciliationHeartbeat, scope?: ReconciliationRunScope): void;
  /** Optional pre-check: throws when this run was already recorded with different inputs. */
  assertReplayable?(runId: string, scope: ReconciliationRunScope): void;
}

/**
 * In-memory heartbeat store for the simulated state. A run records once per
 * (tenants, runId): replaying the identical run is a no-op, a divergent one is
 * refused, and the same run id in another tenant is a different run.
 */
export class InMemoryReconciliationHeartbeats implements ReconciliationHeartbeatSink {
  readonly #byRun = new Map<
    string,
    { readonly heartbeat: ReconciliationHeartbeat; readonly inputDigest: string | null }
  >();

  public record(heartbeat: ReconciliationHeartbeat, scope?: ReconciliationRunScope): void {
    const runKey = JSON.stringify([scope?.tenantKey ?? '', heartbeat.runId]);
    const prior = this.#byRun.get(runKey);
    if (prior !== undefined) {
      if (JSON.stringify(prior.heartbeat) !== JSON.stringify(heartbeat)) {
        throw new RcmShadowError(
          'CHARGE_RUN',
          'reconciliation run already recorded a different heartbeat',
        );
      }
      return;
    }
    this.#byRun.set(runKey, {
      heartbeat: Object.freeze({ ...heartbeat }),
      inputDigest: scope?.inputDigest ?? null,
    });
  }

  public assertReplayable(runId: string, scope: ReconciliationRunScope): void {
    const prior = this.#byRun.get(JSON.stringify([scope.tenantKey, runId]));
    if (prior?.inputDigest != null && prior.inputDigest !== scope.inputDigest) {
      throw new RcmShadowError(
        'CHARGE_RUN',
        'reconciliation run already recorded a different heartbeat',
      );
    }
  }

  /** The heartbeat for a run; with no tenant key, the first run recorded under that id. */
  public forRun(runId: string, tenantKey?: string): ReconciliationHeartbeat | undefined {
    if (tenantKey !== undefined) {
      return this.#byRun.get(JSON.stringify([tenantKey, runId]))?.heartbeat;
    }
    return [...this.#byRun.values()].find((entry) => entry.heartbeat.runId === runId)?.heartbeat;
  }

  public all(): readonly ReconciliationHeartbeat[] {
    return [...this.#byRun.values()].map((entry) => entry.heartbeat);
  }
}

/** The module-owned sink used when a caller passes none. */
export const chargeReconciliationHeartbeats = new InMemoryReconciliationHeartbeats();

function assertCharge(charge: Wp062EncounterCharge): void {
  if (charge.packageId !== WP062_PACKAGE_ID) {
    throw new RcmShadowError('WP062_CHARGE', 'encounter charge must stand for WP-062');
  }
  if (!Number.isSafeInteger(charge.amountMinor) || charge.amountMinor < 0) {
    throw new RcmShadowError('WP062_CHARGE', 'amountMinor must be a non-negative safe integer');
  }
}

/** Charges are identified per tenant and encounter, never by chargeId alone. */
const chargeKey = (charge: Wp062EncounterCharge): string =>
  JSON.stringify([charge.tenantId, charge.encounterId, charge.chargeId]);

const sameAmount = (left: Wp062EncounterCharge, right: Wp062EncounterCharge): boolean =>
  left.amountMinor === right.amountMinor && left.currency === right.currency;

export function reconcileCharges(
  expected: readonly Wp062EncounterCharge[],
  captured: readonly Wp062EncounterCharge[],
  runId: string,
  at: string,
  heartbeats: ReconciliationHeartbeatSink = chargeReconciliationHeartbeats,
): ChargeReconciliation {
  if (runId.length === 0) {
    throw new RcmShadowError('CHARGE_RUN', 'reconciliation runId is required');
  }
  if (!INSTANT.test(at)) {
    throw new RcmShadowError('CHARGE_RUN', 'reconciliation timestamp must be YYYY-MM-DDTHH:MM:SSZ');
  }
  const scope: ReconciliationRunScope = {
    tenantKey: [...new Set([...expected, ...captured].map((charge) => charge.tenantId))]
      .sort()
      .join(','),
    inputDigest: createHash('sha256')
      .update(JSON.stringify([at, expected, captured]))
      .digest('hex'),
  };
  // A divergent replay of a recorded run is refused before any work is done.
  heartbeats.assertReplayable?.(runId, scope);
  for (const charge of [...expected, ...captured]) {
    assertCharge(charge);
  }

  const expectedByKey = new Map<string, Wp062EncounterCharge>();
  for (const charge of expected) {
    const key = chargeKey(charge);
    const prior = expectedByKey.get(key);
    if (prior !== undefined && !sameAmount(prior, charge)) {
      throw new RcmShadowError(
        'WP062_CHARGE',
        'expected charges repeat a key with different amounts',
      );
    }
    expectedByKey.set(key, prior ?? charge);
  }

  const capturedByKey = new Map<string, Wp062EncounterCharge[]>();
  for (const charge of captured) {
    const key = chargeKey(charge);
    const copies = capturedByKey.get(key) ?? [];
    copies.push(charge);
    capturedByKey.set(key, copies);
  }

  const missing = [...expectedByKey.entries()]
    .filter(([key]) => !capturedByKey.has(key))
    .map(([, charge]) => charge);

  const posted: Wp062EncounterCharge[] = [];
  const duplicates: Wp062EncounterCharge[] = [];
  const conflicts: Wp062EncounterCharge[] = [];
  const amountMismatches: ChargeAmountMismatch[] = [];
  const unexpected: Wp062EncounterCharge[] = [];
  for (const [key, copies] of capturedByKey) {
    const [first, ...rest] = copies;
    if (first === undefined) continue;
    if (rest.some((copy) => !sameAmount(copy, first))) {
      conflicts.push(...copies);
      continue;
    }
    duplicates.push(...rest);
    const expectedCharge = expectedByKey.get(key);
    if (expectedCharge === undefined) {
      unexpected.push(first);
    } else if (!sameAmount(expectedCharge, first)) {
      amountMismatches.push({ expected: expectedCharge, captured: first });
    } else {
      posted.push(first);
    }
  }

  const heartbeat: ReconciliationHeartbeat = {
    runId,
    at,
    missingCount: missing.length,
    duplicateCount: duplicates.length,
    postedCount: posted.length,
    conflictCount: conflicts.length,
    amountMismatchCount: amountMismatches.length,
    unexpectedCount: unexpected.length,
  };
  heartbeats.record(heartbeat, scope);
  return { posted, missing, duplicates, conflicts, amountMismatches, unexpected, heartbeat };
}

import { RcmShadowError, WP062_PACKAGE_ID, type Wp062EncounterCharge } from './contracts.js';

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export interface ReconciliationHeartbeat {
  readonly runId: string;
  readonly at: string;
  readonly missingCount: number;
  readonly duplicateCount: number;
  readonly postedCount: number;
}

export interface ChargeReconciliation {
  readonly posted: readonly Wp062EncounterCharge[];
  readonly missing: readonly Wp062EncounterCharge[];
  readonly duplicates: readonly Wp062EncounterCharge[];
  readonly heartbeat: ReconciliationHeartbeat;
}

function assertCharge(charge: Wp062EncounterCharge): void {
  if (charge.packageId !== WP062_PACKAGE_ID) {
    throw new RcmShadowError('WP062_CHARGE', 'encounter charge must stand for WP-062');
  }
  if (!Number.isSafeInteger(charge.amountMinor) || charge.amountMinor < 0) {
    throw new RcmShadowError('WP062_CHARGE', 'amountMinor must be a non-negative safe integer');
  }
}

export function reconcileCharges(
  expected: readonly Wp062EncounterCharge[],
  captured: readonly Wp062EncounterCharge[],
  runId: string,
  at: string,
): ChargeReconciliation {
  if (runId.length === 0) {
    throw new RcmShadowError('CHARGE_RUN', 'reconciliation runId is required');
  }
  if (!INSTANT.test(at)) {
    throw new RcmShadowError('CHARGE_RUN', 'reconciliation timestamp must be YYYY-MM-DDTHH:MM:SSZ');
  }
  for (const charge of [...expected, ...captured]) {
    assertCharge(charge);
  }

  const capturedIds = new Set(captured.map((charge) => charge.chargeId));
  const missing = expected.filter((charge) => !capturedIds.has(charge.chargeId));

  const seen = new Set<string>();
  const duplicates: Wp062EncounterCharge[] = [];
  const posted: Wp062EncounterCharge[] = [];
  for (const charge of captured) {
    if (seen.has(charge.chargeId)) {
      duplicates.push(charge);
      continue;
    }
    seen.add(charge.chargeId);
    posted.push(charge);
  }

  const heartbeat: ReconciliationHeartbeat = {
    runId,
    at,
    missingCount: missing.length,
    duplicateCount: duplicates.length,
    postedCount: posted.length,
  };
  return { posted, missing, duplicates, heartbeat };
}

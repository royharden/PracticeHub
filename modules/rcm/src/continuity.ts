import {
  CONTINUITY_GAP_THRESHOLD_DAYS,
  RcmShadowError,
  WP066_PACKAGE_ID,
  type Wp066MedicationSource,
} from './contracts.js';

export type ContinuityLevel = 'open' | 'covering-prescriber' | 'medical-director';

export interface ContinuityAlert {
  readonly level: ContinuityLevel;
  readonly gapDays: number;
  readonly escalated: boolean;
  readonly acknowledged: boolean;
  readonly source: Wp066MedicationSource;
}

export interface PriorAuthClause {
  readonly clauseId: string;
  readonly text: string;
  readonly interimSource: string | null;
  readonly nativeRule: boolean;
}

export interface HonoredClause {
  readonly clauseId: string;
  readonly interimSource: string;
  readonly honored: true;
}

export interface ClauseDisposition {
  readonly honored: readonly HonoredClause[];
  readonly dropped: readonly string[];
}

function assertSource(source: Wp066MedicationSource): void {
  if (source.packageId !== WP066_PACKAGE_ID) {
    throw new RcmShadowError('WP066_SOURCE', 'medication source must stand for WP-066');
  }
  if (!Number.isSafeInteger(source.daysOfSupplyRemaining) || source.daysOfSupplyRemaining < 0) {
    throw new RcmShadowError(
      'WP066_SOURCE',
      'daysOfSupplyRemaining must be a non-negative integer',
    );
  }
  if (!Number.isSafeInteger(source.nextFillInDays) || source.nextFillInDays < 0) {
    throw new RcmShadowError('WP066_SOURCE', 'nextFillInDays must be a non-negative integer');
  }
}

export function continuityGapDays(source: Wp066MedicationSource): number {
  assertSource(source);
  return source.nextFillInDays - source.daysOfSupplyRemaining;
}

export function openContinuityAlert(source: Wp066MedicationSource): ContinuityAlert {
  return {
    level: 'open',
    gapDays: continuityGapDays(source),
    escalated: false,
    acknowledged: false,
    source,
  };
}

export function escalateContinuity(alert: ContinuityAlert): ContinuityAlert {
  const gapDays = continuityGapDays(alert.source);
  if (alert.acknowledged || gapDays <= CONTINUITY_GAP_THRESHOLD_DAYS) {
    return { ...alert, gapDays, escalated: false };
  }
  if (alert.level === 'open') {
    return { ...alert, level: 'covering-prescriber', gapDays, escalated: true };
  }
  if (alert.level === 'covering-prescriber') {
    return { ...alert, level: 'medical-director', gapDays, escalated: true };
  }
  return { ...alert, gapDays, escalated: true };
}

export function honorInterimClauses(clauses: readonly PriorAuthClause[]): ClauseDisposition {
  const honored: HonoredClause[] = [];
  const dropped: string[] = [];
  for (const clause of clauses) {
    if (clause.interimSource !== null && clause.interimSource.length > 0) {
      honored.push({
        clauseId: clause.clauseId,
        interimSource: clause.interimSource,
        honored: true,
      });
      continue;
    }
    if (!clause.nativeRule) {
      dropped.push(clause.clauseId);
    }
  }
  return { honored, dropped };
}

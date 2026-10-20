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
  /** Bound from the WP-066 source; escalation refuses any other tenant. */
  readonly tenantId: string;
  /** Set when the alert runs on the clock; null for a legacy step-mode alert. */
  readonly openedAt: string | null;
  readonly levelEnteredAt: string | null;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: string | null;
}

/** Minutes an unacknowledged alert may sit at a level before it escalates. */
export type ContinuitySla = Readonly<Record<Exclude<ContinuityLevel, 'medical-director'>, number>>;

export const DEFAULT_CONTINUITY_SLA_MINUTES: ContinuitySla = {
  open: 240,
  'covering-prescriber': 240,
};

export interface ContinuityEscalationEvent {
  readonly tenantId: string;
  readonly medicationId: string;
  readonly from: ContinuityLevel;
  readonly to: ContinuityLevel;
  readonly at: string;
  readonly gapDays: number;
  readonly minutesAtLevel: number;
}

export interface ContinuityEscalationSink {
  record(event: ContinuityEscalationEvent): void;
}

export class InMemoryContinuityEscalations implements ContinuityEscalationSink {
  readonly #events: ContinuityEscalationEvent[] = [];

  public record(event: ContinuityEscalationEvent): void {
    this.#events.push(Object.freeze({ ...event }));
  }

  public all(): readonly ContinuityEscalationEvent[] {
    return [...this.#events];
  }
}

export interface ContinuityClock {
  readonly now: string;
  /** The tenant the caller is acting for; must match the alert. */
  readonly tenantId: string;
  readonly sink?: ContinuityEscalationSink;
  readonly sla?: ContinuitySla;
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
  /** Clauses kept because a native rule governs them (no interim source). */
  readonly native: readonly string[];
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function minutesBetween(from: string, to: string): number {
  if (!INSTANT.test(from) || !INSTANT.test(to)) {
    throw new RcmShadowError('CONTINUITY_CLOCK', 'instants must be YYYY-MM-DDTHH:MM:SSZ');
  }
  const minutes = (Date.parse(to) - Date.parse(from)) / 60_000;
  if (minutes < 0) throw new RcmShadowError('CONTINUITY_CLOCK', 'the clock moved backwards');
  return minutes;
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
  if (source.tenantId.length === 0) {
    throw new RcmShadowError('WP066_SOURCE', 'medication source must name its tenant');
  }
}

export function continuityGapDays(source: Wp066MedicationSource): number {
  assertSource(source);
  return source.nextFillInDays - source.daysOfSupplyRemaining;
}

/**
 * Open an alert. With `openedAt` the alert runs on the clock and escalates
 * only as SLA time elapses; without it the alert keeps the legacy one-step
 * behaviour for existing callers.
 */
export function openContinuityAlert(
  source: Wp066MedicationSource,
  options?: { readonly openedAt: string },
): ContinuityAlert {
  if (options !== undefined && !INSTANT.test(options.openedAt)) {
    throw new RcmShadowError('CONTINUITY_CLOCK', 'openedAt must be YYYY-MM-DDTHH:MM:SSZ');
  }
  return {
    level: 'open',
    gapDays: continuityGapDays(source),
    escalated: false,
    acknowledged: false,
    source,
    tenantId: source.tenantId,
    openedAt: options?.openedAt ?? null,
    levelEnteredAt: options?.openedAt ?? null,
    acknowledgedBy: null,
    acknowledgedAt: null,
  };
}

function assertTenant(alert: ContinuityAlert, tenantId?: string): void {
  if (
    alert.tenantId !== alert.source.tenantId ||
    (tenantId !== undefined && tenantId !== alert.tenantId)
  ) {
    throw new RcmShadowError('CONTINUITY_TENANT', 'continuity alert crossed tenant scope');
  }
}

const nextLevel = (level: ContinuityLevel): ContinuityLevel | null =>
  level === 'open'
    ? 'covering-prescriber'
    : level === 'covering-prescriber'
      ? 'medical-director'
      : null;

/**
 * Escalates on the SLA clock only. The clock is required (the parameter stays optional in the
 * signature for compatibility, but a call without it throws). The legacy unclocked step mode is
 * removed: an alert opened without `openedAt` starts its clock at the first escalation call and
 * escalates only after the level SLA elapses from there.
 */
export function escalateContinuity(
  alert: ContinuityAlert,
  clock?: ContinuityClock,
): ContinuityAlert {
  assertTenant(alert, clock?.tenantId);
  const gapDays = continuityGapDays(alert.source);
  if (clock === undefined) {
    throw new RcmShadowError('CONTINUITY_CLOCK', 'a continuity alert escalates only with a clock');
  }
  if (alert.levelEnteredAt === null) {
    minutesBetween(clock.now, clock.now);
    return {
      ...alert,
      gapDays,
      escalated: false,
      openedAt: alert.openedAt ?? clock.now,
      levelEnteredAt: clock.now,
    };
  }
  return escalateOnClock(alert, gapDays, clock);
}

function escalateOnClock(
  alert: ContinuityAlert,
  gapDays: number,
  clock: ContinuityClock,
): ContinuityAlert {
  const enteredAt = alert.levelEnteredAt ?? clock.now;
  const minutesAtLevel = minutesBetween(enteredAt, clock.now);
  const to = nextLevel(alert.level);
  if (alert.acknowledged || gapDays <= CONTINUITY_GAP_THRESHOLD_DAYS || to === null) {
    return { ...alert, gapDays, escalated: false };
  }
  const sla = clock.sla ?? DEFAULT_CONTINUITY_SLA_MINUTES;
  const limit = alert.level === 'open' ? sla.open : sla['covering-prescriber'];
  if (minutesAtLevel < limit) return { ...alert, gapDays, escalated: false };
  clock.sink?.record({
    tenantId: alert.tenantId,
    medicationId: alert.source.medicationId,
    from: alert.level,
    to,
    at: clock.now,
    gapDays,
    minutesAtLevel,
  });
  return { ...alert, level: to, gapDays, escalated: true, levelEnteredAt: clock.now };
}

/** Acknowledgement stops escalation at the current level and is recorded. */
export function acknowledgeContinuityAlert(
  alert: ContinuityAlert,
  input: { readonly by: string; readonly at: string; readonly tenantId: string },
): ContinuityAlert {
  assertTenant(alert, input.tenantId);
  if (input.by.length === 0) {
    throw new RcmShadowError('CONTINUITY_ACK', 'acknowledgement must name who acknowledged');
  }
  if (!INSTANT.test(input.at)) {
    throw new RcmShadowError(
      'CONTINUITY_CLOCK',
      'acknowledgement time must be YYYY-MM-DDTHH:MM:SSZ',
    );
  }
  return {
    ...alert,
    acknowledged: true,
    acknowledgedBy: input.by,
    acknowledgedAt: input.at,
    escalated: false,
  };
}

export function honorInterimClauses(clauses: readonly PriorAuthClause[]): ClauseDisposition {
  const honored: HonoredClause[] = [];
  const dropped: string[] = [];
  const native: string[] = [];
  for (const clause of clauses) {
    if (clause.interimSource !== null && clause.interimSource.length > 0) {
      honored.push({
        clauseId: clause.clauseId,
        interimSource: clause.interimSource,
        honored: true,
      });
      continue;
    }
    if (clause.nativeRule) {
      native.push(clause.clauseId);
    } else {
      dropped.push(clause.clauseId);
    }
  }
  return { honored, dropped, native };
}

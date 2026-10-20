import { RcmShadowError } from './contracts.js';

/**
 * WP-084 fee-schedule freshness monitor. It compares the fee schedule loaded locally with the
 * reference schedule for the same payer and raises alarms when the local copy is stale or when the
 * two diverge in either direction. It never corrects a rate; it only alarms. Synthetic data only.
 */

export interface FeeScheduleRate {
  readonly code: string;
  readonly amountMinor: number;
}

export interface FeeScheduleSnapshot {
  readonly scheduleId: string;
  readonly payerId: string;
  readonly version: string;
  /** Day the payer published this version. */
  readonly publishedOn: string;
  /** Instant the schedule was loaded into PracticeHub (local) or observed (reference). */
  readonly loadedAt: string;
  readonly rates: readonly FeeScheduleRate[];
}

export interface FreshnessPolicy {
  /** A local schedule loaded more than this many days ago is stale. */
  readonly maxAgeDays: number;
  /** Per-code difference, in cents, that is tolerated before a divergence alarm. */
  readonly toleranceMinor: number;
}

export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = { maxAgeDays: 90, toleranceMinor: 0 };

export type FreshnessAlarmCode =
  | 'stale-load'
  | 'behind-reference'
  | 'ahead-of-reference'
  | 'divergent-above-reference'
  | 'divergent-below-reference'
  | 'missing-locally'
  | 'missing-in-reference';

export interface FreshnessAlarm {
  readonly code: FreshnessAlarmCode;
  readonly rateCode: string | null;
  readonly localMinor: number | null;
  readonly referenceMinor: number | null;
  readonly detail: string;
}

export interface FreshnessReport {
  readonly payerId: string;
  readonly checkedAt: string;
  readonly ageDays: number;
  readonly fresh: boolean;
  readonly alarms: readonly FreshnessAlarm[];
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DAY_MS = 86_400_000;

function instant(value: string, field: string): number {
  if (!INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new RcmShadowError('FEE_SCHEDULE', `${field} must be YYYY-MM-DDTHH:MM:SSZ`);
  }
  return Date.parse(value);
}

function assertSnapshot(snapshot: FeeScheduleSnapshot, label: string): Map<string, number> {
  if (
    !TOKEN.test(snapshot.scheduleId) ||
    !TOKEN.test(snapshot.payerId) ||
    snapshot.version.length === 0
  ) {
    throw new RcmShadowError('FEE_SCHEDULE', `${label} schedule needs id, payer, and version`);
  }
  if (!DAY.test(snapshot.publishedOn)) {
    throw new RcmShadowError('FEE_SCHEDULE', `${label} publishedOn must be YYYY-MM-DD`);
  }
  instant(snapshot.loadedAt, `${label} loadedAt`);
  const rates = new Map<string, number>();
  for (const rate of snapshot.rates) {
    if (!TOKEN.test(rate.code) || !Number.isSafeInteger(rate.amountMinor) || rate.amountMinor < 0) {
      throw new RcmShadowError(
        'FEE_SCHEDULE',
        `${label} rate must be a code and non-negative cents`,
      );
    }
    if (rates.has(rate.code)) {
      throw new RcmShadowError('FEE_SCHEDULE', `${label} schedule lists ${rate.code} twice`);
    }
    rates.set(rate.code, rate.amountMinor);
  }
  return rates;
}

export function monitorFeeScheduleFreshness(
  local: FeeScheduleSnapshot,
  reference: FeeScheduleSnapshot,
  now: string,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS_POLICY,
): FreshnessReport {
  if (
    !Number.isSafeInteger(policy.maxAgeDays) ||
    policy.maxAgeDays < 0 ||
    !Number.isSafeInteger(policy.toleranceMinor) ||
    policy.toleranceMinor < 0
  ) {
    throw new RcmShadowError('FEE_SCHEDULE', 'policy limits must be non-negative integers');
  }
  const localRates = assertSnapshot(local, 'local');
  const referenceRates = assertSnapshot(reference, 'reference');
  if (local.payerId !== reference.payerId) {
    throw new RcmShadowError(
      'FEE_SCHEDULE',
      'local and reference schedules are for different payers',
    );
  }
  const nowMs = instant(now, 'now');
  const loadedMs = instant(local.loadedAt, 'local loadedAt');
  if (loadedMs > nowMs) {
    throw new RcmShadowError('FEE_SCHEDULE', 'local schedule is loaded after the check instant');
  }

  const alarms: FreshnessAlarm[] = [];
  const ageDays = Math.floor((nowMs - loadedMs) / DAY_MS);
  if (ageDays > policy.maxAgeDays) {
    alarms.push({
      code: 'stale-load',
      rateCode: null,
      localMinor: null,
      referenceMinor: null,
      detail: `local ${local.version} loaded ${String(ageDays)}d ago; limit ${String(policy.maxAgeDays)}d`,
    });
  }
  if (reference.publishedOn > local.publishedOn) {
    alarms.push({
      code: 'behind-reference',
      rateCode: null,
      localMinor: null,
      referenceMinor: null,
      detail: `reference ${reference.version} published ${reference.publishedOn}; local ${local.version} published ${local.publishedOn}`,
    });
  } else if (reference.publishedOn < local.publishedOn) {
    alarms.push({
      code: 'ahead-of-reference',
      rateCode: null,
      localMinor: null,
      referenceMinor: null,
      detail: `local ${local.version} published ${local.publishedOn} is newer than reference ${reference.version}`,
    });
  }

  const codes = [...new Set([...localRates.keys(), ...referenceRates.keys()])].sort();
  for (const code of codes) {
    const mine = localRates.get(code);
    const theirs = referenceRates.get(code);
    if (mine === undefined) {
      alarms.push({
        code: 'missing-locally',
        rateCode: code,
        localMinor: null,
        referenceMinor: theirs ?? null,
        detail: `${code} is in the reference only`,
      });
      continue;
    }
    if (theirs === undefined) {
      alarms.push({
        code: 'missing-in-reference',
        rateCode: code,
        localMinor: mine,
        referenceMinor: null,
        detail: `${code} is local only`,
      });
      continue;
    }
    const diff = mine - theirs;
    if (diff > policy.toleranceMinor) {
      alarms.push({
        code: 'divergent-above-reference',
        rateCode: code,
        localMinor: mine,
        referenceMinor: theirs,
        detail: `${code} local ${String(mine)} > reference ${String(theirs)}`,
      });
    } else if (-diff > policy.toleranceMinor) {
      alarms.push({
        code: 'divergent-below-reference',
        rateCode: code,
        localMinor: mine,
        referenceMinor: theirs,
        detail: `${code} local ${String(mine)} < reference ${String(theirs)}`,
      });
    }
  }
  return { payerId: local.payerId, checkedAt: now, ageDays, fresh: alarms.length === 0, alarms };
}

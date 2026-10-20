import { RcmShadowError } from '../contracts.js';
import type { FeeSchedule, ServicePayment } from './types.js';

export type PaymentVarianceKind = 'underpaid' | 'overpaid' | 'no-rate' | 'no-schedule';

export interface PaymentVariance {
  readonly lineId: string;
  readonly code: string;
  readonly kind: PaymentVarianceKind;
  readonly scheduleId: string | null;
  readonly scheduleVersion: string | null;
  readonly expectedMinor: number | null;
  readonly allowedMinor: number;
  /** Expected minus allowed; positive when underpaid. */
  readonly varianceMinor: number | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function scheduleFor(
  schedules: readonly FeeSchedule[],
  tenantId: string,
  payerId: string,
  serviceDate: string,
): FeeSchedule | null {
  let chosen: FeeSchedule | null = null;
  for (const schedule of schedules) {
    if (
      schedule.tenantId !== tenantId ||
      schedule.payerId !== payerId ||
      schedule.effectiveOn > serviceDate
    ) {
      continue;
    }
    if (chosen === null || schedule.effectiveOn > chosen.effectiveOn) {
      chosen = schedule;
    }
  }
  return chosen;
}

/**
 * Compares each 835 service line's allowed amount with the fee schedule
 * loaded for that tenant and payer on the service date. Both directions are reported,
 * to the penny: an overpayment is as much a stale-schedule signal as an
 * underpayment.
 */
export function detectPaymentVariances(
  schedules: readonly FeeSchedule[],
  tenantId: string,
  payerId: string,
  lines: readonly ServicePayment[],
): readonly PaymentVariance[] {
  const variances: PaymentVariance[] = [];
  for (const line of lines) {
    if (!DAY.test(line.serviceDate) || !Number.isSafeInteger(line.units) || line.units <= 0) {
      throw new RcmShadowError('POSTING_LINE', 'service lines need a date and positive units');
    }
    const schedule = scheduleFor(schedules, tenantId, payerId, line.serviceDate);
    if (schedule === null) {
      variances.push({
        lineId: line.lineId,
        code: line.code,
        kind: 'no-schedule',
        scheduleId: null,
        scheduleVersion: null,
        expectedMinor: null,
        allowedMinor: line.allowedMinor,
        varianceMinor: null,
      });
      continue;
    }
    const rate = schedule.rates[line.code];
    if (rate === undefined) {
      variances.push({
        lineId: line.lineId,
        code: line.code,
        kind: 'no-rate',
        scheduleId: schedule.scheduleId,
        scheduleVersion: schedule.version,
        expectedMinor: null,
        allowedMinor: line.allowedMinor,
        varianceMinor: null,
      });
      continue;
    }
    const expectedMinor = rate * line.units;
    if (!Number.isSafeInteger(expectedMinor)) {
      throw new RcmShadowError('POSTING_RATE', 'expected amount overflows');
    }
    const varianceMinor = expectedMinor - line.allowedMinor;
    if (varianceMinor === 0) {
      continue;
    }
    variances.push({
      lineId: line.lineId,
      code: line.code,
      kind: varianceMinor > 0 ? 'underpaid' : 'overpaid',
      scheduleId: schedule.scheduleId,
      scheduleVersion: schedule.version,
      expectedMinor,
      allowedMinor: line.allowedMinor,
      varianceMinor,
    });
  }
  return variances;
}

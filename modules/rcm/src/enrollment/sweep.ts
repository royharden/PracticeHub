import { RcmShadowError } from '../contracts.js';

import { verifyPayerPathDiversity, type PathRoute } from './diversity.js';
import type { EnrollmentTransaction, PathId } from './paths.js';
import { parseEnrollmentInstant, type EnrollmentRegistry } from './registry.js';

export interface SweepPolicy {
  /** A requested or pending-payer enrollment older than this is escalated. */
  readonly pendingMaxDays: number;
  /** An enrolled path whose newest evidence is older than this needs fresh evidence. */
  readonly evidenceMaxAgeDays: number;
}

export const DEFAULT_SWEEP_POLICY: SweepPolicy = { pendingMaxDays: 30, evidenceMaxAgeDays: 365 };

export type SweepItemCode =
  'route-gap' | 'rejected-open' | 'suspended' | 'stale-pending' | 'evidence-stale';

/** Lower rank sorts first: a route gap can strand claims today, stale evidence cannot. */
const RANK: Readonly<Record<SweepItemCode, number>> = {
  'route-gap': 0,
  'rejected-open': 1,
  suspended: 2,
  'stale-pending': 3,
  'evidence-stale': 4,
};

export interface SweepItem {
  readonly code: SweepItemCode;
  readonly payerId: string;
  readonly pathId: PathId | null;
  readonly transaction: EnrollmentTransaction | null;
  readonly ageDays: number | null;
  readonly detail: string;
}

export interface SweepReport {
  readonly sweptAt: string;
  readonly recordsSwept: number;
  readonly items: readonly SweepItem[];
  readonly counts: Readonly<Record<SweepItemCode, number>>;
}

const DAY_MS = 86_400_000;

function ageDays(nowMs: number, instant: string): number {
  return Math.floor((nowMs - Date.parse(instant)) / DAY_MS);
}

/**
 * Sweeps the enrollment registry into an ordered worklist (payer x transaction x status).
 * Passing routes adds the diversity check so a route that relies on an unenrolled or
 * shared-upstream secondary shows up on the same worklist.
 */
export function sweepEnrollment(
  registry: EnrollmentRegistry,
  now: string,
  routes: readonly PathRoute[] = [],
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): SweepReport {
  const nowMs = parseEnrollmentInstant(now, 'SWEEP_NOW');
  if (
    !Number.isSafeInteger(policy.pendingMaxDays) ||
    !Number.isSafeInteger(policy.evidenceMaxAgeDays) ||
    policy.pendingMaxDays < 0 ||
    policy.evidenceMaxAgeDays < 0
  ) {
    throw new RcmShadowError('SWEEP_POLICY', 'sweep limits must be non-negative whole days');
  }
  const items: SweepItem[] = [];
  const records = registry.list();

  for (const record of records) {
    if (record.since === null) {
      continue;
    }
    if (Date.parse(record.since) > nowMs) {
      throw new RcmShadowError('SWEEP_NOW', 'registry holds a transition after the sweep instant');
    }
    const base = {
      payerId: record.payerId,
      pathId: record.pathId,
      transaction: record.transaction,
    };
    const sinceDays = ageDays(nowMs, record.since);
    switch (record.state) {
      case 'rejected':
        items.push({
          ...base,
          code: 'rejected-open',
          ageDays: sinceDays,
          detail: 'rejected; re-request or retire the path',
        });
        break;
      case 'suspended':
        items.push({
          ...base,
          code: 'suspended',
          ageDays: sinceDays,
          detail: 'suspended by payer or rail',
        });
        break;
      case 'requested':
      case 'pending-payer':
        if (sinceDays > policy.pendingMaxDays) {
          items.push({
            ...base,
            code: 'stale-pending',
            ageDays: sinceDays,
            detail: `${record.state} for ${sinceDays}d exceeds ${policy.pendingMaxDays}d`,
          });
        }
        break;
      case 'enrolled': {
        const evidenceDays =
          record.evidenceDate === null ? null : ageDays(nowMs, record.evidenceDate);
        if (evidenceDays === null || evidenceDays > policy.evidenceMaxAgeDays) {
          items.push({
            ...base,
            code: 'evidence-stale',
            ageDays: evidenceDays,
            detail: `newest evidence ${evidenceDays ?? 'missing'}d exceeds ${policy.evidenceMaxAgeDays}d`,
          });
        }
        break;
      }
      case 'not-enrolled':
      case 'terminated':
        break;
    }
  }

  if (routes.length > 0) {
    for (const result of verifyPayerPathDiversity(routes, registry.pathCatalog(), registry)) {
      for (const finding of result.findings) {
        if (finding.severity !== 'block') {
          continue;
        }
        items.push({
          code: 'route-gap',
          payerId: result.payerId,
          pathId:
            finding.leg === 'secondary'
              ? result.secondary
              : finding.leg === 'primary'
                ? result.primary
                : null,
          transaction: null,
          ageDays: null,
          detail: `${result.purpose} ${finding.code}: ${finding.detail}`,
        });
      }
    }
  }

  items.sort(
    (left, right) =>
      RANK[left.code] - RANK[right.code] ||
      (right.ageDays ?? -1) - (left.ageDays ?? -1) ||
      left.payerId.localeCompare(right.payerId) ||
      (left.pathId ?? '').localeCompare(right.pathId ?? '') ||
      (left.transaction ?? '').localeCompare(right.transaction ?? '') ||
      left.detail.localeCompare(right.detail),
  );

  const counts: Record<SweepItemCode, number> = {
    'route-gap': 0,
    'rejected-open': 0,
    suspended: 0,
    'stale-pending': 0,
    'evidence-stale': 0,
  };
  for (const item of items) {
    counts[item.code] += 1;
  }
  return { sweptAt: now, recordsSwept: records.length, items, counts };
}

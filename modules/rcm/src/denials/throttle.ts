import { RcmShadowError } from '../contracts.js';

import { parseDenialInstant, type DenialItem, type DenialQueues } from './queue.js';

export interface AppealThrottlePolicy {
  /** Most appeals one payer receives inside one sliding window. */
  readonly maxPerPayerPerWindow: number;
  readonly windowHours: number;
  /** Most appeals sent by one batch call, across payers. */
  readonly maxBatchSize: number;
}

export const DEFAULT_APPEAL_THROTTLE: AppealThrottlePolicy = {
  maxPerPayerPerWindow: 25,
  windowHours: 24,
  maxBatchSize: 50,
};

export interface DeferredAppeal {
  readonly denialId: string;
  readonly reason: 'payer-throttle' | 'batch-size';
  readonly notBefore: string;
  /** True when waiting for `notBefore` would pass the item's deadline: escalate, do not wait. */
  readonly deadlineConflict: boolean;
}

export interface RefusedAppeal {
  readonly denialId: string;
  readonly reason: string;
}

export interface AppealBatchResult {
  readonly sent: readonly string[];
  readonly deferred: readonly DeferredAppeal[];
  readonly refused: readonly RefusedAppeal[];
}

const HOUR_MS = 3_600_000;

/** The deadline an appeal must meet: the appeal window, not the corrected-claim limit. */
function appealDeadline(item: DenialItem): string {
  return (
    item.deadlines.find((deadline) => deadline.source !== 'timely-filing')?.at ?? item.deadline
  );
}

function toInstant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Throttles batch appeals per payer over a sliding window. Within the allowance the items
 * closest to their deadline go first, then the larger weighted dollars, so throttling delays
 * the least urgent appeals and reports any it cannot fit before their deadline.
 */
export class AppealThrottle {
  private readonly sends = new Map<string, number[]>();
  /** Batch-ordering clock per tenant: one tenant's later batch never refuses another's (NR-153). */
  private readonly lastBatchMs = new Map<string, number>();

  public constructor(
    private readonly queues: DenialQueues,
    private readonly policy: AppealThrottlePolicy = DEFAULT_APPEAL_THROTTLE,
  ) {
    for (const value of [policy.maxPerPayerPerWindow, policy.windowHours, policy.maxBatchSize]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RcmShadowError('APPEAL_POLICY', 'throttle limits must be positive whole numbers');
      }
    }
  }

  /** Sends one tenant's appeals. Ids from another tenant read as not queued. */
  public submitBatch(
    tenantId: string,
    denialIds: readonly string[],
    now: string,
    actor: string,
  ): AppealBatchResult {
    const nowMs = parseDenialInstant(now, 'APPEAL_NOW');
    const previous = this.lastBatchMs.get(tenantId);
    if (previous !== undefined && nowMs < previous) {
      throw new RcmShadowError('APPEAL_NOW', 'a batch cannot run before the previous one');
    }
    this.lastBatchMs.set(tenantId, nowMs);
    const windowMs = this.policy.windowHours * HOUR_MS;
    const refused: RefusedAppeal[] = [];
    const seen = new Set<string>();
    const candidates: DenialItem[] = [];
    for (const denialId of denialIds) {
      if (seen.has(denialId)) {
        refused.push({ denialId, reason: 'listed twice in one batch' });
        continue;
      }
      seen.add(denialId);
      let item: DenialItem;
      try {
        item = this.queues.get(tenantId, denialId);
      } catch {
        refused.push({ denialId, reason: 'not queued' });
        continue;
      }
      if (item.status !== 'open') {
        refused.push({ denialId, reason: `status ${item.status}` });
        continue;
      }
      candidates.push(item);
    }
    candidates.sort(
      (left, right) =>
        appealDeadline(left).localeCompare(appealDeadline(right)) ||
        right.weightedMinor - left.weightedMinor ||
        left.denialId.localeCompare(right.denialId),
    );

    const sent: string[] = [];
    const deferred: DeferredAppeal[] = [];
    for (const item of candidates) {
      // The allowance is per (tenant, payer): one tenant's appeals never spend another's.
      const windowKey = `${tenantId}\u001f${item.payerId}`;
      const recent = (this.sends.get(windowKey) ?? []).filter((at) => at > nowMs - windowMs);
      this.sends.set(windowKey, recent);
      const deadlineMs = Date.parse(appealDeadline(item));
      if (sent.length >= this.policy.maxBatchSize) {
        deferred.push({
          denialId: item.denialId,
          reason: 'batch-size',
          notBefore: now,
          deadlineConflict: deadlineMs < nowMs,
        });
        continue;
      }
      if (recent.length >= this.policy.maxPerPayerPerWindow) {
        const notBeforeMs = (recent[0] ?? nowMs) + windowMs;
        deferred.push({
          denialId: item.denialId,
          reason: 'payer-throttle',
          notBefore: toInstant(notBeforeMs),
          deadlineConflict: deadlineMs < notBeforeMs,
        });
        continue;
      }
      try {
        this.queues.markAppealed(tenantId, item.denialId, now, actor);
      } catch (error) {
        refused.push({
          denialId: item.denialId,
          reason: error instanceof Error ? error.message : 'refused',
        });
        continue;
      }
      recent.push(nowMs);
      sent.push(item.denialId);
    }
    return { sent, deferred, refused };
  }
}

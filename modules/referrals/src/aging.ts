/**
 * Aging queues (WP-074 acceptance 2). Every open loop has an age in its
 * current stage; past a stage threshold it surfaces on a queue without anyone
 * reviewing it by hand (REQ-REF-015 AC2, AC6). Office-side delays go to the
 * chase list, patient-side delays to patient follow-up (REQ-REF-015 EX4), and
 * holds to their own queues, so nothing inflates the chase list. Aging only
 * reports and escalates; it never closes a loop.
 */

import type { LoopStage, ReferralCase } from './contracts.js';
import { daysBetween, escalate, instant, OUTER_BOUND_DAYS } from './loop.js';

export interface AgingConfig {
  /** Business days from send to acknowledgement (REQ-REF-013 AC7). */
  readonly ackBusinessDays: number;
  /** Business days from send to acknowledgement for an urgent referral (REQ-REF-013 EX4). */
  readonly urgentAckBusinessDays: number;
  readonly scheduleDays: number;
  readonly reviewDays: number;
  readonly outerBoundDays: number;
}

export const DEFAULT_AGING: AgingConfig = {
  ackBusinessDays: 5,
  urgentAckBusinessDays: 1,
  scheduleDays: 10,
  reviewDays: 3,
  outerBoundDays: OUTER_BOUND_DAYS,
};

/** Weekdays elapsed after `from` up to and including `to` (UTC). */
export function businessDaysBetween(from: string, to: string): number {
  const start = new Date(instant(from, 'start instant'));
  const end = new Date(instant(to, 'end instant'));
  let count = 0;
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (cursor.getTime() < last) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      count += 1;
    }
  }
  return count;
}

export type QueueName =
  'chase' | 'patient-follow-up' | 'consent-blocked' | 'send-failed' | 'review';

export interface AgingItem {
  readonly referralId: string;
  readonly queue: QueueName;
  readonly stage: LoopStage;
  readonly daysOutstanding: number;
  readonly why: string;
}

export interface AgingQueues {
  readonly chase: readonly AgingItem[];
  readonly patientFollowUp: readonly AgingItem[];
  readonly consentBlocked: readonly AgingItem[];
  readonly sendFailed: readonly AgingItem[];
  readonly review: readonly AgingItem[];
}

function lastStageAt(referral: ReferralCase): string {
  const last = referral.stages.at(-1);
  if (!last) {
    throw new Error(`referral ${referral.referralId} has no stage history`);
  }
  return last.at;
}

function holdItem(referral: ReferralCase, now: string): AgingItem | null {
  const open = referral.holds.find((existing) => existing.released === null);
  if (!open) {
    return null;
  }
  const queue: QueueName =
    open.reason === 'patient-follow-up'
      ? 'patient-follow-up'
      : open.reason === 'send-failed'
        ? 'send-failed'
        : open.reason === 'missing-information'
          ? 'chase'
          : 'consent-blocked';
  return {
    referralId: referral.referralId,
    queue,
    stage: referral.stage,
    daysOutstanding: daysBetween(open.at, now),
    why: open.detail,
  };
}

function stageItem(referral: ReferralCase, now: string, config: AgingConfig): AgingItem | null {
  const since = lastStageAt(referral);
  const days = daysBetween(since, now);
  const item = (queue: QueueName, why: string): AgingItem => ({
    referralId: referral.referralId,
    queue,
    stage: referral.stage,
    daysOutstanding: days,
    why,
  });
  switch (referral.stage) {
    case 'sent': {
      const limit =
        referral.urgency === 'urgent' ? config.urgentAckBusinessDays : config.ackBusinessDays;
      return businessDaysBetween(since, now) > limit
        ? item('chase', `no acknowledgement within ${String(limit)} business days`)
        : null;
    }
    case 'acknowledged':
      return days > config.scheduleDays
        ? item('chase', `no appointment within ${String(config.scheduleDays)} days`)
        : null;
    case 'scheduled':
    case 'seen':
      return days > referral.expectedReturnDays
        ? item('chase', `no consult note within ${String(referral.expectedReturnDays)} days`)
        : null;
    case 'results-returned':
      return days > config.reviewDays
        ? item('review', `results awaiting referring review for ${String(days)} days`)
        : null;
    case 'created':
    case 'reviewed':
    case 'closed':
      return null;
  }
}

/** Build the worklists, each ranked by days outstanding (REQ-REF-015 AC2). */
export function ageQueues(
  referrals: readonly ReferralCase[],
  now: string,
  config: AgingConfig = DEFAULT_AGING,
): AgingQueues {
  const items: AgingItem[] = [];
  for (const referral of referrals) {
    if (referral.stage === 'closed') {
      continue;
    }
    const item = holdItem(referral, now) ?? stageItem(referral, now, config);
    if (item) {
      items.push(item);
    }
  }
  const ranked = (queue: QueueName): readonly AgingItem[] =>
    items
      .filter((item) => item.queue === queue)
      .sort(
        (left, right) =>
          right.daysOutstanding - left.daysOutstanding ||
          left.referralId.localeCompare(right.referralId),
      );
  return {
    chase: ranked('chase'),
    patientFollowUp: ranked('patient-follow-up'),
    consentBlocked: ranked('consent-blocked'),
    sendFailed: ranked('send-failed'),
    review: ranked('review'),
  };
}

/**
 * Escalations that aging raises (idempotent): an urgent referral with no
 * acknowledgement goes to the ordering provider at once (REQ-REF-013 EX4); a
 * loop past the outer bound with no note goes to the referring clinician
 * (REQ-REF-015 EX3).
 */
export function escalateAging(
  referral: ReferralCase,
  now: string,
  config: AgingConfig = DEFAULT_AGING,
): ReferralCase {
  if (referral.stage === 'closed') {
    return referral;
  }
  let next = referral;
  const sentAt = referral.stages.findLast((event) => event.stage === 'sent')?.at ?? null;
  if (sentAt === null) {
    return next;
  }
  if (
    referral.urgency === 'urgent' &&
    referral.stage === 'sent' &&
    businessDaysBetween(sentAt, now) > config.urgentAckBusinessDays
  ) {
    next = escalate(next, now, 'ordering-provider', 'urgent referral not acknowledged');
  }
  const noNote = referral.consultNoteRef === null;
  if (noNote && daysBetween(sentAt, now) >= config.outerBoundDays) {
    next = escalate(next, now, 'referring-clinician', 'outer bound passed with no consult note');
  }
  return next;
}

export interface ClosureRow {
  readonly key: string;
  readonly total: number;
  readonly closed: number;
  readonly closureRate: number;
  /** Share of loops closed on reviewed results; a low value marks a non-responsive partner. */
  readonly resultsClosureRate: number;
  readonly averageDaysToClose: number | null;
}

/** Loop-closure report (REQ-REF-015 AC4, AC9), by referrer, destination or location. */
export function closureReport(
  referrals: readonly ReferralCase[],
  by: 'referringNpi' | 'destinationNpi' | 'location',
): readonly ClosureRow[] {
  const groups = new Map<string, ReferralCase[]>();
  for (const referral of referrals) {
    const key = referral[by];
    groups.set(key, [...(groups.get(key) ?? []), referral]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, members]) => {
      const closed = members.filter((member) => member.closure !== null);
      const durations = closed.map((member) =>
        daysBetween(member.stages[0]?.at ?? member.closure?.at ?? '', member.closure?.at ?? ''),
      );
      const total = durations.reduce((sum, value) => sum + value, 0);
      return {
        key,
        total: members.length,
        closed: closed.length,
        closureRate: closed.length / members.length,
        resultsClosureRate:
          closed.filter((member) => member.closure?.reason === 'results-reviewed').length /
          members.length,
        averageDaysToClose: durations.length === 0 ? null : total / durations.length,
      };
    });
}

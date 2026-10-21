import type { ClaimRecord, ClaimState } from '../claims/index.js';
import { RcmShadowError } from '../contracts.js';

import {
  routeCarcRarc,
  type CarcAdjustment,
  type CarcRouting,
  type DenialQueueId,
} from './carc.js';

/** The WP-086 claim fields a denial needs. Built from WP-086's `ClaimRecord`. */
export type DenialClaimRef = Pick<
  ClaimRecord,
  'claimId' | 'tenantId' | 'payerId' | 'controlNumber' | 'totalMinor' | 'state'
>;

/**
 * WP-086 states an 835 remit denial can land on: a partial denial on an accepted claim, or a
 * denial on a finalized one. `payer-rejected` is a 277CA front-end rejection, not a remit
 * denial: it is corrected and resubmitted through the claim lifecycle, never queued here.
 */
export const DENIABLE_CLAIM_STATES: readonly ClaimState[] = ['payer-accepted', 'finalized'];

export interface PayerDeadlinePolicy {
  readonly payerId: string;
  /** Days from the remit to file an appeal. */
  readonly appealWindowDays: number;
  /** Days from the date of service to file or correct a claim. */
  readonly timelyFilingDays: number;
  /** Days after an appeal is sent before an unanswered appeal needs follow-up. */
  readonly appealResponseDays?: number;
}

/** Used only when no payer policy exists; short on purpose, and flagged on the item. */
export const CONSERVATIVE_DEADLINE_DAYS = 30;

export const DEFAULT_APPEAL_RESPONSE_DAYS = 45;

/** Per-queue recoverability used to weight denied dollars. Synthetic defaults. */
export const RECOVERABILITY: Readonly<Record<DenialQueueId, number>> = {
  'coding-review': 0.8,
  bundling: 0.5,
  'eligibility-coverage': 0.4,
  authorization: 0.5,
  'medical-necessity': 0.6,
  documentation: 0.85,
  'timely-filing': 0.3,
  duplicate: 0.1,
  'patient-responsibility': 0.9,
  'general-review': 0.5,
};

/** Queues whose items can be appealed to the payer. */
export const APPEALABLE_QUEUES: readonly DenialQueueId[] = [
  'coding-review',
  'bundling',
  'eligibility-coverage',
  'authorization',
  'medical-necessity',
  'documentation',
  'timely-filing',
  'general-review',
];

export interface DenialIntake {
  readonly denialId: string;
  readonly claim: DenialClaimRef;
  readonly adjustments: readonly CarcAdjustment[];
  readonly rarcs: readonly string[];
  readonly deniedMinor: number;
  readonly serviceDate: string;
  readonly remitReceivedAt: string;
}

export type DenialStatus = 'open' | 'appealed' | 'resolved';

export type DenialResolution =
  | 'corrected-resubmitted'
  | 'written-off'
  | 'patient-billed'
  | 'paid-on-appeal'
  | 'upheld-on-appeal'
  | 'closed-no-action';

export type DeadlineSource = 'appeal-window' | 'timely-filing' | 'conservative-default';

export interface ItemDeadline {
  readonly source: DeadlineSource;
  readonly at: string;
}

export interface DenialItem {
  readonly denialId: string;
  readonly claimId: string;
  readonly tenantId: string;
  readonly payerId: string;
  readonly queue: DenialQueueId;
  readonly routing: CarcRouting;
  readonly deniedMinor: number;
  readonly weightedMinor: number;
  /** The earliest of `deadlines`: the one that binds first. Never changes after intake. */
  readonly deadline: string;
  readonly deadlineSource: DeadlineSource;
  /** Every filing limit tracked for this item: the appeal window and the corrected-claim limit. */
  readonly deadlines: readonly ItemDeadline[];
  readonly status: DenialStatus;
  readonly resolution: DenialResolution | null;
  readonly appealedAt: string | null;
  /** When an unanswered appeal needs follow-up; null until appealed. */
  readonly followUpAt: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedPastDeadline: boolean;
  /** True when the appeal was sent after the appeal deadline (NR-154): flagged, not only logged. */
  readonly appealedPastDeadline: boolean;
  readonly log: readonly string[];
}

export type RiskBand = 'missed' | 'appeal-follow-up' | 'at-risk' | 'on-track';

export interface WorklistEntry extends DenialItem {
  /** The earliest deadline not yet passed, or the last one when all have passed. */
  readonly activeDeadline: string;
  readonly activeDeadlineSource: DeadlineSource;
  /** Deadlines already passed: shown, never silently dropped. */
  readonly lapsed: readonly DeadlineSource[];
  readonly daysToDeadline: number;
  readonly band: RiskBand;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function parseDenialInstant(value: string, code: string): number {
  if (!INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new RcmShadowError(code, 'timestamp must be YYYY-MM-DDTHH:MM:SSZ');
  }
  return Date.parse(value);
}

function toInstant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function itemKey(tenantId: string, denialId: string): string {
  return `${tenantId}\u001f${denialId}`;
}

type MutableItem = {
  -readonly [K in keyof DenialItem]: DenialItem[K];
};

/**
 * Denial, appeal and filing-deadline queues, scoped by tenant. Every filing limit is computed
 * once at intake and never changes; an item leaves the worklist only through an explicit,
 * logged resolution, so a filing deadline cannot be lost by routing, reprioritising or a
 * missed date. Another tenant's items are invisible: an id from another tenant reads exactly
 * like an id that does not exist.
 */
export class DenialQueues {
  private readonly items = new Map<string, MutableItem>();
  private readonly policies = new Map<string, PayerDeadlinePolicy>();

  public constructor(
    policies: readonly PayerDeadlinePolicy[],
    private readonly riskWindowDays = 14,
  ) {
    if (!Number.isSafeInteger(riskWindowDays) || riskWindowDays < 0) {
      throw new RcmShadowError('DENIAL_POLICY', 'risk window must be non-negative whole days');
    }
    for (const policy of policies) {
      const response = policy.appealResponseDays ?? DEFAULT_APPEAL_RESPONSE_DAYS;
      if (
        !TOKEN.test(policy.payerId) ||
        !Number.isSafeInteger(policy.appealWindowDays) ||
        !Number.isSafeInteger(policy.timelyFilingDays) ||
        !Number.isSafeInteger(response) ||
        policy.appealWindowDays <= 0 ||
        policy.timelyFilingDays <= 0 ||
        response <= 0
      ) {
        throw new RcmShadowError(
          'DENIAL_POLICY',
          'payer policy needs a token id and positive day counts',
        );
      }
      if (this.policies.has(policy.payerId)) {
        throw new RcmShadowError('DENIAL_POLICY', 'one deadline policy per payer');
      }
      this.policies.set(policy.payerId, policy);
    }
  }

  public intake(intake: DenialIntake): DenialItem {
    const tenantId = intake.claim.tenantId;
    if (!TOKEN.test(tenantId)) {
      throw new RcmShadowError('DENIAL_TENANT', 'tenantId must be a token');
    }
    if (!TOKEN.test(intake.denialId)) {
      throw new RcmShadowError('DENIAL_ID', 'denialId must be a token');
    }
    if (this.items.has(itemKey(tenantId, intake.denialId))) {
      throw new RcmShadowError('DENIAL_DUPLICATE', 'denial is already queued');
    }
    if (!DENIABLE_CLAIM_STATES.includes(intake.claim.state)) {
      throw new RcmShadowError(
        'DENIAL_CLAIM_STATE',
        `a ${intake.claim.state} claim has no remit denial`,
      );
    }
    if (
      !Number.isSafeInteger(intake.deniedMinor) ||
      intake.deniedMinor <= 0 ||
      intake.deniedMinor > intake.claim.totalMinor
    ) {
      throw new RcmShadowError(
        'DENIAL_AMOUNT',
        'denied amount must be positive and within the claim total',
      );
    }
    if (!DATE.test(intake.serviceDate) || Number.isNaN(Date.parse(intake.serviceDate))) {
      throw new RcmShadowError('DENIAL_SERVICE_DATE', 'serviceDate must be YYYY-MM-DD');
    }
    const remitMs = parseDenialInstant(intake.remitReceivedAt, 'DENIAL_REMIT');
    const serviceMs = Date.parse(`${intake.serviceDate}T00:00:00Z`);
    if (serviceMs > remitMs) {
      throw new RcmShadowError('DENIAL_SERVICE_DATE', 'service date is after the remit');
    }
    const routing = routeCarcRarc(intake.adjustments, intake.rarcs);
    const policy = this.policies.get(intake.claim.payerId);

    // Both limits are tracked for every item: a denial worked by corrected resubmission is
    // bound by timely filing even when the appeal window runs longer.
    const deadlines: ItemDeadline[] =
      policy === undefined
        ? [
            {
              source: 'conservative-default',
              at: toInstant(remitMs + CONSERVATIVE_DEADLINE_DAYS * DAY_MS),
            },
          ]
        : [
            {
              source: 'timely-filing',
              at: toInstant(serviceMs + policy.timelyFilingDays * DAY_MS),
            },
            { source: 'appeal-window', at: toInstant(remitMs + policy.appealWindowDays * DAY_MS) },
          ];
    deadlines.sort(
      (left, right) => left.at.localeCompare(right.at) || left.source.localeCompare(right.source),
    );
    const binding = deadlines[0] ?? { source: 'conservative-default', at: toInstant(remitMs) };

    const item: MutableItem = {
      denialId: intake.denialId,
      claimId: intake.claim.claimId,
      tenantId,
      payerId: intake.claim.payerId,
      queue: routing.queue,
      routing,
      deniedMinor: intake.deniedMinor,
      weightedMinor: Math.round(intake.deniedMinor * RECOVERABILITY[routing.queue]),
      deadline: binding.at,
      deadlineSource: binding.source,
      deadlines,
      status: 'open',
      resolution: null,
      appealedAt: null,
      followUpAt: null,
      resolvedAt: null,
      resolvedPastDeadline: false,
      appealedPastDeadline: false,
      log: [
        `${intake.remitReceivedAt} intake ${routing.trace}; deadlines ${deadlines
          .map((deadline) => `${deadline.source} ${deadline.at}`)
          .join(', ')}`,
      ],
    };
    this.items.set(itemKey(tenantId, item.denialId), item);
    return this.snapshot(item);
  }

  public get(tenantId: string, denialId: string): DenialItem {
    return this.snapshot(this.require(tenantId, denialId));
  }

  /** Called by the appeal throttle once an appeal is actually sent. */
  public markAppealed(tenantId: string, denialId: string, at: string, actor: string): DenialItem {
    const item = this.require(tenantId, denialId);
    const atMs = parseDenialInstant(at, 'DENIAL_APPEAL');
    if (item.status !== 'open') {
      throw new RcmShadowError('DENIAL_APPEAL', `a ${item.status} denial cannot be appealed`);
    }
    if (!APPEALABLE_QUEUES.includes(item.queue)) {
      throw new RcmShadowError('DENIAL_APPEAL', `${item.queue} items are not appealable`);
    }
    if (!TOKEN.test(actor)) {
      throw new RcmShadowError('DENIAL_ACTOR', 'actor must be a token');
    }
    const appealDeadline = item.deadlines.find(
      (deadline) => deadline.source !== 'timely-filing',
    ) ?? {
      at: item.deadline,
    };
    const responseDays =
      this.policies.get(item.payerId)?.appealResponseDays ?? DEFAULT_APPEAL_RESPONSE_DAYS;
    const late = atMs > Date.parse(appealDeadline.at);
    item.status = 'appealed';
    item.appealedAt = at;
    item.appealedPastDeadline = late;
    item.followUpAt = toInstant(atMs + responseDays * DAY_MS);
    item.log = [
      ...item.log,
      `${at} appealed by ${actor}${late ? ' AFTER APPEAL DEADLINE' : ''}; follow up ${item.followUpAt}`,
    ];
    return this.snapshot(item);
  }

  public resolve(
    tenantId: string,
    denialId: string,
    resolution: DenialResolution,
    at: string,
    actor: string,
    reason: string,
  ): DenialItem {
    const item = this.require(tenantId, denialId);
    const atMs = parseDenialInstant(at, 'DENIAL_RESOLVE');
    if (item.status === 'resolved') {
      throw new RcmShadowError('DENIAL_RESOLVE', 'denial is already resolved');
    }
    if (!TOKEN.test(actor) || reason.length === 0) {
      throw new RcmShadowError('DENIAL_RESOLVE', 'resolution needs an actor token and a reason');
    }
    const appealOutcome = resolution === 'paid-on-appeal' || resolution === 'upheld-on-appeal';
    if (appealOutcome !== (item.status === 'appealed')) {
      throw new RcmShadowError(
        'DENIAL_RESOLVE',
        appealOutcome
          ? 'an appeal outcome needs an appealed denial'
          : 'an appealed denial resolves by its appeal outcome',
      );
    }
    // A corrected resubmission is bound by timely filing; every other action by its own limit.
    const governing =
      resolution === 'corrected-resubmitted'
        ? (item.deadlines.find((deadline) => deadline.source === 'timely-filing')?.at ??
          item.deadline)
        : item.deadlines.reduce(
            (latest, deadline) => (deadline.at > latest ? deadline.at : latest),
            item.deadline,
          );
    item.status = 'resolved';
    item.resolution = resolution;
    item.resolvedAt = at;
    item.resolvedPastDeadline = !appealOutcome && atMs > Date.parse(governing);
    item.log = [...item.log, `${at} ${resolution} by ${actor}: ${reason}`];
    return this.snapshot(item);
  }

  /**
   * One tenant's prioritised worklist. Missed deadlines first; then appeals whose follow-up is
   * due; then items inside the risk window, all by deadline; then everything else by weighted
   * dollars. The active deadline is the earliest one not yet passed, and passed ones are listed
   * as lapsed. Missed items stay listed until someone resolves them.
   */
  public worklist(
    tenantId: string,
    now: string,
    queue: DenialQueueId | null = null,
  ): readonly WorklistEntry[] {
    const nowMs = parseDenialInstant(now, 'DENIAL_NOW');
    const bandRank: Record<RiskBand, number> = {
      missed: 0,
      'appeal-follow-up': 1,
      'at-risk': 2,
      'on-track': 3,
    };
    const entries: WorklistEntry[] = [];
    for (const item of this.items.values()) {
      if (item.tenantId !== tenantId || (queue !== null && item.queue !== queue)) {
        continue;
      }
      const followUpDue =
        item.status === 'appealed' &&
        item.followUpAt !== null &&
        Date.parse(item.followUpAt) <= nowMs;
      if (item.status !== 'open' && !followUpDue) {
        continue;
      }
      const lapsed = item.deadlines.filter((deadline) => Date.parse(deadline.at) < nowMs);
      const upcoming = item.deadlines.find((deadline) => Date.parse(deadline.at) >= nowMs);
      const last = item.deadlines[item.deadlines.length - 1] ?? {
        source: item.deadlineSource,
        at: item.deadline,
      };
      const active = followUpDue
        ? { source: last.source, at: item.followUpAt ?? item.deadline }
        : (upcoming ?? last);
      const remainingMs = Date.parse(active.at) - nowMs;
      const daysToDeadline = Math.floor(remainingMs / DAY_MS);
      const band: RiskBand = followUpDue
        ? 'appeal-follow-up'
        : lapsed.length > 0
          ? 'missed'
          : daysToDeadline <= this.riskWindowDays
            ? 'at-risk'
            : 'on-track';
      entries.push({
        ...this.snapshot(item),
        activeDeadline: active.at,
        activeDeadlineSource: active.source,
        lapsed: lapsed.map((deadline) => deadline.source),
        daysToDeadline,
        band,
      });
    }
    return entries.sort((left, right) => {
      const byBand = bandRank[left.band] - bandRank[right.band];
      if (byBand !== 0) {
        return byBand;
      }
      if (left.band !== 'on-track') {
        return (
          left.activeDeadline.localeCompare(right.activeDeadline) ||
          right.weightedMinor - left.weightedMinor ||
          left.denialId.localeCompare(right.denialId)
        );
      }
      return (
        right.weightedMinor - left.weightedMinor ||
        left.activeDeadline.localeCompare(right.activeDeadline) ||
        left.denialId.localeCompare(right.denialId)
      );
    });
  }

  /** Every item one tenant ever queued, in intake order, whatever its status. */
  public all(tenantId: string): readonly DenialItem[] {
    return [...this.items.values()]
      .filter((item) => item.tenantId === tenantId)
      .map((item) => this.snapshot(item));
  }

  private require(tenantId: string, denialId: string): MutableItem {
    const item = this.items.get(itemKey(tenantId, denialId));
    if (!item) {
      throw new RcmShadowError('DENIAL_UNKNOWN', 'denial is not queued');
    }
    return item;
  }

  private snapshot(item: MutableItem): DenialItem {
    return { ...item, deadlines: [...item.deadlines], log: [...item.log] };
  }
}

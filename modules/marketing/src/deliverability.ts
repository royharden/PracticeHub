import type { CanSendInput } from '@practicehub/consent';

import {
  runJourney,
  type Campaign,
  type JourneyRun,
  type RecordedSend,
  type Template,
} from './journey.js';
import type { Wp070CrmMember } from './placeholder.js';
import type { CanSpamContext, DemographicProfile, SegmentRule } from './segments.js';
import {
  applyBounce,
  partitionAllows,
  type BounceResult,
  type HouseholdMember,
} from './suppression.js';

/**
 * Named placeholder port (WP-070 contact / WP-044 endpoint): the member's own
 * marketing address. Delivery never takes an address from the caller.
 */
export interface MemberChannelDirectory {
  addressOf(tenantId: string, memberId: string): string | undefined;
}

function normalize(address: string): string {
  return address.trim().toLowerCase();
}

/** Tenant-scoped suppression by address AND by person. */
export class SuppressionStore {
  readonly #addresses = new Set<string>();
  readonly #persons = new Set<string>();
  readonly log: string[] = [];

  public suppressAddress(tenantId: string, address: string, reason: string): void {
    this.#addresses.add(`${tenantId}|${normalize(address)}`);
    this.log.push(`${tenantId} address ${reason}`);
  }

  public suppressPerson(tenantId: string, memberId: string, reason: string): void {
    this.#persons.add(`${tenantId}|${memberId}`);
    this.log.push(`${tenantId} person ${memberId} ${reason}`);
  }

  public isAddressSuppressed(tenantId: string, address: string): boolean {
    return this.#addresses.has(`${tenantId}|${normalize(address)}`);
  }

  public isPersonSuppressed(tenantId: string, memberId: string): boolean {
    return this.#persons.has(`${tenantId}|${memberId}`);
  }
}

export interface PostureThresholds {
  /** Pause when bounces / sends exceeds this, in basis points. */
  readonly bounceRateBps: number;
  /** Pause when complaints / sends exceeds this, in basis points. */
  readonly complaintRateBps: number;
  /** Rates are evaluated only after this many sends. */
  readonly minSends: number;
}

export const defaultPostureThresholds: PostureThresholds = {
  bounceRateBps: 200,
  complaintRateBps: 10,
  minSends: 100,
};

export interface SenderPosture {
  readonly tenantId: string;
  readonly senderId: string;
  readonly sends: number;
  readonly bounces: number;
  readonly complaints: number;
  readonly state: 'active' | 'paused';
  readonly pauseReason: 'bounce-rate' | 'complaint-rate' | null;
}

/**
 * Per-tenant, per-sender deliverability posture. Exceeding a bounce or
 * complaint threshold pauses marketing sends for that sender; only an
 * attributed resume reopens it, and the counters restart.
 */
export class DeliverabilityPosture {
  readonly #senders = new Map<string, SenderPosture>();
  readonly resumes: string[] = [];

  public constructor(private readonly thresholds: PostureThresholds = defaultPostureThresholds) {
    for (const value of [
      thresholds.bounceRateBps,
      thresholds.complaintRateBps,
      thresholds.minSends,
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('posture thresholds must be non-negative whole numbers');
      }
    }
  }

  public get(tenantId: string, senderId: string): SenderPosture {
    return (
      this.#senders.get(`${tenantId}|${senderId}`) ?? {
        tenantId,
        senderId,
        sends: 0,
        bounces: 0,
        complaints: 0,
        state: 'active',
        pauseReason: null,
      }
    );
  }

  public canSend(tenantId: string, senderId: string): boolean {
    return this.get(tenantId, senderId).state === 'active';
  }

  #update(
    tenantId: string,
    senderId: string,
    change: Partial<Pick<SenderPosture, 'sends' | 'bounces' | 'complaints'>>,
  ): SenderPosture {
    const current = this.get(tenantId, senderId);
    const next = {
      ...current,
      sends: current.sends + (change.sends ?? 0),
      bounces: current.bounces + (change.bounces ?? 0),
      complaints: current.complaints + (change.complaints ?? 0),
    };
    let evaluated: SenderPosture = next;
    if (next.state === 'active' && next.sends >= this.thresholds.minSends && next.sends > 0) {
      if (next.bounces * 10000 > next.sends * this.thresholds.bounceRateBps) {
        evaluated = { ...next, state: 'paused', pauseReason: 'bounce-rate' };
      } else if (next.complaints * 10000 > next.sends * this.thresholds.complaintRateBps) {
        evaluated = { ...next, state: 'paused', pauseReason: 'complaint-rate' };
      }
    }
    this.#senders.set(`${tenantId}|${senderId}`, evaluated);
    return evaluated;
  }

  public recordSend(tenantId: string, senderId: string): SenderPosture {
    return this.#update(tenantId, senderId, { sends: 1 });
  }

  public recordBounce(tenantId: string, senderId: string): SenderPosture {
    return this.#update(tenantId, senderId, { bounces: 1 });
  }

  public recordComplaint(tenantId: string, senderId: string): SenderPosture {
    return this.#update(tenantId, senderId, { complaints: 1 });
  }

  public resume(tenantId: string, senderId: string, actor: string, reason: string): SenderPosture {
    if (!actor.trim() || !reason.trim()) {
      throw new Error('resuming a paused sender must be attributed with a reason');
    }
    const fresh: SenderPosture = {
      tenantId,
      senderId,
      sends: 0,
      bounces: 0,
      complaints: 0,
      state: 'active',
      pauseReason: null,
    };
    this.#senders.set(`${tenantId}|${senderId}`, fresh);
    this.resumes.push(`${tenantId}|${senderId} resumed by ${actor}: ${reason}`);
    return fresh;
  }
}

/** A bounce suppresses the bounced address itself and counts against the sender. */
export function applyBounceAndSuppress(input: {
  readonly tenantId: string;
  readonly senderId: string;
  readonly bouncedMemberId: string;
  readonly address: string;
  readonly household: readonly HouseholdMember[];
  readonly store: SuppressionStore;
  readonly posture: DeliverabilityPosture;
}): BounceResult {
  const result = applyBounce(input);
  input.store.suppressAddress(
    input.tenantId,
    result.suppressedAddress,
    `bounce:${input.bouncedMemberId}`,
  );
  input.posture.recordBounce(input.tenantId, input.senderId);
  return result;
}

/** A spam complaint suppresses the person (not just one address) and counts against the sender. */
export function applyComplaint(input: {
  readonly tenantId: string;
  readonly senderId: string;
  readonly memberId: string;
  readonly store: SuppressionStore;
  readonly posture: DeliverabilityPosture;
}): void {
  input.store.suppressPerson(input.tenantId, input.memberId, 'complaint');
  input.posture.recordComplaint(input.tenantId, input.senderId);
}

export interface DeliveredSend extends RecordedSend {
  readonly address: string;
  readonly senderId: string;
}

export type DeliveryBlock =
  | 'partition'
  | 'no-address'
  | 'suppressed-address'
  | 'suppressed-person'
  | 'sender-paused'
  | 'consent-channel-mismatch';

/** The channel this delivery path sends on: the ESP email rail. */
const deliveryChannel = 'email';

/**
 * Member-bound delivery: the address is the member's own (from the directory),
 * suppression is checked by address and by person, the sender's posture must be
 * active, and the address is recorded on the send.
 */
export function deliverToMember(input: {
  readonly member: Wp070CrmMember;
  readonly senderId: string;
  readonly campaign: Campaign;
  readonly template: Template;
  readonly consent: CanSendInput;
  readonly directory: MemberChannelDirectory;
  readonly store: SuppressionStore;
  readonly posture: DeliverabilityPosture;
  readonly partitionFields: readonly string[];
  /** Passed to the journey: required when the campaign names a segment (NR-156). */
  readonly segment?: { readonly rule: SegmentRule; readonly profile: DemographicProfile };
  /** Passed to the journey: CAN-SPAM rendering on the send path (NR-157). */
  readonly canSpam?: CanSpamContext;
}): {
  readonly blocked: DeliveryBlock | null;
  readonly run: JourneyRun | null;
  readonly send: DeliveredSend | null;
} {
  const { member } = input;
  const blocked = (reason: DeliveryBlock) => ({ blocked: reason, run: null, send: null });
  if (!partitionAllows(input.partitionFields)) {
    return blocked('partition');
  }
  // A send on the email rail must be authorized by the recipient's EMAIL consent, never another channel's.
  if (
    input.consent.channel !== deliveryChannel ||
    (input.consent.state !== null && input.consent.state.channel !== deliveryChannel)
  ) {
    return blocked('consent-channel-mismatch');
  }
  if (!input.posture.canSend(member.tenantId, input.senderId)) {
    return blocked('sender-paused');
  }
  const address = input.directory.addressOf(member.tenantId, member.memberId);
  if (address === undefined || address.trim() === '') {
    return blocked('no-address');
  }
  if (input.store.isPersonSuppressed(member.tenantId, member.memberId)) {
    return blocked('suppressed-person');
  }
  if (input.store.isAddressSuppressed(member.tenantId, address)) {
    return blocked('suppressed-address');
  }
  const run = runJourney({
    member,
    campaign: input.campaign,
    template: input.template,
    consent: input.consent,
    ...(input.segment === undefined ? {} : { segment: input.segment }),
    ...(input.canSpam === undefined ? {} : { canSpam: input.canSpam }),
  });
  if (run.send === null) {
    return { blocked: null, run, send: null };
  }
  input.posture.recordSend(member.tenantId, input.senderId);
  return { blocked: null, run, send: { ...run.send, address, senderId: input.senderId } };
}

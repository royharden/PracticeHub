/**
 * REQ-MIG-003 one send-capable system per number (the split-brain rule).
 *
 * The authority ledger is an append-only, per-number sequence of transition
 * records. It is folded fail-closed: any duplicate that disagrees, any gap,
 * any out-of-order effective time, any record that leaves two systems (or a
 * system other than the holder) send-capable, or any incomplete atomic
 * record leaves the number with holder `none`, so neither Podium nor Northwind may
 * send and staff use the approved alternate path.
 */

import { parseInstant } from './instant.js';
import type { SendHolder, SendSystem } from './types.js';

export type SendCapability = 'send-capable' | 'read-only';

export interface SendAuthorityEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly numberRef: string;
  /** Contiguous from 1 per number. */
  readonly seq: number;
  readonly kind: 'baseline' | 'cutover' | 'rollback' | 'freeze';
  readonly fromHolder: SendHolder;
  readonly toHolder: SendHolder;
  readonly podium: SendCapability;
  readonly northwind: SendCapability;
  readonly carrierRoutingRef: string | null;
  readonly tenDlcCampaignRef: string | null;
  readonly consentSourceRef: string | null;
  readonly inboundRouteRef: string | null;
  readonly effectiveAt: string;
  readonly synthetic: true;
}

export interface AuthorityInterval {
  readonly from: string;
  readonly holder: SendHolder;
  readonly eventId: string;
}

export interface SendAuthorityProof {
  readonly tenantId: string;
  readonly numberRef: string;
  readonly proven: boolean;
  /** Holder after the last folded event; `none` whenever `proven` is false. */
  readonly holder: SendHolder;
  readonly reasons: readonly string[];
  readonly timeline: readonly AuthorityInterval[];
  readonly lastSeq: number;
}

const eventFingerprint = (event: SendAuthorityEvent): string =>
  JSON.stringify([
    event.tenantId,
    event.numberRef,
    event.seq,
    event.kind,
    event.fromHolder,
    event.toHolder,
    event.podium,
    event.northwind,
    event.carrierRoutingRef,
    event.tenDlcCampaignRef,
    event.consentSourceRef,
    event.inboundRouteRef,
    event.effectiveAt,
  ]);

function capabilityMatchesHolder(event: SendAuthorityEvent): boolean {
  const capable = (system: SendSystem): boolean => event[system] === 'send-capable';
  if (event.toHolder === 'none') return !capable('podium') && !capable('northwind');
  const other: SendSystem = event.toHolder === 'podium' ? 'northwind' : 'podium';
  return capable(event.toHolder) && !capable(other);
}

/** Fold one number's ledger. Events for other numbers or tenants are a caller error. */
export function foldSendAuthority(
  tenantId: string,
  numberRef: string,
  events: readonly SendAuthorityEvent[],
): SendAuthorityProof {
  const reasons: string[] = [];
  const byId = new Map<string, SendAuthorityEvent>();
  for (const event of events) {
    if (event.tenantId !== tenantId || event.numberRef !== numberRef) {
      throw new Error('send-authority events crossed tenant or number scope');
    }
    const seen = byId.get(event.eventId);
    if (seen === undefined) {
      byId.set(event.eventId, event);
    } else if (eventFingerprint(seen) !== eventFingerprint(event)) {
      reasons.push(`conflicting-duplicate:${event.eventId}`);
    }
  }
  const bySeq = new Map<number, SendAuthorityEvent>();
  for (const event of byId.values()) {
    const seen = bySeq.get(event.seq);
    if (seen !== undefined) {
      reasons.push(`sequence-collision:${event.seq}`);
    } else {
      bySeq.set(event.seq, event);
    }
  }
  const ordered = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
  if (ordered.length === 0) reasons.push('no-authority-record');

  const timeline: AuthorityInterval[] = [];
  let previousHolder: SendHolder = 'none';
  let previousEffectiveMs = Number.NEGATIVE_INFINITY;
  ordered.forEach((event, index) => {
    if (!Number.isInteger(event.seq) || event.seq !== index + 1) {
      reasons.push(`sequence-gap:before-${event.seq}`);
    }
    if (index === 0 && event.kind !== 'baseline') reasons.push('first-record-not-baseline');
    if (index > 0 && event.kind === 'baseline') reasons.push(`second-baseline:${event.seq}`);
    if (event.fromHolder !== previousHolder) {
      reasons.push(`holder-discontinuity:${event.seq}`);
    }
    const effectiveMs = parseInstant(event.effectiveAt);
    if (effectiveMs === null) {
      reasons.push(`unparseable-effective-time:${event.seq}`);
    } else if (effectiveMs < previousEffectiveMs) {
      reasons.push(`out-of-order-effective-time:${event.seq}`);
    }
    if (!capabilityMatchesHolder(event)) {
      reasons.push(`send-capability-not-exclusive:${event.seq}`);
    }
    if (
      event.toHolder !== 'none' &&
      (event.carrierRoutingRef === null ||
        event.tenDlcCampaignRef === null ||
        event.consentSourceRef === null ||
        event.inboundRouteRef === null)
    ) {
      reasons.push(`incomplete-transition-record:${event.seq}`);
    }
    timeline.push({ from: event.effectiveAt, holder: event.toHolder, eventId: event.eventId });
    previousHolder = event.toHolder;
    if (effectiveMs !== null) previousEffectiveMs = effectiveMs;
  });

  const unique = [...new Set(reasons)];
  const proven = unique.length === 0;
  return {
    tenantId,
    numberRef,
    proven,
    holder: proven ? previousHolder : 'none',
    reasons: unique,
    timeline: proven ? timeline : [],
    lastSeq: ordered.at(-1)?.seq ?? 0,
  };
}

/** The holder at an instant; an unparseable instant has no holder (fail closed). */
export function holderAt(proof: SendAuthorityProof, at: string): SendHolder {
  const atMs = parseInstant(at);
  if (!proof.proven || atMs === null) return 'none';
  let holder: SendHolder = 'none';
  for (const interval of proof.timeline) {
    // A proven timeline holds only parseable instants.
    if ((parseInstant(interval.from) ?? Number.POSITIVE_INFINITY) <= atMs) holder = interval.holder;
  }
  return holder;
}

export interface OutboundDecision {
  readonly allow: boolean;
  readonly reason: string;
  /** Set when outbound is blocked for the number, per REQ-MIG-003's exception. */
  readonly alternatePath: 'approved-alternate-path' | null;
}

/** The single gate every originating system consults before an SMS leaves. */
export function authorizeOutbound(
  proof: SendAuthorityProof,
  system: SendSystem,
  at: string,
): OutboundDecision {
  if (!proof.proven) {
    return {
      allow: false,
      reason: 'exclusive-send-authority-unproven',
      alternatePath: 'approved-alternate-path',
    };
  }
  const holder = holderAt(proof, at);
  if (holder === 'none') {
    return { allow: false, reason: 'no-send-holder', alternatePath: 'approved-alternate-path' };
  }
  if (holder !== system) {
    return { allow: false, reason: `not-send-holder:${holder}`, alternatePath: null };
  }
  return { allow: true, reason: 'exclusive-send-holder', alternatePath: null };
}

export interface SendProbe {
  readonly system: SendSystem;
  readonly at: string;
}

/**
 * Duplicate-send probes: fire a send attempt from each system at each
 * instant. The proof holds when no instant allows both systems.
 */
export function runDuplicateSendProbes(
  proof: SendAuthorityProof,
  instants: readonly string[],
): { readonly holds: boolean; readonly dualAllowedAt: readonly string[] } {
  const dualAllowedAt = instants.filter(
    (at) =>
      authorizeOutbound(proof, 'podium', at).allow &&
      authorizeOutbound(proof, 'northwind', at).allow,
  );
  return { holds: dualAllowedAt.length === 0, dualAllowedAt };
}

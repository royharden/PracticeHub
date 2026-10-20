/**
 * Port waves (REQ-MIG-003/-004/-010) and the IC-1 transmission gate.
 *
 * The wave registry materializes one number-scoped `migration.podium-port`
 * sender grant request per portable number. A port order is transmitted to
 * the rail only when `consent.operational` is at least `simulated` and
 * exactly one number-scoped sender grant for this number and wave is at least
 * `simulated` (docs/architecture/capability-edge-preconditions.csv, IC-1).
 *
 * A planned date, an FOC confirmation or a verbal update never moves send
 * authority: only a `ported` receipt with a receipt reference, after opt-out
 * continuity holds, yields a cutover record.
 */

import type { LoaAssessment } from './number-inventory.js';
import type { OptOutContinuityResult } from './opt-out-continuity.js';
import type { PortingRailPort, PortOrderReceipt } from './ports.js';
import type { SendAuthorityEvent, SendAuthorityProof } from './send-authority.js';
import type { NumberServiceProfile, PortCapabilityGrant } from './types.js';

export const podiumPortCapabilityId = 'migration.podium-port';
export const operationalConsentCapabilityId = 'consent.operational';

const stateRank: Readonly<Record<PortCapabilityGrant['state'], number>> = {
  disabled: 0,
  scaffolded: 1,
  simulated: 2,
  shadow: 3,
  pilot: 4,
  active: 5,
  'read-only': -1,
  retiring: -1,
};

export interface PortWave {
  readonly tenantId: string;
  readonly waveRef: string;
  readonly numberRefs: readonly string[];
  readonly synthetic: true;
}

export interface SenderGrantRequest {
  readonly tenantId: string;
  readonly capabilityId: typeof podiumPortCapabilityId;
  readonly scope: { readonly number: string; readonly wave: string };
  readonly requestedState: 'simulated';
}

/** A number may belong to one wave only; waves are per tenant. */
export function registerPortWaves(waves: readonly PortWave[]): ReadonlyMap<string, string> {
  const waveByNumber = new Map<string, string>();
  const waveRefs = new Set<string>();
  for (const wave of waves) {
    if (wave.synthetic !== true) throw new Error(`${wave.waveRef} lacks the synthetic watermark`);
    const key = `${wave.tenantId}|${wave.waveRef}`;
    if (waveRefs.has(key)) throw new Error(`wave ${wave.waveRef} registered twice`);
    waveRefs.add(key);
    for (const numberRef of wave.numberRefs) {
      const numberKey = `${wave.tenantId}|${numberRef}`;
      const prior = waveByNumber.get(numberKey);
      if (prior !== undefined) {
        throw new Error(`number ${numberRef} is in waves ${prior} and ${wave.waveRef}`);
      }
      waveByNumber.set(numberKey, wave.waveRef);
    }
  }
  return waveByNumber;
}

export function materializeSenderGrants(
  wave: PortWave,
  loa: LoaAssessment,
): readonly SenderGrantRequest[] {
  if (loa.tenantId !== wave.tenantId) throw new Error('LOA and wave tenants differ');
  const portable = new Set(loa.portableNumberRefs);
  return [...new Set(wave.numberRefs)]
    .filter((numberRef) => portable.has(numberRef))
    .sort()
    .map((numberRef) => ({
      tenantId: wave.tenantId,
      capabilityId: podiumPortCapabilityId,
      scope: { number: numberRef, wave: wave.waveRef },
      requestedState: 'simulated',
    }));
}

export interface TransmissionDecision {
  readonly allow: boolean;
  readonly reasons: readonly string[];
}

export function evaluatePortTransmission(
  target: { readonly tenantId: string; readonly waveRef: string; readonly numberRef: string },
  grants: readonly PortCapabilityGrant[],
): TransmissionDecision {
  const reasons: string[] = [];
  const own = grants.filter((grant) => grant.tenantId === target.tenantId);
  const consent = own.filter(
    (grant) =>
      grant.capabilityId === operationalConsentCapabilityId &&
      grant.scope.number === undefined &&
      grant.scope.wave === undefined,
  );
  if (consent.length !== 1) {
    reasons.push(
      consent.length === 0 ? 'operational-consent-missing' : 'operational-consent-ambiguous',
    );
  } else if ((stateRank[consent[0]?.state ?? 'disabled'] ?? -1) < stateRank.simulated) {
    reasons.push('operational-consent-below-simulated');
  }
  const senders = own.filter(
    (grant) =>
      grant.capabilityId === podiumPortCapabilityId &&
      grant.scope.number === target.numberRef &&
      grant.scope.wave === target.waveRef,
  );
  if (senders.length === 0) {
    reasons.push('sender-grant-missing');
  } else if (senders.length > 1) {
    reasons.push('sender-grant-ambiguous');
  } else if ((stateRank[senders[0]?.state ?? 'disabled'] ?? -1) < stateRank.simulated) {
    reasons.push('sender-grant-below-simulated');
  }
  return { allow: reasons.length === 0, reasons };
}

export interface PortOrderOutcome {
  readonly numberRef: string;
  readonly transmitted: boolean;
  readonly reasons: readonly string[];
  readonly receipt: PortOrderReceipt | null;
}

/**
 * Submit a wave's port orders. Each number is gated independently; a denied
 * number never reaches the rail. Grants are read once per number, immediately
 * before transmission, so a revocation mid-wave stops the remaining numbers.
 */
export async function submitWavePortOrders(
  rail: PortingRailPort,
  wave: PortWave,
  loa: LoaAssessment,
  readGrants: () => readonly PortCapabilityGrant[],
): Promise<readonly PortOrderOutcome[]> {
  if (loa.tenantId !== wave.tenantId) throw new Error('LOA and wave tenants differ');
  const portable = new Set(loa.portableNumberRefs);
  const outcomes: PortOrderOutcome[] = [];
  for (const numberRef of [...new Set(wave.numberRefs)].sort()) {
    if (!portable.has(numberRef)) {
      outcomes.push({
        numberRef,
        transmitted: false,
        reasons: ['loa-not-portable'],
        receipt: null,
      });
      continue;
    }
    const decision = evaluatePortTransmission(
      { tenantId: wave.tenantId, waveRef: wave.waveRef, numberRef },
      readGrants(),
    );
    if (!decision.allow) {
      outcomes.push({ numberRef, transmitted: false, reasons: decision.reasons, receipt: null });
      continue;
    }
    const receipt = await rail.submitPortOrder({
      tenantId: wave.tenantId,
      numberRef,
      loaRef: loa.loaRef,
      idempotencyKey: JSON.stringify([wave.tenantId, wave.waveRef, numberRef, loa.loaRef]),
    });
    if (receipt.numberRef !== numberRef || receipt.synthetic !== true) {
      throw new Error('porting rail returned a receipt for another number or a real one');
    }
    outcomes.push({ numberRef, transmitted: true, reasons: [], receipt });
  }
  return outcomes;
}

export interface CutoverPlanInput {
  readonly current: SendAuthorityProof;
  readonly receipt: PortOrderReceipt | null;
  readonly continuity: OptOutContinuityResult;
  readonly profile: NumberServiceProfile;
  readonly consentSourceRef: string;
  readonly carrierRoutingRef: string;
  readonly eventId: string;
  readonly effectiveAt: string;
}

export type CutoverPlan =
  | { readonly commit: true; readonly event: SendAuthorityEvent }
  | { readonly commit: false; readonly reasons: readonly string[]; readonly holder: string };

export function planCutover(input: CutoverPlanInput): CutoverPlan {
  const reasons: string[] = [];
  if (!input.current.proven) reasons.push('current-authority-unproven');
  if (input.current.holder !== 'podium')
    reasons.push(`current-holder-not-podium:${input.current.holder}`);
  if (input.receipt === null) {
    reasons.push('port-receipt-missing');
  } else if (input.receipt.status !== 'ported' || input.receipt.receiptRef === null) {
    reasons.push(`port-not-completed:${input.receipt.status}`);
  } else if (input.receipt.numberRef !== input.current.numberRef) {
    reasons.push('port-receipt-for-another-number');
  }
  if (!input.continuity.shipAllowed) {
    reasons.push(...input.continuity.reasons.map((reason) => `opt-out-continuity:${reason}`));
  }
  if (input.profile.numberRef !== input.current.numberRef)
    reasons.push('profile-for-another-number');
  if (input.profile.tenDlcCampaignRef === null) reasons.push('10dlc-campaign-missing');
  if (input.profile.inboundRouteRef === null) reasons.push('inbound-route-missing');
  if (reasons.length > 0) {
    // REQ-MIG-010: the old rail stays authoritative; new outbound stays blocked.
    return { commit: false, reasons, holder: input.current.holder };
  }
  return {
    commit: true,
    event: {
      eventId: input.eventId,
      tenantId: input.current.tenantId,
      numberRef: input.current.numberRef,
      seq: input.current.lastSeq + 1,
      kind: 'cutover',
      fromHolder: 'podium',
      toHolder: 'northwind',
      podium: 'read-only',
      northwind: 'send-capable',
      carrierRoutingRef: input.carrierRoutingRef,
      tenDlcCampaignRef: input.profile.tenDlcCampaignRef,
      consentSourceRef: input.consentSourceRef,
      inboundRouteRef: input.profile.inboundRouteRef,
      effectiveAt: input.effectiveAt,
      synthetic: true,
    },
  };
}

export const recalendarAcknowledgements = [
  'staff-notice',
  'freeze-window',
  'patient-contingency',
  'vendor-billing',
  'acceptance-tests',
] as const;

export type RecalendarAcknowledgement = (typeof recalendarAcknowledgements)[number];

/** REQ-MIG-010 AC3: a new date is usable only once every dependency is acknowledged. */
export function evaluateRecalendar(acknowledged: readonly RecalendarAcknowledgement[]): {
  readonly complete: boolean;
  readonly missing: readonly RecalendarAcknowledgement[];
} {
  const have = new Set(acknowledged);
  const missing = recalendarAcknowledgements.filter((item) => !have.has(item));
  return { complete: missing.length === 0, missing };
}

export const portAcceptanceChecks = [
  'inbound-voice',
  'outbound-voice',
  'inbound-sms',
  'outbound-sms',
  'e911-address',
  'caller-id',
  'business-hours',
  'queue',
  'voicemail',
  'forwarding',
  'missed-call-text',
  'opt-out',
  'delivery-receipts',
] as const;

export type PortAcceptanceCheck = (typeof portAcceptanceChecks)[number];

/** Checks whose failure is not material on its own (the number still serves patients). */
const nonMaterialChecks: ReadonlySet<PortAcceptanceCheck> = new Set(['business-hours', 'queue']);

export interface PortAcceptanceResult {
  readonly numberRef: string;
  readonly results: Readonly<Partial<Record<PortAcceptanceCheck, 'pass' | 'fail'>>>;
}

export interface PortAcceptanceDecision {
  readonly accepted: boolean;
  readonly materialFailures: readonly PortAcceptanceCheck[];
  readonly minorFailures: readonly PortAcceptanceCheck[];
  /** Unobserved checks are failures, never passes. */
  readonly unobserved: readonly PortAcceptanceCheck[];
}

export function evaluatePortAcceptance(result: PortAcceptanceResult): PortAcceptanceDecision {
  const materialFailures: PortAcceptanceCheck[] = [];
  const minorFailures: PortAcceptanceCheck[] = [];
  const unobserved: PortAcceptanceCheck[] = [];
  for (const check of portAcceptanceChecks) {
    const outcome = result.results[check];
    if (outcome === 'pass') continue;
    if (outcome === undefined) unobserved.push(check);
    if (nonMaterialChecks.has(check)) {
      minorFailures.push(check);
    } else {
      materialFailures.push(check);
    }
  }
  return {
    accepted: materialFailures.length === 0,
    materialFailures,
    minorFailures,
    unobserved,
  };
}

export interface PortRollbackPlan {
  readonly numberRef: string;
  readonly fallbackRef: string | null;
  readonly degradedChannels: readonly string[];
  readonly patientNoticeRequired: true;
  /** Freeze record: no system may send SMS until the port-back is re-proven. */
  readonly authorityEvent: SendAuthorityEvent;
  readonly blockers: readonly string[];
}

/**
 * REQ-MIG-004 AC2 (the port-back option): a material failure freezes SMS send
 * authority to `none`, activates the documented forwarding fallback, marks
 * the affected channels degraded and requires a published patient alternative.
 */
export function planPortRollback(input: {
  readonly current: SendAuthorityProof;
  readonly acceptance: PortAcceptanceDecision;
  readonly profile: NumberServiceProfile;
  readonly eventId: string;
  readonly effectiveAt: string;
}): PortRollbackPlan | null {
  if (input.acceptance.accepted) return null;
  if (input.profile.numberRef !== input.current.numberRef) {
    throw new Error('rollback profile is for another number');
  }
  const blockers: string[] = [];
  if (input.profile.forwardingFallbackRef === null) blockers.push('rollback-fallback-missing');
  if (!input.current.proven) blockers.push('current-authority-unproven');
  const channelOf = (check: PortAcceptanceCheck): string =>
    check.includes('sms') ||
    check === 'opt-out' ||
    check === 'delivery-receipts' ||
    check === 'missed-call-text'
      ? 'sms'
      : check === 'e911-address'
        ? 'e911'
        : 'voice';
  return {
    numberRef: input.current.numberRef,
    fallbackRef: input.profile.forwardingFallbackRef,
    degradedChannels: [...new Set(input.acceptance.materialFailures.map(channelOf))].sort(),
    patientNoticeRequired: true,
    authorityEvent: {
      eventId: input.eventId,
      tenantId: input.current.tenantId,
      numberRef: input.current.numberRef,
      seq: input.current.lastSeq + 1,
      kind: 'rollback',
      fromHolder: input.current.holder,
      toHolder: 'none',
      podium: 'read-only',
      northwind: 'read-only',
      carrierRoutingRef: input.profile.forwardingFallbackRef,
      tenDlcCampaignRef: input.profile.tenDlcCampaignRef,
      consentSourceRef: null,
      inboundRouteRef: input.profile.inboundRouteRef,
      effectiveAt: input.effectiveAt,
      synthetic: true,
    },
    blockers,
  };
}

export interface NumberClosure {
  readonly numberRef: string;
  readonly ownerOfRecordEvidenceRef: string | null;
  readonly portReceiptRef: string | null;
  readonly acceptance: PortAcceptanceDecision | null;
  readonly signedOffBy: string | null;
}

/**
 * REQ-MIG-004 exception and REQ-MIG-002 AC3: Podium may not be cancelled while
 * any number lacks owner-of-record evidence, a port receipt or post-port
 * acceptance, or while the export is not proven complete. A block names an owner.
 */
export function evaluatePodiumCancellation(input: {
  readonly numbers: readonly NumberClosure[];
  readonly exportReadiness: 'ready-to-terminate' | 'blocked';
  readonly blockingOwnerRef: string | null;
}): {
  readonly cancellable: boolean;
  readonly blockers: readonly string[];
  readonly ownerRef: string | null;
} {
  const blockers: string[] = [];
  if (input.numbers.length === 0) blockers.push('no-numbers-closed');
  for (const number of input.numbers) {
    if (number.ownerOfRecordEvidenceRef === null) {
      blockers.push(`owner-of-record-missing:${number.numberRef}`);
    }
    if (number.portReceiptRef === null) blockers.push(`port-receipt-missing:${number.numberRef}`);
    if (number.acceptance === null || !number.acceptance.accepted) {
      blockers.push(`post-port-acceptance-missing:${number.numberRef}`);
    }
    if (number.signedOffBy === null) blockers.push(`wave-signoff-missing:${number.numberRef}`);
  }
  if (input.exportReadiness !== 'ready-to-terminate') blockers.push('export-completeness-unproven');
  if (blockers.length > 0 && input.blockingOwnerRef === null)
    blockers.push('blocking-owner-missing');
  return {
    cancellable: blockers.length === 0,
    blockers,
    ownerRef: blockers.length === 0 ? null : input.blockingOwnerRef,
  };
}

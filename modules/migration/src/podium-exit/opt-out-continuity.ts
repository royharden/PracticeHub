/**
 * Opt-out continuity (stop-ship; REQ-MIG-003 AC3, REQ-COMM-005/-024).
 *
 * A number may not cut over to Northwind while any contact that opted out in
 * Podium lacks a matching suppression in Northwind's consent ledger, or while the
 * consent import stops short of the moment Podium became read-only (a late
 * STOP that arrived in Podium after the history snapshot would be lost).
 *
 * Inbound events from both systems reconcile into one thread per contact and
 * number and one consent action per STOP, whichever system relayed it.
 */

import { parseInstant, requireInstant } from './instant.js';
import type { SuppressionLedgerPort } from './ports.js';

export interface PodiumOptOut {
  readonly tenantId: string;
  readonly numberRef: string;
  readonly contactRef: string;
  readonly optedOutAt: string;
  readonly sourceRecordRef: string;
}

export interface OptOutContinuityInput {
  readonly tenantId: string;
  readonly numberRef: string;
  readonly podiumOptOuts: readonly PodiumOptOut[];
  /** Latest Podium consent change covered by the import (inclusive). */
  readonly consentImportWatermark: string | null;
  /** When Podium became read-only for this number; null before cutover freeze. */
  readonly podiumReadOnlyAt: string | null;
}

export interface OptOutContinuityResult {
  readonly shipAllowed: boolean;
  readonly reasons: readonly string[];
  readonly unsuppressedContactRefs: readonly string[];
}

export function evaluateOptOutContinuity(
  ledger: SuppressionLedgerPort,
  input: OptOutContinuityInput,
): OptOutContinuityResult {
  const reasons: string[] = [];
  const freezeMs = input.podiumReadOnlyAt === null ? null : parseInstant(input.podiumReadOnlyAt);
  const watermarkMs =
    input.consentImportWatermark === null ? null : parseInstant(input.consentImportWatermark);
  if (input.podiumReadOnlyAt === null) {
    reasons.push('podium-not-frozen-read-only');
  } else if (freezeMs === null) {
    reasons.push('podium-freeze-instant-unparseable');
  }
  if (input.consentImportWatermark === null) {
    reasons.push('consent-import-missing');
  } else if (watermarkMs === null) {
    reasons.push('consent-import-watermark-unparseable');
  } else if (freezeMs !== null && watermarkMs < freezeMs) {
    reasons.push('consent-import-behind-podium-freeze');
  }
  const unsuppressed = new Set<string>();
  for (const optOut of input.podiumOptOuts) {
    if (optOut.tenantId !== input.tenantId || optOut.numberRef !== input.numberRef) {
      throw new Error('opt-out crossed tenant or number scope');
    }
    if (
      ledger.smsSuppression(input.tenantId, optOut.contactRef, input.numberRef) !== 'suppressed'
    ) {
      unsuppressed.add(optOut.contactRef);
    }
  }
  if (unsuppressed.size > 0) reasons.push('opt-out-not-carried-into-ledger');
  return {
    shipAllowed: reasons.length === 0,
    reasons,
    unsuppressedContactRefs: [...unsuppressed].sort(),
  };
}

export interface InboundEvent {
  readonly tenantId: string;
  readonly relayedBy: 'podium' | 'northwind';
  /** Carrier-assigned id; the same carrier message relayed twice shares it. */
  readonly carrierMessageId: string;
  readonly numberRef: string;
  readonly contactRef: string;
  readonly kind: 'message' | 'delivery-receipt' | 'stop' | 'start';
  readonly occurredAt: string;
}

export interface ConsentAction {
  readonly contactRef: string;
  readonly numberRef: string;
  readonly action: 'revoke-sms' | 're-opt-in-review';
  readonly carrierMessageId: string;
  readonly occurredAt: string;
}

export interface InboundReconciliation {
  readonly threadKeys: readonly string[];
  readonly acceptedEvents: readonly InboundEvent[];
  readonly consentActions: readonly ConsentAction[];
  readonly duplicatesDropped: number;
}

export function reconcileInbound(
  tenantId: string,
  events: readonly InboundEvent[],
): InboundReconciliation {
  const seen = new Map<string, InboundEvent>();
  let duplicatesDropped = 0;
  const at = new Map(
    events.map((event) => [event, requireInstant(event.occurredAt, 'occurredAt')]),
  );
  const ordered = [...events].sort(
    (left, right) =>
      (at.get(left) ?? 0) - (at.get(right) ?? 0) ||
      left.carrierMessageId.localeCompare(right.carrierMessageId) ||
      left.relayedBy.localeCompare(right.relayedBy),
  );
  for (const event of ordered) {
    if (event.tenantId !== tenantId) throw new Error('inbound event crossed tenant scope');
    const key = JSON.stringify([event.carrierMessageId, event.kind]);
    const prior = seen.get(key);
    if (prior === undefined) {
      seen.set(key, event);
      continue;
    }
    if (prior.numberRef !== event.numberRef || prior.contactRef !== event.contactRef) {
      throw new Error(`carrier message ${event.carrierMessageId} relayed with conflicting parties`);
    }
    duplicatesDropped += 1;
  }
  const acceptedEvents = [...seen.values()];
  const threadKeys = [
    ...new Set(acceptedEvents.map((event) => JSON.stringify([event.numberRef, event.contactRef]))),
  ].sort();
  const consentActions = acceptedEvents.flatMap((event): ConsentAction[] => {
    if (event.kind === 'stop') {
      return [
        {
          contactRef: event.contactRef,
          numberRef: event.numberRef,
          action: 'revoke-sms',
          carrierMessageId: event.carrierMessageId,
          occurredAt: event.occurredAt,
        },
      ];
    }
    if (event.kind === 'start') {
      // A START is a request for deliberate, logged re-enablement; never automatic.
      return [
        {
          contactRef: event.contactRef,
          numberRef: event.numberRef,
          action: 're-opt-in-review',
          carrierMessageId: event.carrierMessageId,
          occurredAt: event.occurredAt,
        },
      ];
    }
    return [];
  });
  return { threadKeys, acceptedEvents, consentActions, duplicatesDropped };
}

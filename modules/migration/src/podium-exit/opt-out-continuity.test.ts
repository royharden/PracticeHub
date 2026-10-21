import { describe, expect, it } from 'vitest';

import {
  evaluateOptOutContinuity,
  reconcileInbound,
  type InboundEvent,
  type PodiumOptOut,
} from './opt-out-continuity.js';
import { planCutover } from './port-wave.js';
import type { SuppressionLedgerPort } from './ports.js';
import { authorizeOutbound, foldSendAuthority } from './send-authority.js';
import { baseline, numberA, profile, tenant } from './synthetic.js';

const optOuts: readonly PodiumOptOut[] = ['contact-syn-001', 'contact-syn-002'].map(
  (contactRef) => ({
    tenantId: tenant,
    numberRef: numberA,
    contactRef,
    optedOutAt: '2026-01-10T10:00:00Z',
    sourceRecordRef: `podium-consent:${contactRef}`,
  }),
);

/** Placeholder ledger standing for @practicehub/consent suppression [WP-044]. */
function ledger(
  states: Readonly<Record<string, 'suppressed' | 'not-suppressed' | 'unknown'>>,
): SuppressionLedgerPort {
  return { smsSuppression: (_tenant, contactRef) => states[contactRef] ?? 'not-suppressed' };
}

const frozen = {
  tenantId: tenant,
  numberRef: numberA,
  podiumOptOuts: optOuts,
  consentImportWatermark: '2026-02-01T12:00:00Z',
  podiumReadOnlyAt: '2026-02-01T12:00:00Z',
};

describe('WP-115 opt-out continuity stop-ship (REQ-MIG-003 AC3, REQ-COMM-024)', () => {
  it('ships only when every Podium opt-out is suppressed in the Northwind ledger', () => {
    const result = evaluateOptOutContinuity(
      ledger({ 'contact-syn-001': 'suppressed', 'contact-syn-002': 'suppressed' }),
      frozen,
    );
    expect(result).toEqual({ shipAllowed: true, reasons: [], unsuppressedContactRefs: [] });
  });

  it('STOP-SHIP: one opt-out not carried into the ledger blocks the cutover itself', () => {
    const continuity = evaluateOptOutContinuity(
      ledger({ 'contact-syn-001': 'suppressed', 'contact-syn-002': 'unknown' }),
      frozen,
    );
    expect(continuity).toEqual({
      shipAllowed: false,
      reasons: ['opt-out-not-carried-into-ledger'],
      unsuppressedContactRefs: ['contact-syn-002'],
    });
    const current = foldSendAuthority(tenant, numberA, [baseline(numberA)]);
    const plan = planCutover({
      current,
      receipt: {
        numberRef: numberA,
        portOrderRef: 'port-order-a',
        status: 'ported',
        focAt: '2026-02-01T12:00:00Z',
        receiptRef: 'port-receipt-a',
        synthetic: true,
      },
      continuity,
      profile: profile(numberA),
      consentSourceRef: 'consent:northwind-ledger',
      carrierRoutingRef: 'routing:twilio-sim',
      eventId: `auth:${numberA}:2`,
      effectiveAt: '2026-02-01T12:00:00Z',
    });
    expect(plan).toEqual({
      commit: false,
      reasons: ['opt-out-continuity:opt-out-not-carried-into-ledger'],
      holder: 'podium',
    });
    expect(authorizeOutbound(current, 'northwind', '2026-02-02T00:00:00Z').allow).toBe(false);
  });

  it('STOP-SHIP: a consent import that stops before the Podium freeze would lose a late STOP', () => {
    const result = evaluateOptOutContinuity(
      ledger({ 'contact-syn-001': 'suppressed', 'contact-syn-002': 'suppressed' }),
      { ...frozen, consentImportWatermark: '2026-01-31T00:00:00Z' },
    );
    expect(result.reasons).toEqual(['consent-import-behind-podium-freeze']);
  });

  it('STOP-SHIP: continuity cannot be claimed before Podium is frozen read-only', () => {
    const result = evaluateOptOutContinuity(ledger({}), {
      ...frozen,
      podiumOptOuts: [],
      podiumReadOnlyAt: null,
    });
    expect(result).toMatchObject({ shipAllowed: false, reasons: ['podium-not-frozen-read-only'] });
  });
});

describe('WP-115 inbound reconciliation across both systems (REQ-MIG-003 AC3)', () => {
  const stop = (relayedBy: 'podium' | 'northwind', occurredAt: string): InboundEvent => ({
    tenantId: tenant,
    relayedBy,
    carrierMessageId: 'carrier-msg-900',
    numberRef: numberA,
    contactRef: 'contact-syn-003',
    kind: 'stop',
    occurredAt,
  });

  it('turns a STOP relayed by Podium and Northwind into one thread and one revocation', () => {
    const result = reconcileInbound(tenant, [
      stop('northwind', '2026-02-01T12:00:02Z'),
      stop('podium', '2026-02-01T12:00:01Z'),
      {
        ...stop('podium', '2026-02-01T11:59:00Z'),
        carrierMessageId: 'carrier-msg-899',
        kind: 'message',
      },
    ]);
    expect(result.duplicatesDropped).toBe(1);
    expect(result.threadKeys).toEqual([JSON.stringify([numberA, 'contact-syn-003'])]);
    expect(result.consentActions).toEqual([
      {
        contactRef: 'contact-syn-003',
        numberRef: numberA,
        action: 'revoke-sms',
        carrierMessageId: 'carrier-msg-900',
        occurredAt: '2026-02-01T12:00:01Z',
      },
    ]);
  });

  it('never re-opts a contact in automatically on START', () => {
    const result = reconcileInbound(tenant, [
      { ...stop('northwind', '2026-02-05T00:00:00Z'), kind: 'start' },
    ]);
    expect(result.consentActions.map((action) => action.action)).toEqual(['re-opt-in-review']);
  });

  it('rejects a carrier message relayed with conflicting parties', () => {
    expect(() =>
      reconcileInbound(tenant, [
        stop('podium', '2026-02-01T12:00:01Z'),
        { ...stop('northwind', '2026-02-01T12:00:02Z'), contactRef: 'contact-syn-004' },
      ]),
    ).toThrow('relayed with conflicting parties');
  });
});

import { describe, expect, it } from 'vitest';

import { parseInstant } from './instant.js';
import {
  evaluateOptOutContinuity,
  reconcileInbound,
  type InboundEvent,
} from './opt-out-continuity.js';
import type { SuppressionLedgerPort } from './ports.js';
import { authorizeOutbound, foldSendAuthority, holderAt } from './send-authority.js';
import { baseline, cutover, numberA, tenant } from './synthetic.js';

const suppressedAll: SuppressionLedgerPort = { smsSuppression: () => 'suppressed' };

const gate = (consentImportWatermark: string | null, podiumReadOnlyAt: string | null) =>
  evaluateOptOutContinuity(suppressedAll, {
    tenantId: tenant,
    numberRef: numberA,
    podiumOptOuts: [],
    consentImportWatermark,
    podiumReadOnlyAt,
  });

describe('WP-115 rework 1: the stop-ship gate compares instants, not strings (review F1)', () => {
  it('P1 precision: an import ending 0.5 s before the freeze is blocked', () => {
    expect(gate('2026-06-01T10:00:00Z', '2026-06-01T10:00:00.500Z')).toMatchObject({
      shipAllowed: false,
      reasons: ['consent-import-behind-podium-freeze'],
    });
  });

  it('P2 offset: an import ending an hour before the freeze is blocked', () => {
    expect(gate('2026-06-01T10:00:00+02:00', '2026-06-01T09:00:00Z')).toMatchObject({
      shipAllowed: false,
      reasons: ['consent-import-behind-podium-freeze'],
    });
  });

  it('control: an import that covers the freeze ships even when the strings sort the other way', () => {
    expect(gate('2026-06-01T08:30:00Z', '2026-06-01T10:00:00+02:00')).toEqual({
      shipAllowed: true,
      reasons: [],
      unsuppressedContactRefs: [],
    });
  });

  it('fails closed on an unparseable watermark or freeze instant', () => {
    expect(gate('yesterday', '2026-06-01T09:00:00Z').reasons).toEqual([
      'consent-import-watermark-unparseable',
    ]);
    expect(gate('2026-06-01T09:00:00Z', '2026-06-01 09:00').reasons).toEqual([
      'podium-freeze-instant-unparseable',
    ]);
  });
});

describe('WP-115 rework 1: send authority orders instants numerically (review F2)', () => {
  it('picks the right holder at an instant when the cutover carries an offset', () => {
    const proof = foldSendAuthority(tenant, numberA, [
      baseline(numberA),
      { ...cutover(numberA), effectiveAt: '2026-02-01T13:00:00+01:00' },
    ]);
    expect(proof.proven).toBe(true);
    expect(holderAt(proof, '2026-02-01T11:59:59Z')).toBe('podium');
    expect(holderAt(proof, '2026-02-01T12:30:00Z')).toBe('northwind');
    expect(authorizeOutbound(proof, 'podium', '2026-02-01T12:30:00Z').allow).toBe(false);
  });

  it('accepts an in-order cutover whose string sorts earlier, and refuses a truly earlier one', () => {
    const inOrder = foldSendAuthority(tenant, numberA, [
      baseline(numberA),
      { ...cutover(numberA), effectiveAt: '2025-12-31T23:30:00-01:00' },
    ]);
    expect(inOrder.proven).toBe(true);
    const earlier = foldSendAuthority(tenant, numberA, [
      baseline(numberA),
      { ...cutover(numberA), effectiveAt: '2026-01-01T00:30:00+01:00' },
    ]);
    expect(earlier.reasons).toEqual(['out-of-order-effective-time:2']);
  });

  it('fails closed on an unparseable effective time or probe instant', () => {
    const bad = foldSendAuthority(tenant, numberA, [
      baseline(numberA),
      { ...cutover(numberA), effectiveAt: 'soon' },
    ]);
    expect(bad.reasons).toEqual(['unparseable-effective-time:2']);
    const good = foldSendAuthority(tenant, numberA, [baseline(numberA), cutover(numberA)]);
    expect(holderAt(good, 'not-a-time')).toBe('none');
    expect(authorizeOutbound(good, 'northwind', 'not-a-time')).toMatchObject({
      allow: false,
      alternatePath: 'approved-alternate-path',
    });
  });

  it('orders inbound relays by instant, so the earliest STOP is the one recorded', () => {
    const stop = (relayedBy: 'podium' | 'northwind', occurredAt: string): InboundEvent => ({
      tenantId: tenant,
      relayedBy,
      carrierMessageId: 'carrier-msg-777',
      numberRef: numberA,
      contactRef: 'contact-syn-010',
      kind: 'stop',
      occurredAt,
    });
    const result = reconcileInbound(tenant, [
      stop('northwind', '2026-06-01T09:00:05Z'),
      stop('podium', '2026-06-01T10:00:01+01:00'),
    ]);
    expect(result.consentActions[0]?.occurredAt).toBe('2026-06-01T10:00:01+01:00');
    expect(() => reconcileInbound(tenant, [stop('northwind', 'bad')])).toThrow(
      'not an ISO 8601 instant',
    );
  });

  it('parses only full ISO 8601 instants with a zone', () => {
    expect(parseInstant('2026-06-01T10:00:00.500Z')).toBe(Date.parse('2026-06-01T10:00:00.500Z'));
    expect(parseInstant('2026-06-01T10:00:00+02:00')).toBe(Date.parse('2026-06-01T08:00:00Z'));
    for (const bad of ['2026-06-01', '2026-06-01T10:00:00', '2026-13-01T10:00:00Z', '']) {
      expect(parseInstant(bad), bad).toBeNull();
    }
  });
});
